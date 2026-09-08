import fs from 'node:fs/promises';
import path from 'node:path';
import type { Type } from 'protobufjs';
import { getProtoRegistry } from '../../src/main/vendor/nico-client/internal/protoLoader';
import { ProtobufStreamReader } from '../../src/main/vendor/nico-client/internal/protobufStreamReader';
import { checkedFetch, object, ProbeError, ProbeTimings } from './common';

// 全件モードにも停止条件を設け、上限に達した取得を完了扱いしない。
export function commentLimits(full: boolean) {
  return { bytes: (full ? 128 : 16) * 1024 * 1024, packedPages: full ? 2000 : 20 };
}

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
  maxViewPages = 1,
  full = false,
) {
  const registry = await getProtoRegistry();
  const limits = commentLimits(full);
  const timings = new ProbeTimings();
  const filePath = path.join(dir, 'comments.jsonl');
  const file = await fs.open(filePath, 'wx', 0o600);
  const rows: { time: number; nanos: number; no: number; line: string }[] = [];
  let sorted = false;
  let completedForwards = 0;
  let snapshotRead = false;
  let failed = false;
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
  const viewRequests: { requestedAt: string; nextAt?: string; entries: number }[] = [];
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  let historyExhausted = false;
  let reason = 'view-exhausted';

  const status = (): string => {
    if (failed) return 'partial';
    if (full) return snapshotRead ? 'history-saved' : 'incomplete';
    return count ? 'sample-saved' : 'no-comments-observed';
  };
  const summary = () => ({
    status: status(),
    timingsMs: timings.milliseconds,
    limits,
    sortOrder: sorted ? 'at-then-no' : 'acquisition',
    completedForwardSegments: completedForwards,
    snapshotCoverage: snapshotRead ? 'complete' : 'not-verified',
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
    viewRequests,
    historyExhausted,
    fullCoverage: 'not-verified',
  });

  const addBytes = (length: number): void => {
    bytes += length;
    if (bytes > limits.bytes) throw new ProbeError('COMMENT_BYTE_LIMIT');
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
    const line = `${JSON.stringify({ id, at, no: chat.no, vpos: chat.vpos, content: chat.content })}\n`;
    await file.writeFile(line);
    rows.push({
      time: at ? seconds : Infinity,
      nanos: Number(timestamp.nanos ?? 0),
      no: Number(chat.no) || 0,
      line,
    });
    count += 1;
    if (at && (!firstAt || at < firstAt)) firstAt = at;
    if (at && (!lastAt || at > lastAt)) lastAt = at;
  };
  const frames = async function* (url: string, type: Type) {
    const response = await checkedFetch(url, signal);
    if (!response.body) throw new ProbeError('COMMENT_BODY_MISSING');
    const reader = new ProtobufStreamReader();
    let pendingBytes = 0;
    for await (const raw of response.body) {
      const chunk: unknown = raw;
      if (!(chunk instanceof Uint8Array)) throw new ProbeError('INVALID_COMMENT_CHUNK');
      addBytes(chunk.length);
      reader.addChunk(chunk);
      pendingBytes += chunk.length;
      let frame: Uint8Array | undefined;
      while ((frame = reader.unshift())) {
        // 正規の varint 長を差し引き、EOF に未完フレームが残った場合は完了扱いしない。
        const prefixBytes = Math.max(1, Math.ceil(Math.log2(frame.length + 1) / 7));
        pendingBytes -= frame.length + prefixBytes;
        yield decode(type, frame);
      }
    }
    if (pendingBytes !== 0) throw new ProbeError('TRUNCATED_COMMENT_FRAME');
  };
  onProgress(summary());
  try {
    // now が next だけを返す場合は、そのカーソルで入口を探す。データを見つけた時点で止め、
    // 要求回数・循環・既存の時間上限によりライブ向けの無限ポーリングにはしない。
    await timings.measure('view', async () => {
      const requested = new Set<string>();
      let requestAt = viewAt;
      for (let page = 0; page < maxViewPages; page += 1) {
        requested.add(requestAt);
        const request: (typeof viewRequests)[number] = {
          requestedAt: requestAt === 'beginning' ? 'omitted' : requestAt,
          entries: 0,
        };
        viewRequests.push(request);
        for await (const entry of frames(
          buildProbeViewUrl(viewUri, requestAt),
          registry.ChunkedEntry,
        )) {
          viewEntries.total += 1;
          request.entries += 1;
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
            request.nextAt = nextAt;
            break;
          }
        }
        if (backwardUri || forwards.size) {
          reason = 'view-exhausted';
          break;
        }
        if (request.nextAt === undefined) {
          reason = 'no-next-cursor';
          break;
        }
        if (requested.has(request.nextAt)) {
          reason = 'view-cursor-cycle';
          break;
        }
        reason = 'view-page-limit';
        requestAt = request.nextAt;
      }
    });

    // 過去履歴を辿り、循環・件数・ページ数・バイト数・実行時間で上限を設ける。
    await timings.measure('backward', async () => {
      let current = backwardUri;
      while (current && count < limit && packed.size < limits.packedPages) {
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
      if (current && packed.size >= limits.packedPages) reason = 'page-limit';
    });
    await timings.measure('forward', async () => {
      for (const uri of forwards) {
        if (count >= limit) break;
        for await (const message of frames(uri, registry.ChunkedMessage)) {
          await save(message);
          if (count >= limit) break;
        }
        if (count < limit) completedForwards += 1;
      }
    });
    snapshotRead =
      historyExhausted &&
      completedForwards === forwards.size &&
      count < limit &&
      viewRequests.at(-1)?.nextAt !== undefined;
    if (full && snapshotRead) reason = 'snapshot-exhausted';
    if (full && reason === 'view-exhausted' && !snapshotRead) {
      reason = backwardUri ? 'view-marker-missing' : 'backward-not-provided';
    }
    if (count >= limit) reason = 'comment-limit';
  } catch (error) {
    // 時間切れや失敗でも、保存できた件数・範囲をレポートに残す。
    failed = true;
    reason = 'interrupted-or-failed';
    onProgress(summary());
    throw error;
  } finally {
    await file.close();
    // 途中失敗でも取得できた分を時刻順にする。同時刻はコメント番号、同番号は取得順。
    // 元ファイルを残したまま一時ファイルを完成させ、保存失敗で取得済み分を失わない。
    await timings.measure('sortAndSave', async () => {
      rows.sort((a, b) => a.time - b.time || a.nanos - b.nanos || a.no - b.no);
      const tempPath = path.join(dir, 'comments.sorted.jsonl');
      const output = await fs.open(tempPath, 'wx', 0o600);
      try {
        for (let index = 0; index < rows.length; index += 1000) {
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
      await fs.rename(tempPath, filePath);
      sorted = true;
    });
    onProgress(summary());
  }
  return summary();
}
