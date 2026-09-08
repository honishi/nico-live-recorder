import fs from 'node:fs/promises';
import type { TimeshiftVideoReport } from './timeshift-video-recorder';
import type { TimeshiftCommentResult } from './timeshift-comment-recorder';
import { recordTimeshiftProgram } from './timeshift-program-recorder';
import type { RecordingMode, RecordingCompletion, TimeshiftProgress } from '../../../shared/types';
import path from 'node:path';
import { NicoClient } from '../../vendor/nico-client/NicoClient';
import type { NicoLiveProgramInfo, NicoComment } from '../../vendor/nico-client/types';
import { prefixLogger, silentLogger, type Logger } from '../logger';
import { recordComments, type CommentRecordResult } from './comment-recorder';
import { recordVideo, type VideoRecordResult } from './video-recorder';

export interface ProgramRecorderOptions {
  mode?: RecordingMode;
  onTimeshiftProgress?: (progress: TimeshiftProgress) => void;
  programId: string;
  /** 録画ファイルを置くディレクトリ (存在しなければ作成する) */
  outputDir: string;
  cookies?: Record<string, string>;
  userAgent?: string;
  ffmpegPath?: string;
  logger?: Logger;
  programInfo?: NicoLiveProgramInfo;
  onComment?: (comment: NicoComment, count: number) => void;
  /** 何回目の録画か。2 以上はファイル名に連番を付ける。同名ファイルがあれば次の空き番号に進める */
  attempt?: number;
  /** 接続前の過去コメントも取得するか (再開時は false) */
  prefetchBackwardComments?: boolean;
  /** コメントの出力先を固定する (再開時に最初のパートのファイルへ追記するため) */
  commentsPath?: string;
  /** 出力先が決まった時点で呼ばれる (録画中のサイズ表示などに使う) */
  onPaths?: (paths: { attempt: number; videoPath: string; commentsPath: string }) => void;
}

export interface ProgramRecordResult {
  timeshift?: {
    completion: RecordingCompletion;
    progress: TimeshiftProgress;
    commentReason?: string;
    video?: TimeshiftVideoReport;
    comments?: Pick<
      TimeshiftCommentResult,
      | 'status'
      | 'reason'
      | 'count'
      | 'sorted'
      | 'duplicates'
      | 'invalidCount'
      | 'viewRequests'
      | 'startedAt'
      | 'endedAt'
    >;
  };
  programId: string;
  programInfo: NicoLiveProgramInfo;
  /** 実際に使った連番 (既存ファイルを避けて進むことがある) */
  attempt: number;
  baseName: string;
  videoPath: string;
  commentsPath: string;
  metadataPath: string;
  video?: VideoRecordResult;
  comments?: CommentRecordResult;
  /** 映像・コメントのどちらかが失敗した場合のエラー */
  errors: { target: 'video' | 'comments'; message: string }[];
}

/** ファイル名に使えない文字を置き換える (Windows / macOS 共通で安全な集合にする) */
export function sanitizeFileName(name: string, maxLength = 60): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const sliced = Array.from(cleaned).slice(0, maxLength).join('');
  return sliced.length > 0 ? sliced : 'untitled';
}

function formatTimestamp(date: Date): string {
  // 端末のタイムゾーンに依存せず、日本時間の日時を組み立てる
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${jst.getUTCFullYear()}${pad(jst.getUTCMonth() + 1)}${pad(jst.getUTCDate())}` +
    `_${pad(jst.getUTCHours())}${pad(jst.getUTCMinutes())}${pad(jst.getUTCSeconds())}`
  );
}

export function buildBaseName(info: NicoLiveProgramInfo, attempt = 1): string {
  const begin = info.beginTime > 0 ? new Date(info.beginTime * 1000) : new Date();
  // タイトルの長さや変更に左右されないよう、配信者 ID と番組 ID で識別する
  const providerId = sanitizeFileName(info.providerId?.trim() || 'unknown');
  const suffix = attempt > 1 ? `_${attempt}` : '';
  return `${formatTimestamp(begin)}_${providerId}_${info.nicoliveProgramId}${suffix}`;
}

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
