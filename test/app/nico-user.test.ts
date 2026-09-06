import {
  checkFollowing,
  parseUserIdInput,
  resolveUserNickname,
} from '../../src/main/app/nico-user';
import { ERROR_CODES, parseErrorCode } from '../../src/shared/types';
import { silentLogger } from '../../src/main/core/logger';

describe('parseUserIdInput', () => {
  test('数字、ユーザーページの URL、user/ID 形式を受け付ける', () => {
    expect(parseUserIdInput(' 12345 ')).toBe('12345');
    expect(parseUserIdInput('https://www.nicovideo.jp/user/12345')).toBe('12345');
    expect(parseUserIdInput('https://www.nicovideo.jp/user/12345/video')).toBe('12345');
    expect(parseUserIdInput('user/777')).toBe('777');
  });

  test('チャンネルやコミュニティ、空文字は対象外', () => {
    expect(parseUserIdInput('')).toBeUndefined();
    expect(parseUserIdInput('co12345')).toBeUndefined();
    expect(parseUserIdInput('https://ch.nicovideo.jp/example')).toBeUndefined();
    expect(parseUserIdInput('lv123')).toBeUndefined();
  });
});

describe('resolveUserNickname / checkFollowing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('ニックネームを返し、404 は USER_NOT_FOUND、他の失敗は NETWORK にする', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { nickname: 'alice' } }))),
    );
    expect(await resolveUserNickname('1')).toBe('alice');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    await expect(resolveUserNickname('1')).rejects.toSatisfy(
      (e: Error) => parseErrorCode(e.message) === ERROR_CODES.userNotFound,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    await expect(resolveUserNickname('1')).rejects.toSatisfy(
      (e: Error) => parseErrorCode(e.message) === ERROR_CODES.network,
    );
  });

  test('フォロー状態は API の following から決め、失敗はすべて unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { following: true } }))),
    );
    expect(await checkFollowing('1', 'user_session=x')).toBe('following');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { following: false } }))),
    );
    expect(await checkFollowing('1', 'user_session=x')).toBe('not-following');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403 })),
    );
    expect(await checkFollowing('1', 'user_session=x')).toBe('unknown');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await checkFollowing('1', 'user_session=x')).toBe('unknown');
  });

  test.each([401, 403, 429, 503])(
    'HTTP %i の理由と Retry-After を debug に記録する',
    async (status) => {
      const logger = {
        ...silentLogger,
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('private-response-body', {
              status,
              headers: { 'retry-after': '60' },
            }),
        ),
      );

      expect(await checkFollowing('123', 'user_session=private-cookie', logger)).toBe('unknown');
      expect(logger.debug).toHaveBeenCalledExactlyOnceWith(
        `[follow] user 123: HTTP ${status}, retry-after=60`,
      );
      // 画面向けのログへ昇格せず、認証情報や応答本文も出さない
      expect(JSON.stringify(logger.debug.mock.calls)).not.toMatch(
        /private-cookie|private-response-body/,
      );
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['private-response-body', 'invalid JSON response'],
    ['{}', 'invalid response (data.following is not boolean)'],
    ['null', 'invalid response (data.following is not boolean)'],
    ['{"data":{"following":"true"}}', 'invalid response (data.following is not boolean)'],
  ])('応答形式の不正を本文を含めずに記録する: %s', async (body, reason) => {
    const logger = { ...silentLogger, debug: vi.fn() };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );

    expect(await checkFollowing('123', 'user_session=x', logger)).toBe('unknown');
    expect(logger.debug).toHaveBeenCalledExactlyOnceWith(`[follow] user 123: ${reason}`);
  });

  test.each([
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    }),
  ])('通信例外の詳細を記録する: %s', async (error) => {
    const logger = { ...silentLogger, debug: vi.fn() };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));

    expect(await checkFollowing('123', 'user_session=x', logger)).toBe('unknown');
    expect(logger.debug).toHaveBeenCalledExactlyOnceWith(
      '[follow] user 123: request failed',
      expect.stringContaining(error.message),
    );
    expect(logger.debug.mock.calls[0][1]).toContain(error.name);
    if (error.cause) {
      expect(logger.debug.mock.calls[0][1]).toContain('ECONNRESET');
    }
  });

  test('応答本文の読み取り中のタイムアウトも通信例外として記録する', async () => {
    const logger = { ...silentLogger, debug: vi.fn() };
    const error = new DOMException('The operation was aborted', 'AbortError');
    const response = new Response();
    vi.spyOn(response, 'json').mockRejectedValue(error);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );

    expect(await checkFollowing('123', 'user_session=x', logger)).toBe('unknown');
    expect(logger.debug).toHaveBeenCalledExactlyOnceWith(
      '[follow] user 123: request failed',
      expect.stringContaining('The operation was aborted'),
    );
    expect(logger.debug.mock.calls[0][1]).toContain('AbortError');
  });

  test.each([true, false])('正常に確認できたときは失敗ログを出さない: %s', async (following) => {
    const logger = { ...silentLogger, debug: vi.fn() };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { following } }))),
    );

    expect(await checkFollowing('123', 'user_session=x', logger)).toBe(
      following ? 'following' : 'not-following',
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
