import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchElectron, deadline } from './electron/driver.mjs';
import { prepareUpdateMain } from './electron/update-main.mjs';

const binary = process.argv[2];
assert.ok(
  binary && path.isAbsolute(binary),
  '配布アプリの実行ファイルを絶対パスで指定してください',
);
assert.ok(['darwin', 'win32'].includes(process.platform));
// インストーラー適用は対象外。固定のバイト列で転送・サイズ・SHA512・キャッシュだけを検証する。
const payload = Buffer.alloc(2 * 1024 * 1024, 42);
const sha512 = createHash('sha512').update(payload).digest('base64');
const version = '99.0.0';
const filename = `update-${version}-${process.arch}.${process.platform === 'darwin' ? 'zip' : 'exe'}`;
async function waitForUpdate(app, result) {
  return app.evaluate(`new Promise((resolve, reject) => {
    const unsubscribe = window.api.onStatusChanged(check);
    function check(status) { if (status.update.result === ${JSON.stringify(result)}) { unsubscribe(); resolve(status.update); } }
    window.api.getStatus().then(check, reject);
  })`);
}
for (const corrupt of [false, true]) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'nlr-updater-test-'));
  const configPath = path.join(work, 'app-update.yml');
  const cacheDir = path.join(work, 'cache');
  const installMarker = path.join(work, 'installation-attempted');
  const held = [];
  let downloadStarted;
  const started = new Promise((resolve) => {
    downloadStarted = resolve;
  });
  const requests = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    requests.push(pathname);
    if (pathname.endsWith('.yml')) {
      response.end(
        JSON.stringify({
          version,
          files: [{ url: filename, sha512, size: payload.length }],
          path: filename,
          sha512,
          releaseDate: '2026-01-01T00:00:00.000Z',
        }),
      );
    } else if (pathname === `/${filename}`) {
      held.push(response);
      downloadStarted();
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  let app;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    await writeFile(
      configPath,
      JSON.stringify({
        provider: 'generic',
        url: origin,
        updaterCacheDirName: 'nlr-test-download',
      }),
    );
    app = await launchElectron({
      work,
      binary,
      prepareMain: prepareUpdateMain,
      config: { origin, configPath, cacheDir, installMarker },
    });
    assert.equal(await app.mainEvaluate('__nlrTest.require("electron").app.isPackaged'), true);
    assert.equal(await app.mainEvaluate('__nlrTest.updater.autoInstallOnAppQuit'), false);
    await deadline(started, 'update download request');
    await waitForUpdate(app, 'downloading');
    const bytes = Buffer.from(payload);
    if (corrupt) bytes[0] ^= 0xff;
    for (const response of held) {
      response.writeHead(200, {
        'content-length': bytes.length,
        'content-type': 'application/octet-stream',
      });
      response.end(bytes);
    }
    const status = await waitForUpdate(app, corrupt ? 'error' : 'downloaded');
    const events = await app.mainEvaluate('__nlrTest.updateEvents');
    const downloadCache = await app.mainEvaluate(
      '__nlrTest.updater.downloadedUpdateHelper.cacheDir',
    );
    assert.equal(downloadCache, path.join(cacheDir, 'nlr-test-download'));
    assert.ok(events.progress.length > 0);
    assert.equal(events.progress.at(-1).percent, 100);
    assert.equal(events.progress.at(-1).transferred, payload.length);
    if (corrupt) {
      assert.equal(events.downloaded.length, 0);
      assert.ok(events.errors.some((error) => error.code === 'ERR_CHECKSUM_MISMATCH'));
      await assert.rejects(access(path.join(downloadCache, 'pending', 'update-info.json')), {
        code: 'ENOENT',
      });
    } else {
      assert.equal(status.progress, 100);
      assert.equal(events.errors.length, 0);
      assert.equal(events.downloaded.length, 1);
      const downloaded = events.downloaded[0].downloadedFile;
      assert.equal(path.dirname(downloaded), path.join(downloadCache, 'pending'));
      assert.deepEqual(await readFile(downloaded), payload);
      const metadata = JSON.parse(
        await readFile(path.join(downloadCache, 'pending', 'update-info.json'), 'utf8'),
      );
      assert.equal(metadata.sha512, sha512);
    }
    if (process.platform === 'darwin') {
      assert.equal(events.nativeFeeds.length, corrupt ? 0 : 1);
      for (const feed of events.nativeFeeds) assert.equal(new URL(feed).hostname, '127.0.0.1');
    }
    assert.deepEqual(app.errors, []);
    assert.equal(requests.filter((url) => url === `/${filename}`).length, 1);
    await app.quit();
    await assert.rejects(access(installMarker), { code: 'ENOENT' });
    console.log(
      `Electron updater OK: ${corrupt ? 'checksum rejection' : 'download/progress/cache'}, normal quit without installation`,
    );
  } catch (error) {
    console.error(app?.output());
    throw error;
  } finally {
    await app?.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
