import fs from 'node:fs/promises';
import path from 'node:path';
import { NicoClient } from '../../vendor/nico-client/NicoClient';
import type { NicoLiveProgramInfo, NicoComment } from '../../vendor/nico-client/types';
import { prefixLogger, silentLogger, type Logger } from '../logger';
import { recordComments, type CommentRecordResult } from './comment-recorder';
import { recordVideo, type VideoRecordResult } from './video-recorder';

export interface ProgramRecorderOptions {
  programId: string;
  /** 録画ファイルを置くディレクトリ (存在しなければ作成する) */
  outputDir: string;
  cookies?: Record<string, string>;
  userAgent?: string;
  ffmpegPath?: string;
  logger?: Logger;
  programInfo?: NicoLiveProgramInfo;
  onComment?: (comment: NicoComment, count: number) => void;
}

export interface ProgramRecordResult {
  programId: string;
  programInfo: NicoLiveProgramInfo;
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
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function buildBaseName(info: NicoLiveProgramInfo): string {
  const begin = info.beginTime > 0 ? new Date(info.beginTime * 1000) : new Date();
  return `${formatTimestamp(begin)}_${info.nicoliveProgramId}_${sanitizeFileName(info.title)}`;
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

  await fs.mkdir(options.outputDir, { recursive: true });
  const baseName = buildBaseName(info);
  const videoPath = path.join(options.outputDir, `${baseName}.ts`);
  const commentsPath = path.join(options.outputDir, `${baseName}.comments.jsonl`);
  const metadataPath = path.join(options.outputDir, `${baseName}.json`);

  const result: ProgramRecordResult = {
    programId: options.programId,
    programInfo: info,
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
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  };
  await writeMetadata();

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
    signal,
  ).then(
    (video) => {
      result.video = video;
    },
    (error: unknown) => {
      logger.error('video recording failed', error);
      result.errors.push({ target: 'video', message: (error as Error).message });
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
    },
    signal,
  ).then(
    (comments) => {
      result.comments = comments;
    },
    (error: unknown) => {
      logger.error('comment recording failed', error);
      result.errors.push({ target: 'comments', message: (error as Error).message });
    },
  );

  await Promise.all([videoTask, commentsTask]);
  await writeMetadata();
  return result;
}
