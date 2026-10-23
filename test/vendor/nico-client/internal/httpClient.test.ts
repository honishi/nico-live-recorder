import type { ServerResponse } from 'node:http';
import { brotliCompressSync, deflateSync, gzipSync, constants } from 'node:zlib';
import {
  CookieJar,
  HttpClient,
  HttpError,
} from '../../../../src/main/vendor/nico-client/internal/httpClient';
import { startFakeHttp } from '../../../helpers/fake-http';

const text = '日本語のコメント 🎵\n次の行';
const encodings = [
  { name: undefined, encode: (value: string) => Buffer.from(value) },
  { name: 'identity', encode: (value: string) => Buffer.from(value) },
  { name: 'gzip', encode: gzipSync },
  { name: 'br', encode: brotliCompressSync },
  { name: 'deflate', encode: deflateSync },
];
// 通信イベントの順序を同期し、OS の速度や固定秒数の待機に依存させない。
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let server: Awaited<ReturnType<typeof startFakeHttp>>;
let cookies: CookieJar;
let client: HttpClient;

beforeEach(() => {
  cookies = new CookieJar({ user_session: 'test-session' });
  client = new HttpClient('nlr-contract-test', cookies);
});
afterEach(async () => {
  await server?.close();
});

async function readStream(url: string, signal?: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of client.stream(url, { signal })) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// fetch の自動展開とは別に、undici.request の本文を本体の処理で展開する。
describe.each(encodings)('圧縮形式 $name', ({ name, encode }) => {
  test.each(['text', 'stream'] as const)('%s で UTF-8 本文を欠落なく取得する', async (mode) => {
    const body = encode(text);
    server = await startFakeHttp((_request, response) => {
      if (name) response.setHeader('content-encoding', name);
      // 送信側の分割と文字境界に依存しないことを確認する。
      for (let offset = 0; offset < body.length; offset += 3)
        response.write(body.subarray(offset, offset + 3));
      response.end();
    });
    expect(await (mode === 'text' ? client.getText(server.url) : readStream(server.url))).toBe(
      text,
    );
  });
});

test('複数の Set-Cookie を解析し、リダイレクト先と次の要求に引き継ぐ', async () => {
  const received: (string | undefined)[] = [];
  server = await startFakeHttp((request, response) => {
    received.push(request.headers.cookie);
    if (request.url === '/start') {
      response.writeHead(302, {
        location: './next',
        'set-cookie': [
          'user_session=renewed; Path=/; HttpOnly; Secure',
          'token=a%2Fb%3D; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/',
          'empty=; Path=/',
        ],
      });
      response.end('redirect body');
    } else response.end('ok');
  });
  expect(await client.getText(`${server.url}/start`)).toBe('ok');
  expect(await client.getText(`${server.url}/next`)).toBe('ok');
  expect(received).toEqual([
    'user_session=test-session',
    'user_session=renewed; token=a/b=; empty=',
    'user_session=renewed; token=a/b=; empty=',
  ]);
});

test.each([301, 302, 303, 307, 308])(
  'HTTP %i の POST リダイレクトでメソッドと本文を扱う',
  async (status) => {
    const received: { method: string | undefined; body: string; type: string | undefined }[] = [];
    server = await startFakeHttp(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        method: request.method,
        body: Buffer.concat(chunks).toString(),
        type: request.headers['content-type'],
      });
      if (request.url === '/start') response.writeHead(status, { location: '/end' });
      response.end('ok');
    });
    const result = await client.post(`${server.url}/start`, {
      body: new URLSearchParams({ title: 'a b&c' }),
    });
    expect(await result.body.text()).toBe('ok');
    expect(received[0]).toEqual({
      method: 'POST',
      body: 'title=a+b%26c',
      type: 'application/x-www-form-urlencoded',
    });
    expect(received[1]).toMatchObject(
      status >= 307 ? { method: 'POST', body: 'title=a+b%26c' } : { method: 'GET', body: '' },
    );
  },
);

test('リダイレクト上限で止まり、その後の通信は成功する', async () => {
  let redirects = 0;
  server = await startFakeHttp((request, response) => {
    if (request.url === '/loop') {
      redirects++;
      response.writeHead(302, { location: '/loop' });
    }
    response.end('ok');
  });
  await expect(client.request('GET', `${server.url}/loop`, {}, 2)).rejects.toMatchObject({
    statusCode: 302,
    responseBody: 'Too many redirects',
  });
  expect(redirects).toBe(3);
  expect(await client.getText(`${server.url}/healthy`)).toBe('ok');
});

