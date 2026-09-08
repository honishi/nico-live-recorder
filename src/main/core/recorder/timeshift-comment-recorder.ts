import fs from 'node:fs/promises';
import type { Type } from 'protobufjs';
import { getProtoRegistry } from '../../vendor/nico-client/internal/protoLoader';
import { ProtobufStreamReader } from '../../vendor/nico-client/internal/protobufStreamReader';
import type { NicoComment, CommentColorName } from '../../vendor/nico-client/types';
import { checkedFetch, object, TimeshiftError } from '../nico/timeshift-common';
import { CSV_HEADER, toCommentCsv } from './comment-csv';
import type { TimeshiftCommentResult } from './recording-types';

export type { TimeshiftCommentResult } from './recording-types';

const COLORS: CommentColorName[] = [
  'white',
  'red',
  'pink',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'black',
  'white2',
  'red2',
  'pink2',
  'orange2',
  'yellow2',
  'green2',
  'cyan2',
  'blue2',
  'purple2',
  'black2',
];
export const TIMESHIFT_COMMENT_LIMITS = {
  count: 200_000,
  bytes: 128 * 1024 * 1024,
  packedPages: 2000,
  viewPages: 3,
};
// 外側の停止理由だけを固定コードへ変換し、例外本文やURLは診断へ出さない。
function interruptionReason(signal: AbortSignal): string {
  if (signal.reason instanceof TimeshiftError) return signal.reason.code;
  const name = object(signal.reason).name;
  if (name === 'TimeoutError') return 'COMMENT_TOTAL_TIMEOUT';
  if (name === 'AbortError') return 'USER_CANCELLED';
  return 'interrupted';
}

function integer(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : fallback;
}

/** protobuf の表示属性を既存 CSV の型へ変換する。未指定の装飾には通常表示を使う。 */
export function convertTimeshiftComment(message: Record<string, unknown>) {
  const meta = object(message.meta);
  const payload = object(message.message ?? message.payload);
  const chat = object(payload.chat ?? payload.overflowed_chat);
  if (typeof chat.content !== 'string') return undefined;
  const timestamp = object(meta.at);
  const seconds = Number(timestamp.seconds);
  const nanos = Number(timestamp.nanos ?? 0);
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isInteger(nanos) ||
    nanos < 0 ||
    nanos >= 1e9 ||
    Math.abs(seconds * 1000) > 8.63e15
  )
    throw new TimeshiftError('INVALID_COMMENT_TIME');
  const modifier = object(chat.modifier);
  const rgb = object(modifier.full_color);
  const color = (value: unknown): number => Math.min(255, Math.max(0, integer(value, 255)));
  const comment: NicoComment = {
    id: typeof meta.id === 'string' ? meta.id : '',
    at: new Date(seconds * 1000 + Math.floor(nanos / 1e6)),
    liveId: integer(object(object(meta.origin).chat).live_id),
    no: integer(chat.no),
    vpos: integer(chat.vpos),
    rawUserId: integer(chat.raw_user_id),
    hashedUserId: typeof chat.hashed_user_id === 'string' ? chat.hashed_user_id : '',
    accountStatus: chat.account_status === 1 ? 'Premium' : 'Standard',
    position: (['naka', 'shita', 'ue'] as const)[integer(modifier.position)] ?? 'naka',
    size: (['medium', 'small', 'big'] as const)[integer(modifier.size)] ?? 'medium',
    font: (['defont', 'mincho', 'gothic'] as const)[integer(modifier.font)] ?? 'defont',
    opacity: modifier.opacity === 1 ? 'Translucent' : 'Normal',
    color:
      typeof modifier.named_color === 'number'
        ? (COLORS[modifier.named_color] ?? 'white')
        : modifier.full_color
          ? { r: color(rgb.r), g: color(rgb.g), b: color(rgb.b) }
          : 'white',
    content: chat.content,
  };
  return { comment, seconds, nanos };
}

