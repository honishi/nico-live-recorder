import fs from 'node:fs';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { NicoClient, ProgramNotFoundError } from '../../../src/main/vendor/nico-client/NicoClient';
import { HttpError } from '../../../src/main/vendor/nico-client/internal/httpClient';
import { NicoLiveProgramStatus } from '../../../src/main/vendor/nico-client/types';

const html = fs.readFileSync(new URL('../../fixtures/nico/watch.html', import.meta.url), 'utf8');
const originalDispatcher = getGlobalDispatcher();
let agent: MockAgent;
beforeEach(() => {
  // HTTP の出口だけを差し替え、HttpClient・CookieJar・Cheerio は本体を通す。
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await agent.close();
});

function serve(body: string, status = 200): NicoClient {
  agent
    .get('https://live.nicovideo.jp')
    .intercept({
      path: '/watch/lv42',
      method: 'GET',
      headers: { cookie: 'user_session=dummy' },
    })
    .reply(status, body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  return new NicoClient('lv42', { cookies: { user_session: 'dummy' } });
}

test('固定HTMLから文字参照・日本語・番組情報・視聴URLを読み取る', async () => {
  const info = await serve(html).getProgramInfo();
  expect(info).toMatchObject({
    nicoliveProgramId: 'lv42',
    title: '日本語 & "引用" 🎵',
    description: '<p>番組説明</p>',
    providerId: '123',
    providerName: '配信者',
    providerLevel: 12,
    supplierIntroduction: '自己紹介',
    status: NicoLiveProgramStatus.onAir,
    beginTime: 1700000000,
    endTime: 1700000600,
    webSocketUrl: 'ws://127.0.0.1:1/watch?token=dummy&quality=high',
    thumbnailUrl: 'https://example.test/large.jpg',
    middleScreenshotUrl: 'https://example.test/middle.jpg',
    openGraphImageUrl: 'https://example.test/og.jpg?a=1&b=2',
    hasTimeshift: true,
    commentCount: 42,
    watchCount: 100,
  });
  agent.assertNoPendingInterceptors();
});

test.each([
  ['ENDED', NicoLiveProgramStatus.ended],
  ['RELEASED', NicoLiveProgramStatus.released],
  ['UNKNOWN_NEW_STATE', NicoLiveProgramStatus.unknown],
])('番組状態 %s を解釈する', async (raw, status) => {
  expect((await serve(html.replace('ON_AIR', raw)).getProgramInfo()).status).toBe(status);
});

test('終了済みで視聴URLがなくてもタイムシフトの番組情報を返す', async () => {
  const body =
    '<script id="embedded-data" data-props=\'{"program":{"nicoliveProgramId":"lv42","status":"ENDED"},"site":{"relive":{}},"programTimeshift":{"publication":{"status":"Open"}}}\'></script>';
  expect(await serve(body).getProgramInfo()).toMatchObject({
    status: NicoLiveProgramStatus.ended,
    hasTimeshift: true,
    webSocketUrl: undefined,
  });
});

test('任意項目の欠落と旧supplier.idを扱い、Twitter画像へフォールバックする', async () => {
  const body =
    '<meta name="twitter:image" content=" https://example.test/fallback.jpg "><script id="embedded-data" data-props=\'{"program":{"nicoliveProgramId":"lv42","supplier":{"id":"456"}},"site":{"relive":{}}}\'></script>';
  expect(await serve(body).getProgramInfo()).toMatchObject({
    title: '',
    providerId: '456',
    status: NicoLiveProgramStatus.unknown,
    openGraphImageUrl: 'https://example.test/fallback.jpg',
    thumbnailUrl: undefined,
    hasTimeshift: false,
    commentCount: 0,
    watchCount: 0,
  });
});

test.each([
  ['<html>ログイン画面</html>', 'data-props'],
  ['<script id="embedded-data" data-props="{}"></script>', '番組情報の解析'],
])('解析できないHTMLを録画可能な番組として返さない: %s', async (body, reason) => {
  await expect(serve(body).getProgramInfo()).rejects.toThrow(reason);
});

test('壊れた埋め込みJSONを成功扱いしない', async () => {
  await expect(
    serve('<script id="embedded-data" data-props="{invalid}"></script>').getProgramInfo(),
  ).rejects.toBeInstanceOf(SyntaxError);
});

test.each([403, 404, 503])('HTTP %i をHTML解析エラーと区別する', async (status) => {
  const task = serve('取得不可', status).getProgramInfo();
  await expect(task).rejects.toBeInstanceOf(status === 404 ? ProgramNotFoundError : HttpError);
  await expect(task).rejects.toMatchObject({ statusCode: status });
});
