import assert from 'node:assert/strict';
import { once } from 'node:events';
import { app, BrowserWindow, session } from 'electron';
import { NicoAuth } from '../../src/main/app/auth';
import { silentLogger } from '../../src/main/core/logger';

app.setPath('userData', process.env['NLR_USER_DATA']!);
// ログイン窓を閉じても検証用mainは終了しない。
app.on('window-all-closed', () => {});
void app
  .whenReady()
  .then(async () => {
    // 実サービスへ接続せず、ChromiumのHTTPSナビゲーションだけを通す。
    session.defaultSession.protocol.handle(
      'https',
      () =>
        new Response('<html><body>offline login</body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    );
    const auth = new NicoAuth(silentLogger);
    const changes: boolean[] = [];
    auth.on('change', (loggedIn) => changes.push(loggedIn));
    const cookies = session.defaultSession.cookies;
    const expected = { user_session: 'dummy=parent==', extra: 'another=value==' };
    // Cookie値にはASCIIだけを使い、同名のhost/domainと値中の=を確認する。
    if (!process.argv.includes('--restore')) {
      assert.equal(await auth.isLoggedIn(), false);
      assert.equal(await auth.getCookieHeader(), undefined);
      const cancelled = auth.login();
      const window = BrowserWindow.getAllWindows()[0];
      await once(window.webContents, 'did-finish-load');
      assert.equal(await auth.login(), false);
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      window.close();
      assert.equal(await cancelled, false);
      assert.deepEqual(changes, []);
      const expirationDate = Date.now() / 1000 + 86400;
      for (const details of [
        { name: 'user_session', value: 'dummy-host' },
        { name: 'user_session', value: expected.user_session, domain: '.nicovideo.jp' },
        { name: 'extra', value: expected.extra, domain: '.nicovideo.jp' },
      ])
        await cookies.set({
          url: 'https://www.nicovideo.jp',
          path: '/',
          secure: true,
          expirationDate,
          ...details,
        });
      assert.equal(await auth.login(), true);
      assert.deepEqual(changes, [true]);
      assert.equal(auth.revision, 1);
    }
    assert.equal(await auth.isLoggedIn(), true);
    assert.deepEqual(await auth.getCookieRecord(), expected);
    assert.equal((await auth.getCookieHeader())!.split('user_session=').length, 2);
    if (process.argv.includes('--restore')) {
      await auth.logout();
      assert.deepEqual(await cookies.get({ url: 'https://www.nicovideo.jp' }), []);
      assert.equal(await auth.getCookieRecord(), undefined);
      assert.equal(await auth.isLoggedIn(), false);
      assert.deepEqual(changes, [false]);
      assert.equal(auth.revision, 1);
    }
    await cookies.flushStore();
    console.log(
      'Electron auth OK:',
      process.argv.includes('--restore') ? 'restore/logout' : 'cancel/login/cookies',
    );
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
