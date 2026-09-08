import type { ProgramRecorderOptions, ProgramRecordResult } from './recording-types';
import { buildBaseName } from './recording-paths';
import fs from 'node:fs/promises';
import { recordTimeshiftProgram } from './timeshift-program-recorder';
import path from 'node:path';
import { NicoClient } from '../../vendor/nico-client/NicoClient';
import type { NicoLiveProgramInfo } from '../../vendor/nico-client/types';
import { prefixLogger, silentLogger } from '../logger';
import { recordComments } from './comment-recorder';
import { recordVideo } from './video-recorder';

export type { ProgramRecorderOptions, ProgramRecordResult } from './recording-types';
export { buildBaseName, sanitizeFileName } from './recording-paths';

/**
 * 既存のファイルを上書きしないよう、指定の連番から空いている番号を探す
 * (クラッシュ後に同じ放送を録り直す場合など)
 */
export async function resolveAvailableAttempt(
  outputDir: string,
  info: NicoLiveProgramInfo,
  attempt: number,
  maxAttempt = 100,
): Promise<number> {
  for (let candidate = attempt; candidate < attempt + maxAttempt; candidate += 1) {
    const videoPath = path.join(outputDir, `${buildBaseName(info, candidate)}.ts`);
    try {
      await fs.access(videoPath);
    } catch {
      return candidate;
    }
  }
  throw new Error(`空いている連番が見つかりません: ${outputDir}`);
}

/**
 * 1 番組の映像とコメントを並行して録画し、メタデータ JSON も書き出す。
 * どちらかが失敗しても、もう一方は続行する。
 */
export async function recordProgram(
  options: ProgramRecorderOptions,
  signal?: AbortSignal,
): Promise<ProgramRecordResult> {
  const logger = options.logger ?? silentLogger;
  const client = new NicoClient(options.programId, {
    cookies: options.cookies,
    userAgent: options.userAgent,
  });
  const info = options.programInfo ?? (await client.getProgramInfo(signal));

  if (options.mode === 'timeshift') return recordTimeshiftProgram(options, info, signal);

  await fs.mkdir(options.outputDir, { recursive: true });
  const attempt = await resolveAvailableAttempt(options.outputDir, info, options.attempt ?? 1);
  const baseName = buildBaseName(info, attempt);
  const videoPath = path.join(options.outputDir, `${baseName}.ts`);
  const commentsPath =
    options.commentsPath ?? path.join(options.outputDir, `${baseName}.comments.csv`);
  const metadataPath = path.join(options.outputDir, `${baseName}.json`);
  options.onPaths?.({ attempt, videoPath, commentsPath });

  const result: ProgramRecordResult = {
    programId: options.programId,
    programInfo: info,
    attempt,
    baseName,
    videoPath,
    commentsPath,
    metadataPath,
    errors: [],
  };

  const writeMetadata = async (): Promise<void> => {
    const metadata = {
      programId: options.programId,
      recordedAt: new Date().toISOString(),
      program: info,
      video: result.video && {
        reason: result.video.reason,
        startedAt: result.video.startedAt.toISOString(),
        endedAt: result.video.endedAt.toISOString(),
        segments: result.video.video.segments,
        bytes: result.video.video.bytes + (result.video.audio?.bytes ?? 0),
      },
      comments: result.comments && {
        count: result.comments.count,
        startedAt: result.comments.startedAt.toISOString(),
        endedAt: result.comments.endedAt.toISOString(),
      },
      errors: result.errors,
    };
    try {
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    } catch (error) {
      // メタデータは補助情報なので、書けなくても録画そのものを失敗にしない
      logger.warn(`メタデータを書き込めませんでした: ${metadataPath}`, error);
    }
  };
  await writeMetadata();

  // 映像が異常終了したらコメント取得も止めて、呼び出し側が再開を判断できるようにする。
  // 番組終了による正常終了ではコメントはそのまま終わりまで受信する
  const internal = new AbortController();
  const onOuterAbort = (): void => internal.abort();
  if (signal?.aborted) {
    internal.abort();
  }
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  const videoTask = recordVideo(
    {
      programId: options.programId,
      outputPath: videoPath,
      cookies: options.cookies,
      userAgent: options.userAgent,
      ffmpegPath: options.ffmpegPath,
      logger: prefixLogger(logger, 'video'),
      programInfo: info,
    },
    internal.signal,
  ).then(
    (video) => {
      result.video = video;
      if (video.reason === 'idle' || video.reason === 'disconnected') {
        internal.abort();
      }
    },
    (error: unknown) => {
      logger.error('video recording failed', error);
      result.errors.push({ target: 'video', message: (error as Error).message });
      internal.abort();
    },
  );

  const commentsTask = recordComments(
    {
      programId: options.programId,
      outputPath: commentsPath,
      cookies: options.cookies,
      userAgent: options.userAgent,
      logger: prefixLogger(logger, 'comments'),
      programInfo: info,
      onComment: options.onComment,
      prefetchBackward: options.prefetchBackwardComments ?? true,
    },
    internal.signal,
  ).then(
    (comments) => {
      result.comments = comments;
    },
    (error: unknown) => {
      logger.error('comment recording failed', error);
      result.errors.push({ target: 'comments', message: (error as Error).message });
    },
  );

  try {
    await Promise.all([videoTask, commentsTask]);
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
  }
  await writeMetadata();
  return result;
}
