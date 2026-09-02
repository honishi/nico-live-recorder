import path from 'node:path';
import { app, BrowserWindow, powerSaveBlocker, shell } from 'electron';
import { IPC } from '../shared/types';
import { AppLogger } from './app/app-logger';
import { NicoAuth } from './app/auth';
import { buildStatus, registerIpcHandlers } from './app/ipc';
import { FilePushStateStore } from './app/push-state-store';
import { RecordingManager } from './app/recording-manager';
import { SettingsStore } from './app/settings-store';
import { AppTray } from './app/tray';
import { resolveFfmpegPath } from './core/nico/ffmpeg';
import { configureProtoRootDir } from './nico-client/internal/protoLoader';

let mainWindow: BrowserWindow | undefined;
let tray: AppTray | undefined;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 520,
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

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
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

  const manager = new RecordingManager({ settings, auth, pushStore, logger, ffmpegPath });

  // 録画中はスリープさせない
  let blockerId: number | undefined;
  manager.on('change', () => {
    const recording = manager.getRecordings().some((r) => r.state === 'recording');
    if (recording && blockerId === undefined) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!recording && blockerId !== undefined) {
      powerSaveBlocker.stop(blockerId);
      blockerId = undefined;
    }
  });

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
    const summary = !status.auth.loggedIn
      ? '未ログイン'
      : active > 0
        ? `${active} 件録画中`
        : `監視中 (push: ${status.push.state})`;
    tray?.update(status.recordings, summary);
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

  mainWindow = createMainWindow();
  await manager.start();
  scheduleBroadcast();

  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', (event) => {
    if (manager.getRecordings().some((r) => r.state === 'recording' || r.state === 'starting')) {
      event.preventDefault();
      logger.info('stopping recordings before quit');
      void manager.shutdown().finally(() => {
        logger.close();
        app.exit(0);
      });
    } else {
      void manager.shutdown();
      logger.close();
    }
  });
}

app.on('second-instance', showMainWindow);
app.on('activate', showMainWindow);
app.on('window-all-closed', () => {
  // トレイ常駐なので何もしない
});

void app.whenReady().then(bootstrap);
