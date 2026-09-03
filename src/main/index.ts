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
import { resolveFfmpegPath } from './core/nico/ffmpeg';
import { configureProtoRootDir } from './vendor/nico-client/internal/protoLoader';

const WINDOW_MIN_WIDTH = 760;
const WINDOW_MIN_HEIGHT = 520;
const WINDOW_DEFAULT_WIDTH = 900;
const WINDOW_DEFAULT_HEIGHT = 640;

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
      sandbox: false,
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

  const settings = new SettingsStore(
    path.join(userData, 'settings.json'),
    path.join(app.getPath('videos'), 'NicoLiveRecorder'),
  );
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

  const ctx = {
    version: app.getVersion(),
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
        : `監視中 (push: ${status.push.state})`;
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

  app.on('second-instance', showMainWindow);
  app.on('activate', showMainWindow);

  mainWindow = createMainWindow(settings);
  await manager.start();
  scheduleBroadcast();

  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', (event) => {
    if (manager.hasActiveRecordings()) {
      event.preventDefault();
      logger.info('stopping recordings before quit');
      void manager.shutdown().finally(() => {
        history.flush();
        logger.close();
        app.exit(0);
      });
    } else {
      void manager.shutdown();
      history.flush();
      logger.close();
    }
  });
}

app.on('window-all-closed', () => {
  // トレイ常駐なので何もしない
});

void app.whenReady().then(bootstrap);
