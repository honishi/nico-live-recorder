import fs from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { abortableDelay } from '../../vendor/nico-client/abortableDelay';
import { HttpError } from '../../vendor/nico-client/internal/httpClient';
import { isRetryableNicoError } from '../../vendor/nico-client/retryPolicy';
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
    // 再接続時に過去分を取り直しても、同じコメントはこの録画内で二重に保存しない
    const seen = new Set<string>();
    let programInfo = options.programInfo;
    let failures = 0;
    while (!receiveSignal.aborted) {
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
      try {
        const stream = client.streamComments(
          {
            signal: receiveSignal,
            startPosition: 'now',
            prefetchBackward: options.prefetchBackward ?? true,
          },
          programInfo,
        );
        for await (const comment of stream) {
          const key = comment.id || `${comment.liveId}:${comment.no}`;
          if (seen.has(key)) {
            continue;
          }
          const line = JSON.stringify(toCommentRecord(comment)) + '\n';
          if (!file.write(line)) {
            await once(file, 'drain', { signal: receiveSignal });
          }
          seen.add(key);
          failures = 0;
          count += 1;
          options.onComment?.(comment, count);
        }
        // 正常に抜けた場合は番組終了または停止。再接続はしない
        break;
      } catch (error) {
        if (fileError) {
          throw fileError;
        }
        if (receiveSignal.aborted) {
          break;
        }
        // View/Segment URI の失効も、番組情報と viewUri を取得し直して回復を試みる
        const expired = error instanceof HttpError && [403, 404].includes(error.statusCode);
        if ((!isRetryableNicoError(error) && !expired) || failures >= 5) {
          throw error;
        }
        failures += 1;
        const delayMs = Math.min(30_000, 1000 * 2 ** (failures - 1));
        logger.debug(`comments: reconnecting in ${delayMs}ms (attempt ${failures}/5)`, error);
        programInfo = undefined;
        await abortableDelay(delayMs, receiveSignal);
      }
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
