import { UpdateChecker } from '../../src/main/app/update-checker';
import { silentLogger } from '../../src/main/core/logger';

const releaseResponse = (tag = 'v0.2.0', extra: Record<string, unknown> = {}): Response =>
  Response.json({ tag_name: tag, draft: false, prerelease: false, ...extra });

describe('UpdateChecker', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let checker: UpdateChecker;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    checker = new UpdateChecker('0.1.0', silentLogger);
  });

  afterEach(() => {
    checker.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('認証なしで確認し、固定リポジトリの更新ページだけを案内する', async () => {
    fetchMock.mockResolvedValue(releaseResponse('v0.2.0', { html_url: 'https://example.com' }));
    const status = await checker.check();
    expect(status).toMatchObject({
      checking: false,
      result: 'available',
      release: {
        version: '0.2.0',
        url: 'https://github.com/honishi/nico-live-recorder/releases/tag/v0.2.0',
      },
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/honishi/nico-live-recorder/releases/latest');
    expect(options?.credentials).toBe('omit');
    const headers = new Headers(options?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
  });

  test.each([
    ['0.9.0', 'v0.10.0', 'available'],
    ['1.0.0', 'v1.0.0', 'current'],
    ['2.0.0', 'v1.9.9', 'current'],
    ['1.0.0-beta.1', 'v1.0.0', 'available'],
    ['1.0.0+local', 'v1.0.0+release', 'current'],
  ])('バージョン %s と %s を文字列順ではなく比較する', async (current, tag, expected) => {
    checker = new UpdateChecker(current, silentLogger);
    fetchMock.mockResolvedValue(releaseResponse(tag));
    expect((await checker.check()).result).toBe(expected);
  });

  test.each([
    ['v0.2.0', { draft: true }],
    ['v0.2.0', { prerelease: true }],
    ['v0.2.0-beta.1', {}],
  ])('下書き・プレリリースを通知しない (%s, %j)', async (tag, extra) => {
    fetchMock.mockResolvedValue(releaseResponse(tag, extra));
    expect(await checker.check()).toMatchObject({ result: 'unavailable', release: undefined });
  });

  test('非公開時の 404 を更新なしと扱わず、公開後の再確認で更新を検知する', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await checker.check()).result).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(60_000);
    fetchMock.mockResolvedValueOnce(releaseResponse());
    expect((await checker.check()).result).toBe('available');
  });

  test('確認中の呼び出しをまとめ、直後の連打も再取得しない', async () => {
    fetchMock.mockResolvedValueOnce(releaseResponse());
    const pending = checker.check();
    expect(checker.getStatus().checking).toBe(true);
    expect(checker.check()).toBe(pending);
    await pending;
    await checker.check();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([403, 429])('HTTP %s は解除時刻まで再確認を抑える', async (status) => {
    const resetAt = Date.now() + 2 * 60 * 60 * 1000;
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status,
        headers: { 'retry-after': '3600', 'x-ratelimit-reset': String(resetAt / 1000) },
      }),
    );
    expect(await checker.check()).toMatchObject({ result: 'rate-limited', nextCheckAt: resetAt });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await checker.check();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    fetchMock.mockResolvedValueOnce(releaseResponse());
    expect((await checker.check()).result).toBe('available');
  });

  test.each([
    () => Promise.reject(new Error('offline')),
    () => Promise.resolve(new Response(null, { status: 500 })),
    () => Promise.resolve(new Response('{broken')),
    () => Promise.resolve(releaseResponse('not-a-version')),
    () => Promise.resolve(Response.json({ tag_name: 'v0.2.0' })),
  ])('通信失敗や不正な応答で reject せず、既知の更新は保持する', async (response) => {
    fetchMock.mockResolvedValueOnce(releaseResponse());
    const previous = await checker.check();
    await vi.advanceTimersByTimeAsync(60_000);
    fetchMock.mockImplementationOnce(response);
    await expect(checker.check()).resolves.toMatchObject({
      checking: false,
      result: 'error',
      release: previous.release,
    });
  });

  test('応答が来ない場合は 10 秒で中断し、次回の確認は回復できる', async () => {
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = checker.check();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toMatchObject({ checking: false, result: 'error' });
    await vi.advanceTimersByTimeAsync(60_000);
    fetchMock.mockResolvedValueOnce(releaseResponse());
    expect((await checker.check()).result).toBe('available');
  });

  test('起動時と 6 時間ごとに確認し、終了後は確認しない', async () => {
    fetchMock.mockImplementation(async () => releaseResponse());
    checker.start();
    checker.start();
    await checker.check();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    checker.stop();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    await checker.check();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('終了時に通信を中断し、終了後の状態通知を行わない', async () => {
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const changed = vi.fn();
    checker.on('change', changed);
    const pending = checker.check();
    checker.stop();
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
