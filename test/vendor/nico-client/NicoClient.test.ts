import { NicoClient } from '../../../src/main/vendor/nico-client/NicoClient';
import type { MockInstance } from 'vitest';
import { CommentViewStalledError } from '../../../src/main/vendor/nico-client/errors';
import { HttpClient } from '../../../src/main/vendor/nico-client/internal/httpClient';
import { getProtoRegistry } from '../../../src/main/vendor/nico-client/internal/protoLoader';
import { isRetryableNicoError } from '../../../src/main/vendor/nico-client/retryPolicy';
import {
  NicoLiveProgramStatus,
  type NicoLiveProgramInfo,
  type NicoComment,
} from '../../../src/main/vendor/nico-client/types';

// 通信と待機を差し替え、実物のViewデコード・巡回・停止を仮想時間で確認する。
vi.mock('../../../src/main/vendor/nico-client/abortableDelay', () => ({
  abortableDelay: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish, { once: true });
    }),
}));

const info = {
  nicoliveProgramId: 'lv1',
  title: 'test',
  status: NicoLiveProgramStatus.onAir,
  webSocketUrl: 'wss://example.test/watch',
} as NicoLiveProgramInfo;
let registry: Awaited<ReturnType<typeof getProtoRegistry>>;
let controller: AbortController;
let requests: { at: string | null; time: number }[];
let respond: (index: number) => Promise<object[]>;
let responseDelayMs: number;
let httpStream: MockInstance<HttpClient['stream']>;
let httpText: MockInstance<HttpClient['getText']>;

beforeEach(async () => {
  registry = await getProtoRegistry();
  vi.useFakeTimers();
  controller = new AbortController();
  requests = [];
  responseDelayMs = 0;
  respond = async () => [];
  vi.spyOn(NicoClient.prototype as any, 'openViewSocket').mockResolvedValue(
    'https://example.test/view',
  );
  httpText = vi
    .spyOn(HttpClient.prototype, 'getText')
    .mockRejectedValue(new Error('unexpected page request'));
  httpStream = vi.spyOn(HttpClient.prototype, 'stream').mockImplementation(async function* (url) {
    if (!url.startsWith('https://example.test/view?')) throw new Error('unexpected stream request');
    requests.push({ at: new URL(url).searchParams.get('at'), time: performance.now() });
    if (responseDelayMs) await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    for (const entry of await respond(requests.length - 1)) {
      yield registry.ChunkedEntry.encodeDelimited(registry.ChunkedEntry.fromObject(entry)).finish();
    }
  });
});
afterEach(() => {
  controller.abort();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function consume(): Promise<NicoComment[]> {
  const comments: NicoComment[] = [];
  for await (const comment of new NicoClient('lv1').streamComments(
    { signal: controller.signal },
    info,
  ))
    comments.push(comment);
  return comments;
}

test.each(['停滞', '後退', '循環'])(
  '取得位置の%sが10分続いたら打ち切り、要求間隔と回数を制限する',
  async (kind) => {
    respond = async (index) => {
      let at = 100;
      if (kind === '後退') at -= index;
      if (kind === '循環') at -= index % 2;
      return [{ next: { at } }];
    };
    const checked = expect(consume()).rejects.toBeInstanceOf(CommentViewStalledError);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await checked;
    expect(requests).toHaveLength(26);
    expect(requests.slice(0, 8).map((r) => r.time)).toEqual([
      0, 1000, 2000, 4000, 8000, 16000, 32000, 62000,
    ]);
    expect(requests.at(-1)!.time).toBeGreaterThanOrEqual(600_000);
    expect(requests.slice(1).every((r) => r.at === '100')).toBe(true);
    // 取得位置の異常は外側の再接続でも繰り返さない。
    expect(isRetryableNicoError(new CommentViewStalledError())).toBe(false);
  },
);

test('10回以上停滞しても10分未満なら受信を諦めない', async () => {
  respond = async () => [{ next: { at: 100 } }];
  const task = consume();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(requests.length).toBeGreaterThan(10);
  controller.abort();
  await expect(task).resolves.toEqual([]);
});

test('10分を超えても停滞が10回未満の遅い応答は諦めない', async () => {
  responseDelayMs = 120_000;
  respond = async () => [{ next: { at: 100 } }];
  const task = consume();
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  controller.abort();
  await vi.advanceTimersByTimeAsync(120_000);
  await expect(task).resolves.toEqual([]);
  expect(requests.length).toBeLessThan(10);
});

test('コメント0件でも取得位置が進めば長時間の監視を続ける', async () => {
  responseDelayMs = 32_000;
  respond = async (index) => {
    if (index === 119) controller.abort();
    return [{ next: { at: 100 + index } }];
  };
  const task = consume();
  await vi.advanceTimersByTimeAsync(120 * 32_000);
  expect(await task).toEqual([]);
  expect(requests).toHaveLength(120);
  expect(requests.every((r, i) => r.time === i * 32_000)).toBe(true);
});

test('即時応答で取得位置が進んでも要求は1秒に1回までにする', async () => {
  respond = async (index) => {
    if (index === 9) controller.abort();
    return [{ next: { at: 100 + index } }];
  };
  const task = consume();
  await vi.advanceTimersByTimeAsync(10_000);
  await task;
  expect(requests.map((r) => r.time)).toEqual(Array.from({ length: 10 }, (_, i) => i * 1000));
});

test('前進すれば停滞回数・開始時刻・待機間隔を戻す', async () => {
  respond = async (index) => {
    if (index === 59) controller.abort();
    return [{ next: { at: 100 + Math.floor(index / 20) } }];
  };
  const task = consume();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  await task;
  expect(requests).toHaveLength(60);
  expect(requests[21].time - requests[20].time).toBe(1000);
  expect(requests.at(-1)!.time).toBeGreaterThan(10 * 60_000);
});

test.each([500, 100_000])('取得間隔の待機中（%sms）に停止すると次の要求を送らない', async (at) => {
  respond = async () => [{ next: { at: 100 } }];
  const task = consume();
  await vi.advanceTimersByTimeAsync(at);
  const count = requests.length;
  controller.abort();
  await task;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(requests).toHaveLength(count);
});

test('コメントと終了通知を受け取る通常経路を維持する', async () => {
  httpStream.mockImplementation(async function* (url) {
    if (url.startsWith('https://example.test/view?')) {
      yield registry.ChunkedEntry.encodeDelimited(
        registry.ChunkedEntry.fromObject({ segment: { uri: 'https://example.test/segment' } }),
      ).finish();
      return;
    }
    if (url !== 'https://example.test/segment') throw new Error('unexpected request');
    for (const value of [
      {
        meta: { id: 'c1', at: { seconds: 1000 }, origin: { chat: { live_id: 1 } } },
        message: { chat: { content: 'test', no: 1, modifier: {} } },
      },
      { state: { program_status: { state: 1 } } },
    ])
      yield registry.ChunkedMessage.encodeDelimited(
        registry.ChunkedMessage.fromObject(value),
      ).finish();
  });
  const comments = await consume();
  expect(comments).toHaveLength(1);
  expect(comments[0].content).toBe('test');
  expect(httpText).not.toHaveBeenCalled();
});
