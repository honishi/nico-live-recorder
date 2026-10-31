import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { runElectronScenario } from './electron/scenario.mjs';
import { runElectronProbe } from './electron/probe.mjs';

await runElectronScenario('auth', async ({ work, defer }) => {
  const cert = await readFile(new URL('../test/fixtures/tls/server.pem', import.meta.url));
  const key = await readFile(new URL('../test/fixtures/tls/server-key.pem', import.meta.url));
  const pin = createHash('sha256')
    .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  let loginRequests = 0;
  const server = createServer({ cert, key }, (request, response) => {
    if (request.url === '/login') {
      loginRequests += 1;
      response.setHeader('set-cookie', [
        'user_session=dummy-host; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=86400',
        'user_session=dummy=parent==; Domain=.nicovideo.jp; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=86400',
        'extra=another=value==; Domain=.nicovideo.jp; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=86400',
      ]);
    }
    response.setHeader('content-type', 'text/html');
    response.end('<html><body>offline login</body></html>');
  });
  defer(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // 本体のNicoAuthをそのままbundleし、ElectronのCookie実装で検証する。
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      ssr: fileURLToPath(new URL('./electron/auth-main.ts', import.meta.url)),
      outDir: work,
      emptyOutDir: false,
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'auth-main.cjs' },
      },
    },
  });
  for (const args of [[], ['--restore']]) {
    const output = await runElectronProbe(
      work,
      path.join(work, 'auth-main.cjs'),
      [
        ...args,
        '--host-resolver-rules=MAP www.nicovideo.jp 127.0.0.1',
        '--no-proxy-server',
        `--ignore-certificate-errors-spki-list=${pin}`,
      ],
      { NLR_AUTH_PORT: String(server.address().port) },
    );
    assert.ok(output.includes('Electron auth OK:'));
  }
  assert.equal(loginRequests, 1, 'Chromium must accept Set-Cookie from the local HTTPS response');
});
