import {
  checkFollowing,
  parseUserIdInput,
  resolveUserNickname,
} from '../../src/main/app/nico-user';
import { ERROR_CODES, parseErrorCode } from '../../src/shared/types';

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
});