/** 入口で提供された過去履歴とセグメントだけを取得し、ライブ向けの監視へ移行しない。 */
export async function recordTimeshiftComments(
  viewUri: string,
  outputPath: string,
  signal: AbortSignal,
  onComment?: (comment: NicoComment, count: number) => void,
  limits = TIMESHIFT_COMMENT_LIMITS,
): Promise<TimeshiftCommentResult> {
  const startedAt = new Date();
  const registry = await getProtoRegistry();
  // 呼び出し元が今回専用に確保した CSV だけへ追記する。失敗時も取得済み分を残す。
  const file = await fs.open(outputPath, 'a', 0o600);
  const rows: { seconds: number; nanos: number; no: number; line: string }[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let duplicates = 0;
  let invalidCount = 0;
  let reason = 'snapshot-exhausted';
  let complete = false;
  let sorted = false;
  const viewRequests: { durationMs: number; entries: number }[] = [];
  let readingView = false;
  const addBytes = (length: number): void => {
    bytes += length;
    if (bytes > limits.bytes) throw new TimeshiftError('COMMENT_BYTE_LIMIT');
  };
  const decode = (type: Type, data: Uint8Array): Record<string, unknown> =>
    object(type.toObject(type.decode(data), { longs: String }));
  const frames = async function* (url: string, type: Type, timeoutMs = 20_000) {
    const response = await checkedFetch(url, signal, undefined, timeoutMs);
    if (!response.body) throw new TimeshiftError('COMMENT_BODY_MISSING');
    const reader = new ProtobufStreamReader();
    let pendingBytes = 0;
    for await (const raw of response.body) {
      const chunk: unknown = raw;
      if (!(chunk instanceof Uint8Array)) throw new TimeshiftError('INVALID_RESPONSE_CHUNK');
      signal.throwIfAborted();
      addBytes(chunk.length);
      reader.addChunk(chunk);
      pendingBytes += chunk.length;
      let frame: Uint8Array | undefined;
      while ((frame = reader.unshift())) {
        pendingBytes -= frame.length + Math.max(1, Math.ceil(Math.log2(frame.length + 1) / 7));
        yield decode(type, frame);
      }
    }
    if (pendingBytes !== 0) throw new TimeshiftError('TRUNCATED_COMMENT_FRAME');
  };
  const save = async (message: Record<string, unknown>): Promise<void> => {
    signal.throwIfAborted();
    let value: ReturnType<typeof convertTimeshiftComment>;
    try {
      value = convertTimeshiftComment(message);
    } catch (error) {
      // 復元できない投稿時刻の1件だけを数え、後続の正常なコメントは回収する。
      if (!(error instanceof TimeshiftError) || error.code !== 'INVALID_COMMENT_TIME') throw error;
      invalidCount += 1;
      return;
    }
    if (!value) return;
    const { comment, seconds, nanos } = value;
    const key =
      comment.id || JSON.stringify([seconds, nanos, comment.liveId, comment.no, comment.content]);
    if (seen.has(key)) {
      duplicates += 1;
      return;
    }
    if (rows.length >= limits.count) throw new TimeshiftError('COMMENT_COUNT_LIMIT');
    const line = toCommentCsv(comment);
    addBytes(Buffer.byteLength(line));
    await file.writeFile(line);
    rows.push({ seconds, nanos, no: comment.no, line });
    seen.add(key);
    onComment?.(comment, rows.length);
  };
  try {
    await file.writeFile(CSV_HEADER);
    const forwards = new Set<string>();
    const requested = new Set<string>();
    let backward: string | undefined;
    let requestAt = 'now';
    let marker = false;
    for (let page = 0; page < limits.viewPages; page += 1) {
      signal.throwIfAborted();
      if (requested.has(requestAt)) throw new TimeshiftError('VIEW_CURSOR_CYCLE');
      requested.add(requestAt);
      const url = new URL(viewUri);
      url.searchParams.set('at', requestAt);
      let next: string | undefined;
      marker = false;
      // Viewはnextカーソルの先で応答を待つ。通常ファイルの20秒制限とは分ける。
      const request = { durationMs: 0, entries: 0 };
      viewRequests.push(request);
      const requestStarted = performance.now();
      readingView = true;
      try {
        for await (const entry of frames(url.toString(), registry.ChunkedEntry, 60_000)) {
          request.entries += 1;
          const back = object(object(entry.backward).segment).uri;
          if (typeof back === 'string' && back) backward = back;
          for (const candidate of [entry.previous, entry.segment]) {
            const uri = object(candidate).uri;
            if (typeof uri === 'string' && uri) forwards.add(uri);
          }
          if (entry.next !== undefined) {
            const at = object(entry.next).at;
            if ((typeof at === 'string' || typeof at === 'number') && /^\d{1,19}$/.test(String(at)))
              next = String(at);
            marker = next !== undefined;
            break;
          }
        }
      } finally {
        request.durationMs = Math.round(performance.now() - requestStarted);
      }
      readingView = false;
      if (backward || forwards.size) break;
      if (!next) throw new TimeshiftError('VIEW_MARKER_MISSING');
      requestAt = next;
    }
    // backward がない場合は履歴を取得できた根拠がないため、空でも完了にはしない。
    const hasBackward = !!backward;
    const packed = new Set<string>();
    while (backward) {
      signal.throwIfAborted();
      if (packed.has(backward)) throw new TimeshiftError('HISTORY_CYCLE');
      if (packed.size >= limits.packedPages) throw new TimeshiftError('COMMENT_PAGE_LIMIT');
      packed.add(backward);
      const response = await checkedFetch(backward, signal);
      if (!response.body) throw new TimeshiftError('COMMENT_BODY_MISSING');
      const chunks: Buffer[] = [];
      for await (const raw of response.body) {
        const chunk: unknown = raw;
        if (!(chunk instanceof Uint8Array)) throw new TimeshiftError('INVALID_RESPONSE_CHUNK');
        addBytes(chunk.length);
        chunks.push(Buffer.from(chunk));
      }
      const segment = decode(registry.PackedSegment, Buffer.concat(chunks));
      for (const message of Array.isArray(segment.messages) ? segment.messages : [])
        await save(object(message));
      const next = object(segment.next).uri;
      backward = typeof next === 'string' && next ? next : undefined;
    }
    for (const url of forwards)
      for await (const message of frames(url, registry.ChunkedMessage)) await save(message);
    if (!hasBackward) throw new TimeshiftError('BACKWARD_NOT_PROVIDED');
    if (!marker) throw new TimeshiftError('VIEW_MARKER_MISSING');
    if (rows.length >= limits.count) throw new TimeshiftError('COMMENT_COUNT_LIMIT');
    if (invalidCount) throw new TimeshiftError('INVALID_COMMENT_TIME');
    complete = true;
  } catch (error) {
    // fetchの本文待機中のタイムアウトはAbortErrorになる。利用者の停止はsignalで区別する。
    const requestTimedOut = ['TimeoutError', 'AbortError'].includes(String(object(error).name));
    reason = signal.aborted
      ? interruptionReason(signal)
      : error instanceof TimeshiftError
        ? error.code
        : requestTimedOut
          ? readingView
            ? 'COMMENT_VIEW_TIMEOUT'
            : 'COMMENT_REQUEST_TIMEOUT'
          : 'COMMENT_FETCH_OR_SAVE_FAILED';
  } finally {
    await file.close();
  }

  // 中断時は取得順の CSV を残して速やかに停止する。通常時は別ファイルを完成させてから置換する。
  const tempPath = `${outputPath}.sorting`;
  let ownTemp = false;
  try {
    signal.throwIfAborted();
    rows.sort((a, b) => a.seconds - b.seconds || a.nanos - b.nanos || a.no - b.no);
    const output = await fs.open(tempPath, 'wx', 0o600);
    ownTemp = true;
    try {
      await output.writeFile(CSV_HEADER);
      for (let index = 0; index < rows.length; index += 1000) {
        signal.throwIfAborted();
        await output.writeFile(
          rows
            .slice(index, index + 1000)
            .map((row) => row.line)
            .join(''),
        );
      }
    } finally {
      await output.close();
    }
    signal.throwIfAborted();
    // 保存先が削除された場合に、ソート結果で消失を隠さない。
    await fs.access(outputPath);
    await fs.rename(tempPath, outputPath);
    sorted = true;
  } catch (error) {
    complete = false;
    reason = signal.aborted
      ? interruptionReason(signal)
      : error instanceof TimeshiftError
        ? error.code
        : 'COMMENT_SORT_FAILED';
  } finally {
    if (ownTemp) await fs.rm(tempPath, { force: true }).catch(() => {});
  }
  return {
    outputPath,
    count: rows.length,
    startedAt,
    endedAt: new Date(),
    aborted: signal.aborted,
    status: complete ? 'complete' : 'partial',
    reason,
    sorted,
    duplicates,
    invalidCount,
    viewRequests,
  };
}
