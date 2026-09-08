import {
  fetchTimeshiftBytes,
  retryTimeshiftRequest,
} from '../../../src/main/core/nico/timeshift-http';

// node:timers/promisesの待機も仮想時計へ接続し、実時間を待たず期限・中断を検証する。
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, _value: unknown, { signal }: { signal: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const options = { maxBytes: 100, limitCode: 'LIMIT' };

// 本文を任意の間隔で届け、停止も実際のfetchと同じように本文へ伝える。
function body() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), {
                once: true,
              });
            },
          }),
        ),
    ),
  );
  return { send: () => stream.enqueue(Buffer.from('a')), end: () => stream.close() };
}

test('合計30秒を超えても本文の受信が進んでいれば保存する', async () => {
  const source = body();
  const pending = fetchTimeshiftBytes(
    'https://example.test/media',
    new AbortController().signal,
    options,
  );
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(10_000);
    source.send();
  }
  source.end();
  expect((await pending).toString()).toBe('aaaa');
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['header', 'body', 'stop'] as const)('%s待機の期限・利用者停止を守る', async (phase) => {
  const stop = new AbortController();
  if (phase === 'header')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    );
  else body();
  const pending = fetchTimeshiftBytes('https://example.test/media', stop.signal, options);
  const rejected = expect(pending).rejects.toMatchObject({
    name: phase === 'stop' ? 'AbortError' : 'TimeoutError',
  });
  await vi.advanceTimersByTimeAsync(1);
  if (phase === 'stop') stop.abort();
  else await vi.advanceTimersByTimeAsync(20_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

test.each([403, 404, 429, 503, undefined])(
  'HTTP %sで再試行対象と回数上限を守る',
  async (status) => {
    const { TimeshiftError } = await import('../../../src/main/core/nico/timeshift-common');
    const attempt = vi.fn(async () => {
      throw new TimeshiftError(status ? 'HTTP_ERROR' : 'LIMIT', status);
    });
    const pending = retryTimeshiftRequest(attempt, new AbortController().signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(TimeshiftError);
    await vi.advanceTimersByTimeAsync(3500);
    await rejected;
    expect(attempt).toHaveBeenCalledTimes(status === 429 || status === 503 ? 4 : 1);
  },
);

test('バックオフ中の停止で次のリクエストを開始しない', async () => {
  const stop = new AbortController();
  const attempt = vi.fn(async () => {
    throw new TypeError('network');
  });
  const pending = retryTimeshiftRequest(attempt, stop.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1);
  stop.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(attempt).toHaveBeenCalledOnce();
});