test('追加ヘッダーと Cookie を実際の要求に載せる', async () => {
  let headers;
  server = await startFakeHttp((request, response) => {
    headers = request.headers;
    response.end('ok');
  });
  await client.getText(server.url, { headers: { accept: 'application/json', 'x-test': 'custom' } });
  expect(headers).toMatchObject({
    'user-agent': 'nlr-contract-test',
    cookie: 'user_session=test-session',
    accept: 'application/json',
    'x-test': 'custom',
    'accept-encoding': 'gzip, deflate, br',
  });
});

test.each(['text', 'stream', 'post'] as const)(
  '%s の HTTP エラーに展開済み本文と URL を残す',
  async (mode) => {
    server = await startFakeHttp((_request, response) => {
      response.writeHead(403, { 'content-encoding': 'gzip' });
      response.end(gzipSync(text));
    });
    const url = `${server.url}/denied`;
    const requests = {
      text: () => client.getText(url),
      post: () => client.post(url),
      stream: () => readStream(url),
    };
    const task = requests[mode]();
    await expect(task).rejects.toBeInstanceOf(HttpError);
    await expect(task).rejects.toMatchObject({ statusCode: 403, responseBody: text, url });
  },
);

test.each(['abort', 'disconnect'] as const)(
  '本文を全取得する getText も %s で終了し、次の通信を続けられる',
  async (action) => {
    const received = deferred<ServerResponse>();
    server = await startFakeHttp((request, response) => {
      if (request.url === '/healthy') return void response.end('ok');
      response.writeHead(200, { 'content-length': '1000' });
      response.write('partial');
      received.resolve(response);
    });
    const controller = new AbortController();
    const rejected = expect(
      client.getText(server.url, { signal: controller.signal }),
    ).rejects.toThrow();
    const response = await received.promise;
    if (action === 'abort') controller.abort();
    else response.destroy();
    await rejected;
    expect(await client.getText(`${server.url}/healthy`)).toBe('ok');
  },
);

// 実時間の待機ではなく、要求・本文の到着を合図に切断と中断を発生させる。
test.each(['text', 'stream'] as const)(
  '%s のヘッダー待機を abort し、次の通信を続けられる',
  async (mode) => {
    const received = deferred<void>();
    const closed = deferred<void>();
    server = await startFakeHttp((request, response) => {
      if (request.url === '/healthy') return void response.end('ok');
      response.on('close', () => closed.resolve());
      received.resolve();
    });
    const controller = new AbortController();
    const task =
      mode === 'text'
        ? client.getText(server.url, { signal: controller.signal })
        : readStream(server.url, controller.signal);
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await received.promise;
    controller.abort();
    await rejected;
    await closed.promise;
    expect(await client.getText(`${server.url}/healthy`)).toBe('ok');
  },
);

test.each(['abort', 'disconnect', 'break'] as const)(
  '圧縮ストリームの %s で接続を解放する',
  async (action) => {
    const closed = deferred<void>();
    let activeResponse: ServerResponse;
    server = await startFakeHttp((request, response) => {
      if (request.url === '/healthy') return void response.end('ok');
      activeResponse = response;
      response.on('close', () => closed.resolve());
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.write(gzipSync('first', { finishFlush: constants.Z_SYNC_FLUSH }));
    });
    const controller = new AbortController();
    const iterator = client.stream(server.url, { signal: controller.signal });
    expect(Buffer.from((await iterator.next()).value!).toString()).toBe('first');
    if (action === 'break') {
      // for-await の途中離脱と同じ return を呼び、未完の本文を読み続けないことを確認する。
      await iterator.return();
    } else {
      const rejected = expect(iterator.next()).rejects.toThrow();
      if (action === 'abort') controller.abort();
      else activeResponse!.destroy();
      await rejected;
    }
    await closed.promise;
    expect(await client.getText(`${server.url}/healthy`)).toBe('ok');
  },
);

test('壊れた gzip は stream 消費側へエラーを伝播し、次の通信を続けられる', async () => {
  server = await startFakeHttp((request, response) => {
    if (request.url === '/healthy') return void response.end('ok');
    response.writeHead(200, { 'content-encoding': 'gzip' });
    response.end('not gzip');
  });
  await expect(readStream(server.url)).rejects.toThrow();
  expect(await client.getText(`${server.url}/healthy`)).toBe('ok');
});
