/** debuggerから実mainへ注入する。関数外の値には依存せず、配布アプリ内の依存を使う。 */
export function prepareRecordingMain(require, { origin }) {
  const { app, session } = require('electron');
  const { MockAgent, setGlobalDispatcher } = require('undici');
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(new URL(origin).host);
  agent
    .get('https://live.nicovideo.jp')
    .intercept({ path: '/watch/lv42', method: 'GET' })
    .reply(302, '', { headers: { location: `${origin}/watch` } })
    .persist();
  setGlobalDispatcher(agent);

  // パッケージ状態は維持する。自動更新だけは通信を始めさせず、本番キャッシュにも触れない。
  const { autoUpdater } = require('electron-updater');
  autoUpdater.checkForUpdates = async () => null;
  autoUpdater.quitAndInstall = () => {
    throw new Error('Unexpected update installation');
  };
  app.setPath('userData', process.env.NLR_USER_DATA);
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const protocol = new URL(details.url).protocol;
      callback({ cancel: !['file:', 'data:', 'devtools:'].includes(protocol) });
    });
  });

  // 実際の子プロセスは差し替えず、終了後に残っていないことを親のテストから調べる。
  const childProcess = require('node:child_process');
  const spawn = childProcess.spawn;
  globalThis.__nlrTest.children = [];
  childProcess.spawn = function (...args) {
    const child = spawn.apply(this, args);
    child.once('spawn', () => globalThis.__nlrTest.children.push(child.pid));
    return child;
  };
}
