import fs from 'node:fs/promises';
import path from 'node:path';
import type { Type } from 'protobufjs';
import { getProtoRegistry } from '../../src/main/vendor/nico-client/internal/protoLoader';
import { ProtobufStreamReader } from '../../src/main/vendor/nico-client/internal/protobufStreamReader';
import { checkedFetch, object, ProbeError } from './common';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PACKED_PAGES = 20;

// next.at はカーソルとして保存する。大きな int64 を丸めたり、日時だと決めつけたりしない。
function cursor(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const text = String(value);
  return /^\d{1,19}$/.test(text) ? text : undefined;
}

export function buildProbeViewUrl(viewUri: string, viewAt: string): string {
  const view = new URL(viewUri);
  view.searchParams.delete('at');
  if (viewAt !== 'beginning') view.searchParams.set('at', viewAt);
  return view.toString();
}

// JSON 化は int64 を文字列に固定する。protobuf の内容自体は共有用レポートへ出さない。
function decode(type: Type, bytes: Uint8Array): Record<string, unknown> {
  return object(type.toObject(type.decode(bytes), { longs: String }));
}

export async function sampleComments(
  viewUri: string,
  dir: string,
  limit: number,
  viewAt: string,
  signal: AbortSignal,
  onProgress: (summary: Record<string, unknown>) => void = () => {},
) {
  const registry = await getProtoRegistry();
  const file = await fs.open(path.join(dir, 'comments.jsonl'), 'wx', 0o600);
  const seen = new Set<string>();
  const forwards = new Set<string>();
  const packed = new Set<string>();
  let bytes = 0;
  let count = 0;
  let duplicates = 0;
  let backwardUri: string | undefined;
  let nextMarker = false;
  let nextAt: string | undefined;
  const viewEntries = { total: 0, backward: 0, previous: 0, segment: 0, next: 0 };
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  let historyExhausted = false;
  let reason = 'view-exhausted';

  const summary = () => ({
    status: count ? 'sample-saved' : 'no-comments-observed',
    reason,
    count,
    duplicates,
    bytes,
    firstAt,
    lastAt,
    backwardProvided: Boolean(backwardUri),
    packedPages: packed.size,
    forwardSegments: forwards.size,
    nextMarker,
    nextAt,
    requestedAt: viewAt === 'beginning' ? 'omitted' : viewAt,
    viewEntries,
    historyExhausted,
    fullCoverage: 'not-verified',
  });

  const addBytes = (length: number): void => {
    bytes += length;
    if (bytes > MAX_BYTES) throw new ProbeError('COMMENT_BYTE_LIMIT');
  };
  // 投稿者情報はサンプルに不要なので保存しない。本文を含むファイルはローカル確認用とする。
  const save = async (message: Record<string, unknown>): Promise<void> => {
    const meta = object(message.meta);
    const payload = object(message.message);
    const chat = object(payload.chat ?? payload.overflowed_chat);
    if (typeof chat.content !== 'string' || count >= limit) return;
    const timestamp = object(meta.at);
    const seconds = Number(timestamp.seconds);
    const millis = seconds * 1000 + Number(timestamp.nanos ?? 0) / 1e6;
    const at =
      Number.isFinite(millis) && Math.abs(millis) <= 8.64e15
        ? new Date(millis).toISOString()
        : undefined;
    const id = typeof meta.id === 'string' ? meta.id : undefined;
    const key = id ?? JSON.stringify([at, chat.no, chat.content]);
    if (seen.has(key)) {
      duplicates += 1;
      return;
    }
    seen.add(key);
    await file.writeFile(
      `${JSON.stringify({ id, at, no: chat.no, vpos: chat.vpos, content: chat.content })}\n`,
    );
    count += 1;
    if (at && (!firstAt || at < firstAt)) firstAt = at;
    if (at && (!lastAt || at > lastAt)) lastAt = at;
  };
  const frames = async function* (url: string, type: Type) {
    const response = await checkedFetch(url, signal);
    if (!response.body) throw new ProbeError('COMMENT_BODY_MISSING');
    const reader = new ProtobufStreamReader();
    for await (const raw of response.body) {
      const chunk: unknown = raw;
      if (!(chunk instanceof Uint8Array)) throw new ProbeError('INVALID_COMMENT_CHUNK');
      addBytes(chunk.length);
      reader.addChunk(chunk);
      let frame: Uint8Array | undefined;
      while ((frame = reader.unshift())) yield decode(type, frame);
    }
  };
  try {
    // 最初の View 応答だけを観測する。next の無限ポーリングや再接続はこの段階では行わない。
    const view = buildProbeViewUrl(viewUri, viewAt);
    for await (const entry of frames(view, registry.ChunkedEntry)) {
      viewEntries.total += 1;
      for (const type of ['backward', 'previous', 'segment', 'next'] as const) {
        if (entry[type] !== undefined) viewEntries[type] += 1;
      }
      const back = object(object(entry.backward).segment).uri;
      if (typeof back === 'string') backwardUri = back;
      for (const candidate of [entry.previous, entry.segment]) {
        const uri = object(candidate).uri;
        if (typeof uri === 'string') forwards.add(uri);
      }
      if (entry.next !== undefined) {
        nextMarker = true;
        nextAt = cursor(object(entry.next).at);
        break;
      }
    }

    // 過去履歴を少量だけ辿り、循環・件数・ページ数・バイト数・実行時間で上限を設ける。
    let current = backwardUri;
    while (current && count < limit && packed.size < MAX_PACKED_PAGES) {
      if (packed.has(current)) {
        reason = 'history-cycle';
        break;
      }
      packed.add(current);
      const response = await checkedFetch(current, signal);
      const chunks: Uint8Array[] = [];
      if (!response.body) throw new ProbeError('COMMENT_BODY_MISSING');
      for await (const raw of response.body) {
        const chunk: unknown = raw;
        if (!(chunk instanceof Uint8Array)) throw new ProbeError('INVALID_COMMENT_CHUNK');
        addBytes(chunk.length);
        chunks.push(chunk);
      }
      const segment = decode(registry.PackedSegment, Buffer.concat(chunks));
      const messages = Array.isArray(segment.messages) ? segment.messages : [];
      for (const message of messages) {
        if (count >= limit) break;
        await save(object(message));
      }
      const next = object(segment.next).uri;
      current = typeof next === 'string' && next ? next : undefined;
      historyExhausted = !current && count < limit;
    }
    if (current && packed.size >= MAX_PACKED_PAGES) reason = 'page-limit';
    for (const uri of forwards) {
      if (count >= limit) break;
      for await (const message of frames(uri, registry.ChunkedMessage)) {
        await save(message);
        if (count >= limit) break;
      }
    }
    if (count >= limit) reason = 'comment-limit';
    return summary();
  } catch (error) {
    // 時間切れや失敗でも、保存できた件数・範囲をレポートに残す。
    onProgress({ ...summary(), status: 'partial', reason: 'interrupted-or-failed' });
    throw error;
  } finally {
    await file.close();
  }
}
