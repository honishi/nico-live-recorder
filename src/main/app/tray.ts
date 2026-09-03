import { app, Menu, nativeImage, nativeTheme, Tray, type NativeImage } from 'electron';
import type { RecordingInfo } from '../../shared/types';

export interface TrayCallbacks {
  showWindow: () => void;
  openOutputDir: () => void;
  stopRecording: (programId: string) => void;
  quit: () => void;
}

export type TrayState = 'idle' | 'recording' | 'logged-out';

/**
 * トレイ (macOS ではメニューバー) の常駐アイコンとメニュー。
 * 円ひとつで状態を表す: 待機 = 輪、録画中 = 塗り、未ログイン = 破線の輪
 */
export class AppTray {
  private readonly tray: Tray;
  private recordings: RecordingInfo[] = [];
  private summary = '';
  private state: TrayState = 'idle';

  constructor(private readonly callbacks: TrayCallbacks) {
    this.tray = new Tray(buildIcon('idle'));
    this.tray.setToolTip(app.name);
    this.tray.on('click', () => {
      if (process.platform !== 'darwin') {
        this.callbacks.showWindow();
      }
    });
    // Windows はテーマに応じて白黒を切り替える
    nativeTheme.on('updated', () => this.tray.setImage(buildIcon(this.state)));
    this.update([], '待機中', 'idle');
  }

  update(recordings: RecordingInfo[], summary: string, state: TrayState): void {
    this.recordings = recordings.filter((r) => r.state === 'recording' || r.state === 'starting');
    this.summary = summary;
    this.state = state;
    this.tray.setImage(buildIcon(state));
    this.tray.setToolTip(`${app.name}: ${summary}`);
    this.tray.setContextMenu(this.buildMenu());
  }

  destroy(): void {
    this.tray.destroy();
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

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 16px (@2x で 32px) の単色アイコンをその場で描く。
 * macOS はテンプレート画像として扱い、システムが配色を決める。
 * Windows は nativeTheme に合わせて白 / 黒を選ぶ
 */
function buildIcon(state: TrayState): NativeImage {
  const size = 32;
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const outer = 12;
  const ringWidth = 2.4; // 線 5/34 相当
  const isMac = process.platform === 'darwin';
  const light = !isMac && nativeTheme.shouldUseDarkColors;
  const color = light ? 0xff : 0x00;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ring = dist <= outer && dist >= outer - ringWidth;
      // 破線: 円周を 8 分割し、交互に描く
      const angle = Math.atan2(dy, dx) + Math.PI;
      const dashed = Math.floor((angle / (2 * Math.PI)) * 8) % 2 === 0;
      const on = state === 'recording' ? dist <= outer : state === 'idle' ? ring : ring && dashed;
      const offset = (y * size + x) * 4;
      // BGRA
      buffer[offset] = color;
      buffer[offset + 1] = color;
      buffer[offset + 2] = color;
      buffer[offset + 3] = on ? 0xff : 0x00;
    }
  }
  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size, scaleFactor: 2 });
  if (isMac) {
    image.setTemplateImage(true);
  }
  return image;
}
