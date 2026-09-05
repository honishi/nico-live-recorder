import fs from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { NicoClient } from '../../vendor/nico-client/NicoClient';
import type { NicoComment, NicoLiveProgramInfo } from '../../vendor/nico-client/types';
import { silentLogger, type Logger } from '../logger';

export interface CommentRecorderOptions {
  programId: string;
  outputPath: string;
  cookies?: Record<string, string>;
  userAgent?: string;
  logger?: Logger;
  programInfo?: NicoLiveProgramInfo;
  /** 1 件受信するごとに呼ばれる (UI のカウンタ更新など) */
  onComment?: (comment: NicoComment, count: number) => void;
  /** 接続前の過去コメントも取得するか (再開時は重複を避けるため false にする) */
  prefetchBackward?: boolean;
}

export interface CommentRecordResult {
  outputPath: string;
  count: number;
  startedAt: Date;
  endedAt: Date;
  aborted: boolean;
}

/** JSON Lines の 1 行として書き出す形式 (Date は ISO 文字列にする) */
export interface CommentRecord extends Omit<NicoComment, 'at'> {
  at: string;
}

export function toCommentRecord(comment: NicoComment): CommentRecord {
  return { ...comment, at: comment.at.toISOString() };
}

/**
 * NDGR からコメントを受信し、JSON Lines で追記保存する。
 * 番組終了 (NicoClient が検知) か abort で終了する。
 */
export async function recordComments(
  options: CommentRecorderOptions,
  signal?: AbortSignal,
): Promise<CommentRecordResult> {
  const logger = options.logger ?? silentLogger;
  const startedAt = new Date();
  const client = new NicoClient(options.programId, {
    cookies: options.cookies,
    userAgent: options.userAgent,
    logger: {
      // セグメントや chunk ごとの verbose は録画中に 1 時間で数千行になるので落とす (debug に流さない)
      verbose: () => {},
      debug: (...args) => logger.debug(...args),
      info: (...args) => logger.info(...args),
      warn: (...args) => logger.warn(...args),
      error: (...args) => logger.error(...args),
    },
  });

  // ファイルの失敗は受信待ちの間にも起きるので、生成直後から監視し、コメント取得も止める
  const outputFailure = new AbortController();
  const receiveSignal = signal
    ? AbortSignal.any([signal, outputFailure.signal])
    : outputFailure.signal;
  const file = fs.createWriteStream(options.outputPath, { flags: 'a', encoding: 'utf8' });
  let fileError: Error | undefined;
  const fileFinished = finished(file).catch((error: unknown) => {
    fileError = error as Error;
    outputFailure.abort();
  });
  let count = 0;
  try {
    const stream = client.streamComments(
      {
        signal: receiveSignal,
        startPosition: 'now',
        prefetchBackward: options.prefetchBackward ?? true,
      },
      options.programInfo,
    );
    for await (const comment of stream) {
      const line = JSON.stringify(toCommentRecord(comment)) + '\n';
      if (!file.write(line)) {
        await once(file, 'drain');
      }
      count += 1;
      options.onComment?.(comment, count);
    }
  } catch (error) {
    // 受信側が AbortError を返しても、原因となった保存エラーを呼び出し側に伝える
    throw fileError ?? error;
  } finally {
    file.end();
    await fileFinished;
  }
  if (fileError) {
    throw fileError;
  }
  logger.info(`comments: finished count=${count} aborted=${signal?.aborted === true}`);
  return {
    outputPath: options.outputPath,
    count,
    startedAt,
    endedAt: new Date(),
    aborted: signal?.aborted === true,
  };
}
