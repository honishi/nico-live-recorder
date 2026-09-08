import fs from 'node:fs/promises';
import path from 'node:path';
import type { NicoLiveProgramInfo } from '../../vendor/nico-client/types';
import { NicoLiveProgramStatus } from '../../vendor/nico-client/types';
import { openTimeshiftSession } from '../nico/timeshift-session';
import { TimeshiftError, timeshiftErrorText } from '../nico/timeshift-common';
import { recordTimeshiftVideo } from './timeshift-video-recorder';
import { recordTimeshiftComments } from './timeshift-comment-recorder';
import {
  buildBaseName,
  type ProgramRecorderOptions,
  type ProgramRecordResult,
} from './program-recorder';
import type { TimeshiftProgress } from '../../../shared/types';

/** 3種類すべてを排他的に確保し、CSV だけ残った録画も上書きしない。 */
export async function reserveTimeshiftPaths(
  outputDir: string,
  info: NicoLiveProgramInfo,
  first = 1,
) {
  await fs.mkdir(outputDir, { recursive: true });
  for (let attempt = first; attempt < first + 100; attempt += 1) {
    const baseName = buildBaseName(info, attempt);
    const videoPath = path.join(outputDir, `${baseName}.ts`);
    const commentsPath = path.join(outputDir, `${baseName}.comments.csv`);
    const metadataPath = path.join(outputDir, `${baseName}.json`);
    const owned: string[] = [];
    try {
      const stale = await fs.stat(`${commentsPath}.sorting`).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (stale) continue;
      for (const name of [videoPath, commentsPath, metadataPath]) {
        const file = await fs.open(name, 'wx', 0o600);
        owned.push(name);
        await file.close();
      }
      return { attempt, baseName, videoPath, commentsPath, metadataPath };
    } catch (error) {
      for (const name of owned) await fs.unlink(name);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new TimeshiftError('OUTPUT_NAMES_EXHAUSTED');
}

/** 1つの視聴接続から映像とコメントを取得する。ライブの再接続・再開ループは使わない。 */
export async function recordTimeshiftProgram(
  options: ProgramRecorderOptions,
  info: NicoLiveProgramInfo,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProgramRecordResult> {
  if (info.status !== NicoLiveProgramStatus.ended || !info.webSocketUrl)
    throw new TimeshiftError('PROGRAM_NOT_VIEWABLE');
  signal.throwIfAborted();
  const startedAt = new Date().toISOString();
  const paths = await reserveTimeshiftPaths(options.outputDir, info, options.attempt);
  const progress: TimeshiftProgress = {
    phase: 'connecting',
    savedSegments: 0,
    totalSegments: 0,
    comments: 'pending',
  };
  const update = (value: Partial<TimeshiftProgress>): void => {
    Object.assign(progress, value);
    options.onTimeshiftProgress?.({ ...progress });
  };
  const result: ProgramRecordResult = {
    ...paths,
    programId: options.programId,
    programInfo: info,
    errors: [],
    timeshift: { completion: 'partial', progress },
  };
  options.onPaths?.(paths);
  update({});
  // 公開情報だけを列挙する。視聴 URL・Cookie・レスポンス本文はメタデータへ残さない。
  const metadata = async (): Promise<void> => {
    try {
      await fs.writeFile(
        paths.metadataPath,
        JSON.stringify(
          {
            mode: 'timeshift',
            programId: options.programId,
            program: {
              title: info.title,
              providerId: info.providerId,
              providerName: info.providerName,
              beginTime: info.beginTime,
              endTime: info.endTime,
            },
            recordedAt: startedAt,
            updatedAt: new Date().toISOString(),
            timeshift: result.timeshift,
            video: result.video && {
              reason: result.video.reason,
              segments: result.video.video.segments,
              audioSegments: result.video.audio?.segments,
            },
            comments: result.comments && { count: result.comments.count },
            errors: result.errors,
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      options.logger?.warn('タイムシフトのメタデータを保存できませんでした');
    }
  };
  await metadata();
  const failedVideo = new AbortController();
  let session: ReturnType<typeof openTimeshiftSession> | undefined;
  try {
    session = openTimeshiftSession(info.webSocketUrl, options.cookies, signal);
    const connection = session;
    const work = AbortSignal.any([connection.signal, failedVideo.signal]);
    // HLS が届き次第取得を開始する。コメントの接続待ちで映像を遅らせない。
    const video = (async () => {
      try {
        result.video = await recordTimeshiftVideo(
          await connection.stream,
          {
            outputPath: paths.videoPath,
            ffmpegPath: options.ffmpegPath,
            logger: options.logger,
            onProgress: update,
            onReport: (report) => {
              result.timeshift!.video = report;
            },
          },
          work,
        );
        if (progress.comments === 'pending') update({ phase: 'comments' });
      } catch (error) {
        if (!signal.aborted)
          result.errors.push({ target: 'video', message: timeshiftErrorText(error) });
        failedVideo.abort(error);
        connection.close();
      }
    })();
    const comments = (async () => {
      try {
        const captured = await recordTimeshiftComments(
          await connection.comments,
          paths.commentsPath,
          AbortSignal.any([work, AbortSignal.timeout(30 * 60_000)]),
          options.onComment,
        );
        result.comments = captured;
        result.timeshift!.commentReason = captured.reason;
        result.timeshift!.comments = {
          status: captured.status,
          reason: captured.reason,
          count: captured.count,
          sorted: captured.sorted,
          duplicates: captured.duplicates,
          invalidCount: captured.invalidCount,
          viewRequests: captured.viewRequests,
          startedAt: captured.startedAt,
          endedAt: captured.endedAt,
        };
        update({ comments: captured.status });
        if (captured.status !== 'complete' && !signal.aborted)
          result.errors.push({ target: 'comments', message: `タイムシフト: ${captured.reason}` });
      } catch (error) {
        update({ comments: 'partial' });
        if (!signal.aborted)
          result.errors.push({ target: 'comments', message: timeshiftErrorText(error) });
      }
    })();
    await Promise.all([video, comments]);
    // 映像が先に終わった後、コメント取得中に出力が消されたケースも検出する。
    const videoPresent = await fs.stat(paths.videoPath).then(
      (stat) => stat.size > 0,
      () => false,
    );
    const commentsPresent = await fs.stat(paths.commentsPath).then(
      (stat) => stat.size > 0,
      () => false,
    );
    if (result.video && !videoPresent && !signal.aborted) {
      result.video = undefined;
      result.errors.push({ target: 'video', message: 'タイムシフト: OUTPUT_MISSING' });
    }
    if (!commentsPresent) {
      update({ comments: 'partial' });
      if (!signal.aborted)
        result.errors.push({ target: 'comments', message: 'タイムシフト: OUTPUT_MISSING' });
    }
    if (signal.aborted) result.timeshift!.completion = 'cancelled';
    else if (result.video && progress.comments === 'complete' && !result.errors.length)
      result.timeshift!.completion = 'complete';
    else result.timeshift!.completion = 'partial';
  } catch (error) {
    result.timeshift!.completion = signal.aborted ? 'cancelled' : 'partial';
    update({ comments: 'partial' });
    if (!signal.aborted)
      result.errors.push({ target: 'video', message: timeshiftErrorText(error) });
  } finally {
    session?.close();
  }
  // 今回だけの予約ファイルが空のままなら除去する。部分データと診断JSONは残す。
  for (const file of [paths.videoPath, paths.commentsPath]) {
    try {
      if ((await fs.stat(file)).size === 0) await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        options.logger?.warn('タイムシフトの空ファイルを整理できませんでした');
    }
  }
  await metadata();
  return result;
}
