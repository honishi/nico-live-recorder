import path from 'node:path';
import { app, BrowserWindow, powerSaveBlocker, screen, shell } from 'electron';
import { IPC, type WindowBounds } from '../shared/types';
import { AppLogger } from './app/app-logger';
import { NicoAuth } from './app/auth';
import { buildStatus, registerIpcHandlers } from './app/ipc';
import { HistoryStore } from './app/history-store';
import { FilePushStateStore } from './app/push-state-store';
import { RecordingManager } from './app/recording-manager';
import { SettingsStore } from './app/settings-store';
import { AppTray, type TrayState } from './app/tray';
import { UpdateChecker } from './app/update-checker';
import { resolveFfmpegPath } from './core/nico/ffmpeg';
import { configureProtoRootDir } from './vendor/nico-client/internal/protoLoader';

const WINDOW_MIN_WIDTH = 760;
const WINDOW_MIN_HEIGHT = 520;
const WINDOW_DEFAULT_WIDTH = 900;
const WINDOW_DEFAULT_HEIGHT = 640;
/** 終了時に録画の停止処理とログの書き出しを待つ上限 */
const QUIT_SHUTDOWN_TIMEOUT_MS = 15_000;
const QUIT_LOG_CLOSE_TIMEOUT_MS = 2_000;

let mainWindow: BrowserWindow | undefined;
let tray: AppTray | undefined;
let quitting = false;

// 開発時に別の userData で 2 つ目のインスタンスを立てられるようにする (E2E 確認用)
if (process.env['NLR_USER_DATA']) {
  app.setPath('userData', process.env['NLR_USER_DATA']);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/** 保存した位置とサイズが現在のディスプレイに収まるときだけ復元する */
function restoredBounds(saved: WindowBounds | undefined): Partial<WindowBounds> {
  if (!saved || saved.width < WINDOW_MIN_WIDTH || saved.height < WINDOW_MIN_HEIGHT) {
    return {};
  }
  const { x, y } = saved;
  if (x === undefined || y === undefined) {
    return { width: saved.width, height: saved.height };
  }
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      x >= area.x - 20 &&
      y >= area.y - 20 &&
      x < area.x + area.width - 100 &&
      y < area.y + area.height - 100
    );
  });
  return visible ? saved : { width: saved.width, height: saved.height };
}

