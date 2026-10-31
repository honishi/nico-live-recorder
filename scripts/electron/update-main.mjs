/** 実updaterの通信・ダウンロードを残し、配信先とキャッシュだけを隔離する。 */
export function prepareUpdateMain(require, { origin, configPath, cacheDir, installMarker }) {
  const { app, session, autoUpdater: nativeUpdater } = require('electron');
  const { MockAgent, setGlobalDispatcher } = require('undici');
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  app.setPath('userData', process.env.NLR_USER_DATA);
  const { autoUpdater } = require('electron-updater');
  // userDataだけではOS共通キャッシュを分離できないため、updaterの保存基点も一時領域へ向ける。
  Object.defineProperty(autoUpdater.app, 'baseCachePath', { value: cacheDir });
  autoUpdater.updateConfigPath = configPath;
  autoUpdater.setFeedURL({ provider: 'generic', url: origin });
  autoUpdater.disableDifferentialDownload = true;
  globalThis.__nlrTest.updateEvents = { progress: [], downloaded: [], errors: [], nativeFeeds: [] };
  globalThis.__nlrTest.updater = autoUpdater;
  autoUpdater.on('download-progress', (info) =>
    globalThis.__nlrTest.updateEvents.progress.push(info),
  );
  autoUpdater.on('update-downloaded', (info) =>
    globalThis.__nlrTest.updateEvents.downloaded.push(info),
  );
  autoUpdater.on('error', (error) =>
    globalThis.__nlrTest.updateEvents.errors.push({ code: error.code, message: error.message }),
  );
  // 適用経路に入れば証拠を残して失敗させる。正常終了後にも親からマーカー不在を検査する。
  const forbidden = () => {
    require('node:fs').writeFileSync(installMarker, 'unexpected installation');
    throw new Error('Unexpected update installation');
  };
  autoUpdater.quitAndInstall = forbidden;
  if (process.platform === 'darwin') {
    // setFeedURLの時点でもSquirrelを初期化させず、OS側キャッシュへの接触を防ぐ。
    nativeUpdater.setFeedURL = (feed) =>
      globalThis.__nlrTest.updateEvents.nativeFeeds.push(feed.url);
    nativeUpdater.checkForUpdates = forbidden;
    nativeUpdater.quitAndInstall = forbidden;
  } else autoUpdater.doInstall = forbidden;
  app.whenReady().then(() => {
    for (const target of [session.defaultSession, session.fromPartition('electron-updater')]) {
      target.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        callback({
          cancel: !['file:', 'data:', 'devtools:'].includes(url.protocol) && url.origin !== origin,
        });
      });
    }
  });
}
