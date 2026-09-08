import { parseStreamMessage } from '../../../src/main/core/nico/watch-protocol';

const completeCookies = [
  {
    name: 'session',
    value: 'a',
    domain: 'example.test',
    path: '/a',
    secure: true,
    expires: 'date',
  },
  { name: 'session', value: 'b', domain: 'example.test', path: '/b' },
];
const data = {
  protocol: 'hls',
  uri: 'https://example.test/master',
  quality: 720,
  syncUri: 'https://example.test/sync',
  availableQualities: [720, null, 'abr'],
  cookies: [
    ...completeCookies,
    { name: 'fallback', value: 42 },
    { name: 'boolean', value: true, domain: false, path: 2 },
    null,
    {},
    'bad',
    1,
  ],
};

// 欠落値の補完を統一すると既存の認証条件が変わるため、両方の旧仕様を固定する。
test('ライブのCookie補完・文字列変換と追加情報を維持する', () => {
  const result = parseStreamMessage(data, 'live')!;
  expect(result).toMatchObject({
    quality: '720',
    syncUri: data.syncUri,
    availableQualities: ['720', 'null', 'abr'],
  });
  expect(result.cookies).toStrictEqual([
    completeCookies[0],
    { ...completeCookies[1], secure: false, expires: undefined },
    {
      name: 'fallback',
      value: '42',
      domain: 'nicovideo.jp',
      path: '/',
      secure: false,
      expires: undefined,
    },
    {
      name: 'boolean',
      value: 'true',
      domain: 'false',
      path: '2',
      secure: false,
      expires: undefined,
    },
  ]);
  expect(result.receivedAt).toBeInstanceOf(Date);
});

test('タイムシフトは完全なCookieだけを採用し、同名の別パスを保つ', () => {
  const result = parseStreamMessage(data, 'timeshift')!;
  expect(result).toMatchObject({ quality: '', availableQualities: [] });
  expect(result).not.toHaveProperty('syncUri');
  expect(result.cookies).toStrictEqual([
    { name: 'session', value: 'a', domain: 'example.test', path: '/a' },
    { name: 'session', value: 'b', domain: 'example.test', path: '/b' },
  ]);
  expect(data.cookies[0]).toEqual(completeCookies[0]);
});

test.each(['live', 'timeshift'] as const)(
  '%s: HLS以外・URI型違いは採用せず、空文字URIは従来どおり扱う',
  (policy) => {
    expect(parseStreamMessage({ protocol: 'other', uri: 'url' }, policy)).toBeUndefined();
    expect(parseStreamMessage({ protocol: 'hls', uri: 1 }, policy)).toBeUndefined();
    expect(parseStreamMessage({}, policy)).toBeUndefined();
    expect(parseStreamMessage({ protocol: 'hls', uri: '', cookies: null }, policy)).toMatchObject({
      uri: '',
      cookies: [],
      quality: '',
      availableQualities: [],
    });
  },
);

test.each(['live', 'timeshift'] as const)(
  '%s: 正常な画質文字列とCookie配列の欠落を扱う',
  (policy) => {
    const result = parseStreamMessage(
      { protocol: 'hls', uri: 'url', quality: 'abr', cookies: { name: 'not-array' } },
      policy,
    );
    expect(result).toMatchObject({ quality: 'abr', cookies: [], availableQualities: [] });
  },
);
