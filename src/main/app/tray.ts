import path from 'node:path';
import { formatBytes } from '../../shared/format';
import { app, Menu, nativeImage, nativeTheme, Tray, type NativeImage } from 'electron';
import type { RecordingInfo } from '../../shared/types';
import type { AppLogger } from './app-logger';

export interface TrayCallbacks {
  showWindow: () => void;
  openOutputDir: () => void;
  stopRecording: (programId: string) => void;
  quit: () => void;
}

export type TrayState = 'idle' | 'recording' | 'logged-out';

/** 状態ごとの画像ファイル名の先頭。待機 = 輪、録画中 = 塗り、未ログイン = 破線の輪 */
const ICON_BASENAMES: Record<TrayState, string> = {
  idle: 'trayIdle',
  recording: 'trayRecording',
  'logged-out': 'trayOffline',
};

/**
 * トレイ (macOS ではメニューバー) の常駐アイコンとメニュー。
 * 画像は 16px (@2x で 32px) の単色 PNG を iconDir (resources/tray/) から読む
 */
export class AppTray {
  private readonly tray: Tray;
  private readonly icons = new Map<string, NativeImage>();
  private recordings: RecordingInfo[] = [];
  private summary = '';
  private state: TrayState = 'idle';

  constructor(
    private readonly iconDir: string,
    private readonly logger: AppLogger,
    private readonly callbacks: TrayCallbacks,
  ) {
    this.tray = new Tray(this.icon('idle'));
    this.tray.setToolTip(app.name);
    this.tray.on('click', () => {
      if (process.platform !== 'darwin') {
        this.callbacks.showWindow();
      }
    });
    // Windows はテーマに応じて白黒を切り替える
    nativeTheme.on('updated', () => this.tray.setImage(this.icon(this.state)));
    this.update([], '待機中', 'idle');
  }

  update(recordings: RecordingInfo[], summary: string, state: TrayState): void {
    this.recordings = recordings.filter((r) => r.state === 'recording' || r.state === 'starting');
    this.summary = summary;
    this.state = state;
    this.tray.setImage(this.icon(state));
    this.tray.setToolTip(`${app.name}: ${summary}`);
    this.tray.setContextMenu(this.buildMenu());
  }

  destroy(): void {
    this.tray.destroy();
  }

  /**
   * 状態に合う画像を返す。一度読んだものは使い回す。
   * macOS は黒のテンプレート画像を渡し、メニューバーの明暗に合わせた反転は OS に任せる。
   * Windows はテーマに合わせて白 / 黒を選ぶ。@2x は nativeImage が同じ場所から自動で拾う
   */
  private icon(state: TrayState): NativeImage {
    const isMac = process.platform === 'darwin';
    const variant = !isMac && nativeTheme.shouldUseDarkColors ? 'White' : 'Template';
    const file = path.join(this.iconDir, `${ICON_BASENAMES[state]}${variant}.png`);
    const cached = this.icons.get(file);
    if (cached) {
      return cached;
    }
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) {
      this.logger.warn(`tray icon not found: ${file}`);
    } else {
      const { width, height } = image.getSize();
      const scales = image.getScaleFactors().join('/');
      this.logger.debug(`tray icon loaded: ${file} (${width}x${height}, scale ${scales})`);
    }
    if (isMac) {
      image.setTemplateImage(true);
    }
    this.icons.set(file, image);
    return image;
  }

  private buildMenu(): Menu {
    const recordingItems: Electron.MenuItemConstructorOptions[] =
      this.recordings.length === 0
        ? [{ label: '録画中の放送はありません', enabled: false }]
        : this.recordings.map((r) => ({
            label: `● ${r.providerName ?? ''} ${r.title}`.slice(0, 60),
            submenu: [
              {
                label: `${formatBytes(r.videoBytes)} / コメント ${r.commentCount}`,
                enabled: false,
              },
              { label: '録画を停止', click: () => this.callbacks.stopRecording(r.programId) },
            ],
          }));
    return Menu.buildFromTemplate([
      { label: this.summary, enabled: false },
      { type: 'separator' },
      ...recordingItems,
      { type: 'separator' },
      { label: 'ウィンドウを開く', click: () => this.callbacks.showWindow() },
      { label: '録画フォルダを開く', click: () => this.callbacks.openOutputDir() },
      { type: 'separator' },
      { label: '終了', click: () => this.callbacks.quit() },
    ]);
  }
}
