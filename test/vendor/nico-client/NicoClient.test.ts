import { NicoClient } from '../../../src/main/vendor/nico-client/NicoClient';
import type { MockInstance } from 'vitest';
import {
  CommentViewMarkerMissingError,
  CommentViewStalledError,
} from '../../../src/main/vendor/nico-client/errors';
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
let warn = vi.fn();

beforeEach(async () => {
  registry = await getProtoRegistry();
  vi.useFakeTimers();
  controller = new AbortController();
  requests = [];
  responseDelayMs = 0;
  warn = vi.fn();
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
  for await (const comment of new NicoClient('lv1', { logger: { warn } }).streamComments(
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
  expect(warn).not.toHaveBeenCalled();
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

// 欠落の回復では番組ページも取り直す。その入口だけを差し替えて再取得回数を数える。
function allowPageRefresh() {
  return vi.spyOn(NicoClient.prototype as any, 'fetchProgramInfo').mockResolvedValue(info);
}

test.each(['停滞', '欠落', '交互'])(
  '取得位置の%sが続く間だけ一度警告し、回復待ちは継続する',
  async (kind) => {
    allowPageRefresh();
    respond = async (index) => {
      if (kind === '欠落' || (kind === '交互' && index % 2 === 1)) return [];
      return [{ next: { at: 100 } }];
    };
    const task = consume();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(450_000);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'コメントの取得位置の異常が続いています。取得間隔をあけて回復を待っています。',
    );
    controller.abort();
    await expect(task).resolves.toEqual([]);
  },
);

test('取得位置が前進すれば、次に異常が続いたときに再び一度警告する', async () => {
  respond = async (index) => {
    if (index === 39) controller.abort();
    return [{ next: { at: 100 + Math.floor(index / 20) } }];
  };
  const task = consume();
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  await task;
  expect(warn).toHaveBeenCalledTimes(2);
});

test.each([
  { label: 'next欠落', entries: [] },
  { label: '安全な整数範囲を超えるnext', entries: [{ next: { at: '9223372036854775807' } }] },
])('$label は再取得を待機し、10分以上回復しなければ停止する', async ({ entries }) => {
  const page = allowPageRefresh();
  const socket = vi.spyOn(NicoClient.prototype as any, 'openViewSocket');
  respond = async () => entries;
  const checked = expect(consume()).rejects.toBeInstanceOf(CommentViewMarkerMissingError);
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  await checked;
  expect(requests).toHaveLength(25);
  expect(requests.slice(0, 8).map((r) => r.time)).toEqual([
    0, 1000, 3000, 7000, 15000, 31000, 61000, 91000,
  ]);
  expect(requests.at(-1)!.time).toBeGreaterThanOrEqual(600_000);
  expect(page).toHaveBeenCalledTimes(24);
  expect(socket).toHaveBeenCalledTimes(25);
  expect(isRetryableNicoError(new CommentViewMarkerMissingError())).toBe(false);
});

test('next欠落も10回を超えただけでは諦めず、10分待つ', async () => {
  allowPageRefresh();
  const task = consume();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(requests.length).toBeGreaterThan(10);
  controller.abort();
  await expect(task).resolves.toEqual([]);
});

test('next欠落も10分を超えただけでは諦めず、10回まで待つ', async () => {
  allowPageRefresh();
  responseDelayMs = 120_000;
  const task = consume();
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  controller.abort();
  await vi.advanceTimersByTimeAsync(120_000);
  await expect(task).resolves.toEqual([]);
  expect(requests.length).toBeLessThan(10);
});

test('取得位置が前進すれば欠落回数・時刻・バックオフを戻す', async () => {
  allowPageRefresh();
  respond = async (index) => {
    if (index === 59) controller.abort();
    if (index % 20 === 19) return [{ next: { at: 100 + index } }];
    return [];
  };
  const task = consume();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  await expect(task).resolves.toEqual([]);
  expect(requests).toHaveLength(60);
  expect(requests[21].time - requests[20].time).toBe(1000);
  expect(requests.at(-1)!.time).toBeGreaterThan(10 * 60_000);
});

test('欠落と古いnextを交互に返しても回復扱いにせず停止する', async () => {
  allowPageRefresh();
  respond = async (index) => (index % 2 === 0 ? [{ next: { at: 100 } }] : []);
  const checked = expect(consume()).rejects.toHaveProperty(
    'code',
    expect.stringMatching(/^COMMENT_VIEW_(STALLED|MARKER_MISSING)$/),
  );
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  await checked;
  expect(requests.length).toBeLessThan(60);
});

test.each([500, 100_000])(
  '欠落回復の待機中（%sms）に停止したらページ・接続を取り直さない',
  async (at) => {
    const page = allowPageRefresh();
    const socket = vi.spyOn(NicoClient.prototype as any, 'openViewSocket');
    const task = consume();
    await vi.advanceTimersByTimeAsync(at);
    const counts = [requests.length, page.mock.calls.length, socket.mock.calls.length];
    controller.abort();
    await task;
    await vi.advanceTimersByTimeAsync(60_000);
    expect([requests.length, page.mock.calls.length, socket.mock.calls.length]).toEqual(counts);
  },
);

test('欠落回復で番組終了が判明したら再接続せず正常終了する', async () => {
  const page = allowPageRefresh();
  page.mockResolvedValue({ ...info, status: NicoLiveProgramStatus.ended });
  const socket = vi.spyOn(NicoClient.prototype as any, 'openViewSocket');
  const task = consume();
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(task).resolves.toEqual([]);
  expect(page).toHaveBeenCalledTimes(1);
  expect(socket).toHaveBeenCalledTimes(1);
});
