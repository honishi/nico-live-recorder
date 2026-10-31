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
    // 本物のChromiumネットワークでSet-Cookieを受理する。ローカル検証用の鍵だけを親が許可する。
    let acceptCookies = false;
    const local = `https://www.nicovideo.jp:${process.env['NLR_AUTH_PORT']}`;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      if (url.origin === 'https://account.nicovideo.jp' && url.pathname === '/login') {
        callback({ redirectURL: `${local}/${acceptCookies ? 'login' : 'cancel'}` });
      } else
        callback({
          cancel: url.origin !== local && !['devtools:', 'data:', 'file:'].includes(url.protocol),
        });
    });
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
      acceptCookies = true;
      assert.equal(await auth.login(), true);
      assert.deepEqual(changes, [true]);
      assert.equal(auth.revision, 1);
    }
    assert.equal(await auth.isLoggedIn(), true);
    const stored = await cookies.get({ url: 'https://www.nicovideo.jp' });
    assert.ok(
      stored.every(
        (cookie) => cookie.secure && cookie.httpOnly && cookie.sameSite === 'no_restriction',
      ),
    );
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
