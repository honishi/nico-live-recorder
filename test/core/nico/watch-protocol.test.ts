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

  expect(
    parseStreamMessage({ protocol: 'hls', uri: 'url', quality: 'abr', cookies: null }, 'live'),
  ).toMatchObject({ quality: 'abr', cookies: [] });
});

test('タイムシフトは完全なCookieだけを採用し、同名の別パスを保つ', () => {
  const result = parseStreamMessage(data, 'timeshift')!;
  expect(result).toMatchObject({ quality: '', availableQualities: [] });
  expect(result).not.toHaveProperty('syncUri');
  expect(result.cookies).toStrictEqual([
    { name: 'session', value: 'a', domain: 'example.test', path: '/a' },
    { name: 'session', value: 'b', domain: 'example.test', path: '/b' },
  ]);

  expect(
    parseStreamMessage({ protocol: 'hls', uri: 'url', quality: 'abr', cookies: null }, 'timeshift'),
  ).toMatchObject({ quality: 'abr', cookies: [] });
});

test('HLS以外・URI型違い・必須項目欠落は採用しない', () => {
  expect(parseStreamMessage({ protocol: 'other', uri: 'url' }, 'live')).toBeUndefined();
  expect(parseStreamMessage({ protocol: 'hls', uri: 1 }, 'live')).toBeUndefined();
  expect(parseStreamMessage({}, 'live')).toBeUndefined();
});
