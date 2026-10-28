import { createServer } from 'node:http';
import { once } from 'node:events';
import { brotliCompressSync } from 'node:zlib';

test('不正な圧縮指定と途中切断を拒否した後も、通常の通信を続けられる', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/invalid') {
      // CVE-2026-109869: 6段の圧縮指定と、不足した本文で内部ストリームがエラーになる。
      response.writeHead(200, {
        'content-encoding': 'gzip, gzip, gzip, gzip, gzip, gzip',
        'content-length': '100',
        connection: 'close',
      });
      response.end();
      return;
    }
    // 正常な Brotli の自動展開も維持する。
    response.writeHead(200, { 'content-encoding': 'br' });
    response.end(brotliCompressSync(Buffer.from('録画を続けられます')));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await expect(fetch(`${url}/invalid`)).rejects.toThrow();
    // 次の応答まで待つことで、catch 後に届く未処理例外もテストの失敗になる。
    const response = await fetch(`${url}/healthy`);
    expect(await response.text()).toBe('録画を続けられます');
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
