import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { brotliCompressSync } from 'node:zlib';
import { WebSocketServer } from 'ws';

/** Node と Electron main の両方で、差し替えていない通信 API を同じ入力で確認する。 */
export async function verifyHttpRecovery() {
  const controller = new AbortController();
  const server = createServer((request, response) => {
    if (request.url === '/invalid') {
      response.writeHead(200, { 'content-encoding': 'gzip, gzip, gzip, gzip, gzip, gzip' });
      response.end('invalid compressed body');
    } else if (request.url === '/truncated') {
      response.writeHead(200, { 'content-length': '100' });
      response.write('partial');
      setImmediate(() => response.destroy());
    } else if (request.url === '/abort') {
      // 要求がサーバーへ届いた時点で中断する。実時間の待機に依存しない。
      controller.abort();
    } else {
      response.writeHead(200, { 'content-encoding': 'br' });
      response.end(brotliCompressSync(Buffer.from('録画を続けられます')));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['invalid', 'truncated', 'abort']) {
      // ヘッダー受信前・本文消費中のどちらで失敗しても、後続通信の回復を確認する。
      const signal = route === 'abort' ? controller.signal : AbortSignal.timeout(5000);
      await assert.rejects(async () => {
        const response = await fetch(`${origin}/${route}`, { signal });
        await response.text();
      });
      if (route !== 'abort')
        assert.equal(signal.aborted, false, `${route}: timeout is not recovery`);
      const response = await fetch(`${origin}/healthy`, { signal: AbortSignal.timeout(5000) });
      assert.equal(await response.text(), '録画を続けられます');
    }
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

/** 内蔵 WebSocket と ws の双方で、制御フレームと切断後の新規接続を確認する。 */
export async function verifyWebSocketRecovery(WebSocketImpl) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const origin = `ws://127.0.0.1:${server.address().port}`;
  let connections = 0;
  let socket;
  server.on('connection', (peer) => {
    connections += 1;
    peer.on('message', (data) => peer.send(data.toString()));
    peer.on('pong', (data) => {
      assert.equal(data.toString(), 'keepalive');
      // PONG の受信後に異常切断し、クライアントの close 通知まで待つ。
      peer.terminate();
    });
  });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const connected = once(server, 'connection');
      socket = new WebSocketImpl(origin);
      await once(socket, 'open');
      const [peer] = await connected;
      const received = once(socket, 'message');
      socket.send('日本語の通知');
      const [message] = await received;
      assert.equal(String(message.data ?? message), '日本語の通知');
      const closed = once(socket, 'close');
      peer.ping('keepalive');
      await closed;
    }
    assert.equal(connections, 2);
  } finally {
    socket?.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
