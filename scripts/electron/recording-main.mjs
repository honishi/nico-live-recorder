/** debuggerから実mainへ注入する。関数外の値には依存せず、配布アプリ内の依存を使う。 */
export function prepareRecordingMain(require, { origin, observePreviews = false }) {
  const { app, session } = require('electron');
  // 内蔵Undiciを先に初期化する。npm版のrequire/setGlobalDispatcherはlegacy側も上書きする。
  void fetch('data:,initialize-native-dispatcher');
  const nativeKey = Symbol.for('undici.globalDispatcher.1');
  const nativeAgent = globalThis[nativeKey];
  if (!nativeAgent?.dispatch) throw new Error('Native Undici dispatcher unavailable');
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
  const npmAgent = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get('https://live.nicovideo.jp')
    .intercept({ path: '/watch/lv42', method: 'GET' })
    .reply(302, '', { headers: { location: `${origin}/watch` } })
    .persist();
  setGlobalDispatcher(agent);
  const legacyMock = globalThis[nativeKey];
  const counts = { native: 0, npm: 0, mocked: 0 };
  const localOrigins = new Set([new URL(origin).origin]);
  globalThis.__nlrTest.allowNetworkOrigin = (url) => localOrigins.add(new URL(url).origin);
  const route = (real, mock, kind) => ({
    dispatch(options, handler) {
      if (localOrigins.has(String(options.origin))) {
        counts[kind] += 1;
        return real.dispatch(options, handler);
      }
      counts.mocked += 1;
      return mock.dispatch(options, handler);
    },
  });
  // ローカルの録画通信は各ランタイム本来のAgentへ通す。固定API応答だけをMockへ渡す。
  setGlobalDispatcher(route(npmAgent, agent, 'npm'));
  globalThis[nativeKey] = route(nativeAgent, legacyMock, 'native');
  globalThis.__nlrTest.agent = agent;
  globalThis.__nlrTest.networkDispatches = counts;

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
  // 応答を差し替えず、rendererの購読・解除が実IPCへ届いた順序を記録する。
  if (observePreviews) {
    const { ipcMain } = require('electron');
    const handle = ipcMain.handle;
    globalThis.__nlrTest.previewRequests = [];
    globalThis.__nlrTest.events = new (require('node:events').EventEmitter)();
    ipcMain.handle = function (channel, listener) {
      if (channel !== 'recording:preview') return handle.call(this, channel, listener);
      return handle.call(this, channel, (event, ...args) => {
        const result = listener(event, ...args);
        globalThis.__nlrTest.previewRequests.push({ visible: args[1], image: !!result });
        globalThis.__nlrTest.events.emit('preview');
        return result;
      });
    };
  }
}
