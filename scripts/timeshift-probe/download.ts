import crypto from 'node:crypto';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { cookieHeaderFor, type HlsSegment, type TrackResult } from '../../src/main/core/nico/hls';
import type { StreamCookie } from '../../src/main/core/nico/watch-session';
import { checkedFetch, ProbeError } from './common';

const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;

export function downloadMetrics() {
  return {
    requestCount: 0,
    maxConcurrentRequests: 0,
    receivedBytes: 0,
    missingSegments: 0,
    httpErrors: [] as number[],
    maxResourceBytes: MAX_RESOURCE_BYTES,
    timingsMs: { fetch: 0, retryWait: 0, orderedWait: 0, decrypt: 0, write: 0, drainWait: 0 },
  };
}

type Metrics = ReturnType<typeof downloadMetrics>;
type Loaded = { data: Buffer; map?: Buffer; key?: Buffer };

// 固定した検証用 playlist 専用。取得を先行させ、復号・書き込みは元の順番で行う。
export async function downloadProbeTrack(
  segments: HlsSegment[],
  sink: Writable,
  cookies: StreamCookie[],
  threads: number,
  signal: AbortSignal,
  metrics: Metrics,
): Promise<TrackResult> {
  if (!Number.isInteger(threads) || threads < 1 || threads > 5)
    throw new ProbeError('INVALID_SEGMENT_THREADS');
  const controller = new AbortController();
  const workSignal = AbortSignal.any([signal, controller.signal]);
  const selected = segments.filter((segment) => !segment.uri.includes('/blank/'));
  const result: TrackResult = { reason: 'endlist', segments: 0, bytes: 0 };
  const pending = new Map<number, Promise<Loaded | undefined>>();
  const resources = new Map<string, Promise<Buffer>>();
  let activeRequests = 0;
  let firstFailure: unknown;
  let failed = false;

  // HTTP 応答の本文を読み切るまで測る。並列要求の時間は累積なので実時間を超え得る。
  const fetchBytes = async (url: string): Promise<Buffer> => {
    for (let attempt = 0; ; attempt += 1) {
      workSignal.throwIfAborted();
      const started = performance.now();
      activeRequests += 1;
      metrics.requestCount += 1;
      metrics.maxConcurrentRequests = Math.max(metrics.maxConcurrentRequests, activeRequests);
      try {
        const response = await checkedFetch(url, workSignal, cookieHeaderFor(cookies, url));
        if (!response.body) throw new ProbeError('MEDIA_BODY_MISSING');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const raw of response.body) {
          workSignal.throwIfAborted();
          const chunk = Buffer.from(raw as Uint8Array);
          size += chunk.length;
          metrics.receivedBytes += chunk.length;
          if (size > MAX_RESOURCE_BYTES) throw new ProbeError('MEDIA_RESOURCE_LIMIT');
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      } catch (caught) {
        if (
          caught instanceof ProbeError &&
          caught.httpStatus !== undefined &&
          !metrics.httpErrors.includes(caught.httpStatus)
        )
          metrics.httpErrors.push(caught.httpStatus);
        if (
          workSignal.aborted ||
          attempt >= 3 ||
          (caught instanceof ProbeError && caught.httpStatus === undefined)
        )
          throw caught;
        if (caught instanceof ProbeError && [403, 404].includes(caught.httpStatus!)) throw caught;
      } finally {
        activeRequests -= 1;
        metrics.timingsMs.fetch += performance.now() - started;
      }
      // 既存取得処理と同じ最大4試行・指数バックオフ。認証更新は行わない。
      const waiting = performance.now();
      try {
        await delay(500 * 2 ** attempt, undefined, { signal: workSignal });
      } finally {
        metrics.timingsMs.retryWait += performance.now() - waiting;
      }
    }
  };
  const resource = (url: string): Promise<Buffer> => {
    let task = resources.get(url);
    if (!task) {
      task = fetchBytes(url);
      resources.set(url, task);
      // 鍵・初期化情報が多数変わってもキャッシュを無制限に保持しない。
      if (resources.size > threads * 2) resources.delete(resources.keys().next().value!);
    }
    return task;
  };
  const load = async (segment: HlsSegment): Promise<Loaded | undefined> => {
    const map = segment.mapUri ? await resource(segment.mapUri) : undefined;
    let key: Buffer | undefined;
    if (segment.key) {
      if (segment.key.method !== 'AES-128' || !segment.key.uri)
        throw new ProbeError('INVALID_ENCRYPTION_KEY');
      key = await resource(segment.key.uri);
      if (key.length !== 16) throw new ProbeError('INVALID_ENCRYPTION_KEY');
    }
    try {
      return { data: await fetchBytes(segment.uri), map, key };
    } catch (error) {
      if (error instanceof ProbeError && error.httpStatus === 404) {
        metrics.missingSegments += 1;
        return undefined;
      }
      throw error;
    }
  };
  const start = (index: number): void => {
    if (index >= selected.length || workSignal.aborted) return;
    // 後続の先読みが先に失敗しても、即座に全要求を止めて未処理の rejection を残さない。
    pending.set(
      index,
      load(selected[index]).catch((error: unknown) => {
        if (!failed) firstFailure = error;
        failed = true;
        controller.abort();
        return undefined;
      }),
    );
  };
  const write = async (data: Buffer): Promise<void> => {
    workSignal.throwIfAborted();
    if (sink.destroyed || sink.writableEnded) throw new ProbeError('MEDIA_SINK_CLOSED');
    const started = performance.now();
    try {
      if (!sink.write(data)) {
        const waiting = performance.now();
        try {
          await once(sink, 'drain', { signal: workSignal });
        } finally {
          metrics.timingsMs.drainWait += performance.now() - waiting;
        }
      }
    } finally {
      metrics.timingsMs.write += performance.now() - started;
    }
  };

  let sentMapUri: string | undefined;
  try {
    workSignal.throwIfAborted();
    for (let index = 0; index < threads; index += 1) start(index);
    for (let index = 0; index < selected.length; index += 1) {
      const waiting = performance.now();
      const loaded = await pending.get(index);
      metrics.timingsMs.orderedWait += performance.now() - waiting;
      pending.delete(index);
      workSignal.throwIfAborted();
      // 書き込みを待つ間にも次を取得する。保持量は先読み threads 個＋出力中1個まで。
      start(index + threads);
      if (!loaded) continue;
      const segment = selected[index];
      if (loaded.map && segment.mapUri !== sentMapUri) {
        await write(loaded.map);
        sentMapUri = segment.mapUri;
      }
      let data = loaded.data;
      if (loaded.key) {
        const started = performance.now();
        try {
          const iv = Buffer.alloc(16);
          if (segment.key?.iv) {
            if (!/^[0-9a-f]{1,32}$/i.test(segment.key.iv))
              throw new ProbeError('INVALID_ENCRYPTION_IV');
            Buffer.from(segment.key.iv.padStart(32, '0'), 'hex').copy(iv);
          } else {
            iv.writeBigUInt64BE(BigInt(segment.seq), 8);
          }
          const decipher = crypto.createDecipheriv('aes-128-cbc', loaded.key, iv);
          data = Buffer.concat([decipher.update(data), decipher.final()]);
        } finally {
          metrics.timingsMs.decrypt += performance.now() - started;
        }
      }
      await write(data);
      result.segments += 1;
      result.bytes += data.length;
      result.firstSeq ??= segment.seq;
      result.lastSeq = segment.seq;
    }
    return result;
  } catch (error) {
    throw failed ? firstFailure : error;
  } finally {
    controller.abort();
    await Promise.allSettled(pending.values());
    for (const key of Object.keys(metrics.timingsMs) as (keyof Metrics['timingsMs'])[])
      metrics.timingsMs[key] = Math.round(metrics.timingsMs[key]);
  }
}
