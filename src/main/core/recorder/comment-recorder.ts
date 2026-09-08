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

// 閲覧時によく使う投稿時刻・番号・本文を先頭にし、列順を固定する
const COMMENT_COLUMNS = [
  'at',
  'no',
  'content',
  'vpos',
  'rawUserId',
  'hashedUserId',
  'accountStatus',
  'position',
  'size',
  'color',
  'font',
  'opacity',
  'id',
  'liveId',
] as const satisfies readonly (keyof NicoComment)[];
export const CSV_HEADER = '\uFEFF' + COMMENT_COLUMNS.join(',') + '\n';

/** CSV の各列に保存する値 (投稿時刻は日本時間、RGB 色は #RRGGBB にする) */
export interface CommentRecord extends Omit<NicoComment, 'at' | 'color'> {
  at: string;
  color: string;
}

export function toCommentRecord(comment: NicoComment): CommentRecord {
  const at = new Date(comment.at.getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .replace(/Z$/, '+09:00');
  const color =
    typeof comment.color === 'string'
      ? comment.color
      : '#' +
        [comment.color.r, comment.color.g, comment.color.b]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase();
  return { ...comment, at, color };
}

export function toCommentCsv(comment: NicoComment): string {
  const record = toCommentRecord(comment);
  // 本文の改行・タブや数式に見える文字も保持し、CSV の引用符だけをエスケープする
  return (
    COMMENT_COLUMNS.map((column) => `"${String(record[column]).replaceAll('"', '""')}"`).join(',') +
    '\n'
  );
}

/** 全文を読み込まず、先頭だけで空ファイルか同じ列の CSV かを確かめる */
async function needsCsvHeader(outputPath: string): Promise<boolean> {
  let existing: fs.promises.FileHandle;
  try {
    existing = await fs.promises.open(outputPath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  try {
    const header = Buffer.alloc(Buffer.byteLength(CSV_HEADER));
    const { bytesRead } = await existing.read(header, 0, header.length, 0);
    if (bytesRead === 0) return true;
    if (bytesRead !== header.length || header.toString('utf8') !== CSV_HEADER) {
      throw new Error(`コメント CSV のヘッダーが一致しないため追記できません: ${outputPath}`);
    }
    return false;
  } finally {
    await existing.close();
  }
}

/**
 * NDGR からコメントを受信し、BOM・ヘッダー付き UTF-8 の CSV で追記保存する。
 * 番組終了 (NicoClient が検知) か abort で終了する。
 */
export async function recordComments(
  options: CommentRecorderOptions,
  signal?: AbortSignal,
): Promise<CommentRecordResult> {
  const logger = options.logger ?? silentLogger;
  const startedAt = new Date();
  const writeHeader = await needsCsvHeader(options.outputPath);

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
    // コメントが 0 件でもヘッダーを残し、再開時は既存のヘッダーと BOM を重複させない
    if (writeHeader && !file.write(CSV_HEADER)) {
      await once(file, 'drain', { signal: receiveSignal });
    }
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
          const line = toCommentCsv(comment);
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
