import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createSecureServer, constants } from 'node:http2';
import { createServer as createTcpServer } from 'node:net';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { WebSocketServer } from 'ws';

/** 信頼設定と全ソケットを各検査で隔離し、失敗時にも元に戻す。 */
async function withTlsServers(run, http2 = false) {
  const fixture = (name) =>
    readFile(new URL(`../fixtures/tls/${name}.pem`, import.meta.url), 'utf8');
  const [ca, key, cert, untrusted] = await Promise.all(
    ['ca', 'server-key', 'server', 'untrusted'].map(fixture),
  );
  const previous = getCACertificates('default');
  const sockets = new Set();
  const servers = [];
  const websockets = [];
  const sessions = new Set();
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
    const secure = http2
      ? createSecureServer({ key, cert, allowHTTP1: true })
      : createHttpsServer({ key, cert });
    secure.on('session', (session) => {
      sessions.add(session);
      session.once('close', () => sessions.delete(session));
    });
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
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
    setDefaultCACertificates(previous);
    await Promise.all(closed);
  }
}

async function loadUndici() {
  // npm版のロードで内蔵fetchのdispatcherを置き換えない。native側の検査とは分離する。
  void fetch('data:,initialize-native-dispatcher');
  const key = Symbol.for('undici.globalDispatcher.1');
  const native = globalThis[key];
  const undici = await import('undici');
  globalThis[key] = native;
  return undici;
}

/** npm版Agentの既定ALPN設定で、明示的にHTTP/2経路を検査する。 */
export async function verifyUndiciHttp2Recovery() {
  const { request, Agent } = await loadUndici();
  await withTlsServers(async (h) => {
    const dispatcher = new Agent();
    const controller = new AbortController();
    const protocols = [];
    h.secure.on('request', (req, response) => {
      protocols.push(req.httpVersion);
      if (req.httpVersion !== '2.0') {
        response.end('HTTP/2録画通信');
        return;
      }
      // RST_STREAMを実際の応答中に送る。サーバー側の想定内エラーだけを消費する。
      req.stream.on('error', () => {});
      if (req.url === '/reset') {
        response.write('partial');
        setImmediate(() => req.stream.close(constants.NGHTTP2_INTERNAL_ERROR));
      } else if (req.url === '/abort') controller.abort();
      else response.end('HTTP/2録画通信');
    });
    const read = async (host, route, signal) => {
      const response = await request(`https://${host}${route}`, { dispatcher, signal });
      return response.body.text();
    };
    const healthy = async () =>
      assert.equal(
        await read(h.trustedHost, '/healthy', AbortSignal.timeout(5000)),
        'HTTP/2録画通信',
      );
    try {
      await healthy();
      for (const [host, route] of [
        [h.untrustedHost, '/certificate'],
        [h.brokenHost, '/handshake'],
        [h.trustedHost, '/reset'],
        [h.trustedHost, '/abort'],
      ]) {
        const timeout = AbortSignal.timeout(5000);
        const signal = route === '/abort' ? AbortSignal.any([timeout, controller.signal]) : timeout;
        await assert.rejects(read(host, route, signal), (error) => {
          if (route === '/certificate') return error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT';
          if (route === '/abort') return error.name === 'AbortError';
          return error instanceof Error;
        });
        assert.equal(timeout.aborted, false, `${route}: timeout is not recovery`);
        await healthy();
      }
      assert.ok(protocols.length >= 7);
      assert.ok(
        protocols.every((version) => version === '2.0'),
        `expected HTTP/2, got ${protocols}`,
      );
      assert.equal(h.rejectedRequests(), 0);
      assert.ok(h.handshakes() > 0);
    } finally {
      await dispatcher.destroy();
    }
  }, true);
}

/** 内蔵fetchのTLS拒否・接続中の切断・応答待ち中断と、その後の正常通信を確認する。 */
export async function verifyHttpsRecovery() {
  return verifyHttpsClient(async (url, signal) => {
    const response = await fetch(url, { signal });
    return response.text();
  });
}

/** 本体と同じrequest呼び出しも、グローバルdispatcherの既定状態のままHTTPSで確認する。 */
export async function verifyUndiciHttpsRecovery() {
  const { request } = await loadUndici();
  return verifyHttpsClient(async (url, signal) => {
    const response = await request(url, { signal });
    return response.body.text();
  });
}

async function verifyHttpsClient(readText) {
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
      assert.equal(
        await readText(`https://${h.trustedHost}/healthy`, AbortSignal.timeout(5000)),
        'TLS通信を再開',
      );
    }
    await healthy();
    for (const [host, route, expectedCode] of [
      [h.untrustedHost, '/certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
      [h.brokenHost, '/handshake', undefined],
      [h.trustedHost, '/truncated', undefined],
      [h.trustedHost, '/abort', undefined],
    ]) {
      const timeout = AbortSignal.timeout(5000);
      const signal = route === '/abort' ? AbortSignal.any([timeout, controller.signal]) : timeout;
      await assert.rejects(
        () => readText(`https://${host}${route}`, signal),
        (error) => {
          if (expectedCode) return (error.cause?.code ?? error.code) === expectedCode;
          if (route === '/abort') return error.name === 'AbortError';
          return error instanceof Error;
        },
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
