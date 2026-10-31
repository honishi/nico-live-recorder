import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { WebSocketServer } from 'ws';

/** 信頼設定と全ソケットを各検査で隔離し、失敗時にも元に戻す。 */
async function withTlsServers(run) {
  const fixture = (name) =>
    readFile(new URL(`../fixtures/tls/${name}.pem`, import.meta.url), 'utf8');
  const [ca, key, cert, untrusted] = await Promise.all(
    ['ca', 'server-key', 'server', 'untrusted'].map(fixture),
  );
  const previous = getCACertificates('default');
  const sockets = new Set();
  const servers = [];
  const websockets = [];
  async function listen(server) {
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `127.0.0.1:${server.address().port}`;
  }
  try {
    // 証明書検証は有効なまま、このスレッドだけにテストCAを追加する。
    setDefaultCACertificates([...previous, ca]);
    const secure = createHttpsServer({ key, cert });
    const rejected = createHttpsServer({ key, cert: untrusted });
    let rejectedRequests = 0;
    rejected.on('request', (_request, response) => {
      rejectedRequests += 1;
      response.end('unexpected trusted request');
    });
    // TLS ClientHelloを実際に受けてから切る。接続拒否や待機時間で代用しない。
    let handshakes = 0;
    const broken = createTcpServer((socket) => {
      socket.once('data', () => {
        handshakes += 1;
        socket.destroy();
      });
    });
    const trustedHost = await listen(secure);
    const untrustedHost = await listen(rejected);
    const brokenHost = await listen(broken);
    await run({
      secure,
      trustedHost,
      untrustedHost,
      brokenHost,
      rejectedRequests: () => rejectedRequests,
      handshakes: () => handshakes,
      websocketServer(server) {
        const ws = new WebSocketServer({ server });
        websockets.push(ws);
        return ws;
      },
      rejected,
    });
  } finally {
    for (const ws of websockets) {
      for (const peer of ws.clients) peer.terminate();
      ws.close();
    }
    const closed = servers.map((server) => new Promise((resolve) => server.close(resolve)));
    for (const socket of sockets) socket.destroy();
    setDefaultCACertificates(previous);
    await Promise.all(closed);
  }
}

/** 内蔵fetchのTLS拒否・接続中の切断・応答待ち中断と、その後の正常通信を確認する。 */
export async function verifyHttpsRecovery() {
  await withTlsServers(async (h) => {
    const controller = new AbortController();
    h.secure.on('request', (request, response) => {
      if (request.url === '/abort') controller.abort();
      else if (request.url === '/truncated') {
        response.writeHead(200, { 'content-length': '100' });
        response.write('partial');
        setImmediate(() => response.destroy());
      } else response.end('TLS通信を再開');
    });
    async function healthy() {
      const response = await fetch(`https://${h.trustedHost}/healthy`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(await response.text(), 'TLS通信を再開');
    }
    await healthy();
    for (const [host, route, expectedCode] of [
      [h.untrustedHost, '/certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
      [h.brokenHost, '/handshake', 'ECONNRESET'],
      [h.trustedHost, '/truncated', 'UND_ERR_SOCKET'],
      [h.trustedHost, '/abort', undefined],
    ]) {
      const timeout = AbortSignal.timeout(5000);
      const signal = route === '/abort' ? AbortSignal.any([timeout, controller.signal]) : timeout;
      await assert.rejects(
        async () => {
          const response = await fetch(`https://${host}${route}`, { signal });
          await response.text();
        },
        (error) =>
          expectedCode ? error.cause?.code === expectedCode : error.name === 'AbortError',
      );
      assert.equal(timeout.aborted, false, `${route}: timeout is not recovery`);
      await healthy();
    }
    assert.equal(h.rejectedRequests(), 0);
    assert.ok(h.handshakes() > 0);
  });
}

/** native/wsで共通のEventTarget APIを使い、接続失敗と正常な暗号通信を確認する。 */
export async function verifyWssRecovery(WebSocketImpl) {
  await withTlsServers(async (h) => {
    const trusted = h.websocketServer(h.secure);
    const untrusted = h.websocketServer(h.rejected);
    let rejectedConnections = 0;
    let pongs = 0;
    untrusted.on('connection', (peer) => {
      rejectedConnections += 1;
      peer.close();
    });
    trusted.on('connection', (peer) => {
      peer.on('message', (data) => peer.send(data.toString()));
      peer.on('pong', () => {
        pongs += 1;
        peer.terminate();
      });
    });
    async function connection(host, fails) {
      const socket = new WebSocketImpl(`wss://${host}`);
      let opened = false;
      let errored = false;
      let echoed = false;
      const previousPongs = pongs;
      socket.addEventListener('open', () => {
        opened = true;
      });
      socket.addEventListener('error', () => {
        errored = true;
      });
      // errorでは終えずcloseまで確認する。診断用タイムアウトを成功条件にはしない。
      const closed = new Promise((resolve, reject) => {
        const signal = AbortSignal.timeout(5000);
        const timeout = () => reject(new Error(`WSS close timed out: ${host}`));
        signal.addEventListener('abort', timeout, { once: true });
        socket.addEventListener(
          'close',
          (event) => {
            signal.removeEventListener('abort', timeout);
            resolve(event.code);
          },
          { once: true },
        );
      });
      if (!fails) {
        socket.addEventListener('open', () => socket.send('TLS通知'));
        socket.addEventListener('message', (event) => {
          // wsもnativeも文字列で受け取るよう、サーバーはtextフレームを返す。
          if (event.data !== 'TLS通知') socket.close(1000, 'unexpected payload');
          else {
            echoed = true;
            for (const peer of trusted.clients) peer.ping('keepalive');
          }
        });
      }
      const code = await closed;
      assert.equal(opened, !fails, 'certificate/handshake failure must not open');
      // nativeは接続後の強制切断にもerrorを出す。拒否時はerror必須、成功時はechoとPONGで判定する。
      if (fails) assert.equal(errored, true);
      assert.equal(echoed, !fails);
      assert.equal(pongs - previousPongs, fails ? 0 : 1);
      assert.equal(code, 1006, 'TLS socket termination must be an abnormal close');
    }
    // 各失敗後に新しいWSS接続でechoとPING/PONGまで通し、回復を確認する。
    await connection(h.trustedHost, false);
    for (const host of [h.untrustedHost, h.brokenHost]) {
      await connection(host, true);
      await connection(h.trustedHost, false);
    }
    assert.equal(rejectedConnections, 0);
    assert.ok(h.handshakes() > 0);
  });
}