function createMainWindow(settings: SettingsStore): BrowserWindow {
  const bounds = restoredBounds(settings.get().window);
  const window = new BrowserWindow({
    width: bounds.width ?? WINDOW_DEFAULT_WIDTH,
    height: bounds.height ?? WINDOW_DEFAULT_HEIGHT,
    x: bounds.x,
    y: bounds.y,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: 'Nico Live Recorder',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.on('ready-to-show', () => window.show());

  // 位置とサイズは少し待ってから保存する (ドラッグ中の連続イベントをまとめる)
  let saveTimer: NodeJS.Timeout | undefined;
  const saveBounds = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      if (!window.isDestroyed() && !window.isMinimized()) {
        settings.setWindowBounds(window.getBounds());
      }
    }, 500);
  };
  window.on('resize', saveBounds);
  window.on('move', saveBounds);

  // ウィンドウを閉じてもトレイに常駐し続ける
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return window;
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  const logger = new AppLogger(path.join(userData, 'logs'), app.isPackaged ? 'info' : 'debug');
  logger.info(`${app.name} ${app.getVersion()} starting (${process.platform} ${process.arch})`);

  configureProtoRootDir(
    app.isPackaged
      ? path.join(process.resourcesPath, 'proto')
      : path.join(app.getAppPath(), 'resources', 'proto'),
  );

  // 保存先の既定値。検証用のインスタンスが本番の保存先に書かないよう、NLR_OUTPUT_DIR で差し替えられる
  const defaultOutputDir =
    process.env['NLR_OUTPUT_DIR'] ?? path.join(app.getPath('videos'), 'NicoLiveRecorder');
  const settings = new SettingsStore(path.join(userData, 'settings.json'), defaultOutputDir);
  // ファイル出力のレベルは「debug を表示」に連動させる (開発時は常に debug)
  const applyLogLevel = (): void => {
    logger.setOutputLevel(!app.isPackaged || settings.get().ui.showDebug ? 'debug' : 'info');
  };
  applyLogLevel();
  let showDebug = settings.get().ui.showDebug;
  settings.on('ui', (ui) => {
    applyLogLevel();
    // debug の表示を切り替えたら、debug 込み/抜きのログを載せ直すために status を送り直す
    if (ui.showDebug !== showDebug) {
      showDebug = ui.showDebug;
      scheduleBroadcast();
    }
  });
  const auth = new NicoAuth(logger);
  const pushStore = new FilePushStateStore(path.join(userData, 'push-subscription.json'));

  let ffmpegPath: string | undefined;
  try {
    ffmpegPath = resolveFfmpegPath();
    logger.info(`ffmpeg: ${ffmpegPath}`);
  } catch (error) {
    logger.error('ffmpeg not found', error);
  }

  const history = new HistoryStore(path.join(userData, 'recording-history.json'));
  const manager = new RecordingManager({
    settings,
    auth,
    pushStore,
    history,
    logger,
    ffmpegPath,
  });

  // 録画中はスリープさせない
  let blockerId: number | undefined;
  manager.on('change', () => {
    const recording = manager.hasActiveRecordings();
    if (recording && blockerId === undefined) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!recording && blockerId !== undefined) {
      powerSaveBlocker.stop(blockerId);
      blockerId = undefined;
    }
  });

  const showMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow(settings);
      return;
    }
    mainWindow.show();
    mainWindow.focus();
  };

  const updates = new UpdateChecker(app.getVersion(), logger);
  const ctx = {
    version: app.getVersion(),
    updates,
    settings,
    auth,
    manager,
    logger,
    getMainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined),
  };
  registerIpcHandlers(ctx);

  tray = new AppTray({
    showWindow: showMainWindow,
    openOutputDir: () => void shell.openPath(settings.get().outputDir),
    stopRecording: (programId) => manager.stopRecording(programId),
    quit: () => app.quit(),
  });

  const broadcast = async (): Promise<void> => {
    const status = await buildStatus(ctx);
    const active = status.recordings.filter((r) => r.state === 'recording').length;
    const trayState: TrayState = !status.auth.loggedIn
      ? 'logged-out'
      : active > 0
        ? 'recording'
        : 'idle';
    const summary = !status.auth.loggedIn
      ? '未ログイン'
      : active > 0
        ? `${active} 件録画中`
        : status.detectorRunning
          ? `監視中 (push: ${status.push.state})`
          : '監視停止 (対象なし)';
    tray?.update(status.recordings, summary, trayState);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.statusChanged, status);
    }
  };
  let broadcastTimer: NodeJS.Timeout | undefined;
  const scheduleBroadcast = (): void => {
    if (broadcastTimer) {
      return;
    }
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      void broadcast();
    }, 200);
  };
  manager.on('change', scheduleBroadcast);
  auth.on('change', scheduleBroadcast);
  settings.on('change', scheduleBroadcast);
  logger.on('entry', scheduleBroadcast);
  updates.on('change', scheduleBroadcast);

  app.on('second-instance', showMainWindow);
  app.on('activate', showMainWindow);

  mainWindow = createMainWindow(settings);
  // パッケージ版だけ自動確認する。開発時も設定画面からの手動確認は可能
  if (app.isPackaged) {
    updates.start();
  }
  await manager.start();
  scheduleBroadcast();

  app.on('before-quit', () => {
    quitting = true;
    updates.stop();
  });
  // 終了時は録画の停止処理 (ffmpeg の書き終わり、履歴の確定) とログの書き出しを待ってから抜ける
  let quitHandled = false;
  app.on('will-quit', (event) => {
    if (quitHandled) {
      return;
    }
    quitHandled = true;
    event.preventDefault();
    if (manager.hasActiveRecordings()) {
      logger.info('stopping recordings before quit');
    }
    // どこかで失敗しても、上限時間を過ぎても、必ず app.exit に到達させる
    const withTimeout = (task: Promise<unknown>, ms: number): Promise<void> =>
      Promise.race([
        task.then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
      ]);
    void (async () => {
      try {
        await withTimeout(manager.shutdown(), QUIT_SHUTDOWN_TIMEOUT_MS);
      } catch (error) {
        logger.error('shutdown failed', error);
      }
      try {
        history.flush();
      } catch (error) {
        logger.error('history flush failed', error);
      }
      try {
        await withTimeout(logger.close(), QUIT_LOG_CLOSE_TIMEOUT_MS);
      } catch {
        // ログが閉じられなくても終了は続ける
      }
      app.exit(0);
    })();
  });
}

app.on('window-all-closed', () => {
  // トレイ常駐なので何もしない
});

void app.whenReady().then(bootstrap);
