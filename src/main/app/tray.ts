import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron';
import type { RecordingInfo } from '../../shared/types';

export interface TrayCallbacks {
  showWindow: () => void;
  openOutputDir: () => void;
  stopRecording: (programId: string) => void;
  quit: () => void;
}

/**
 * トレイ (macOS ではメニューバー) の常駐アイコンとメニュー。
 * 録画中は赤丸、待機中は白抜きの丸を描く
 */
export class AppTray {
  private readonly tray: Tray;
  private recordings: RecordingInfo[] = [];
  private summary = '';

  constructor(private readonly callbacks: TrayCallbacks) {
    this.tray = new Tray(buildIcon(false));
    this.tray.setToolTip(app.name);
    this.tray.on('click', () => {
      if (process.platform !== 'darwin') {
        this.callbacks.showWindow();
      }
    });
    this.update([], '待機中');
  }

  update(recordings: RecordingInfo[], summary: string): void {
    this.recordings = recordings.filter((r) => r.state === 'recording' || r.state === 'starting');
    this.summary = summary;
    this.tray.setImage(buildIcon(this.recordings.length > 0));
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
 * 16x16 (@2x で 32x32) のアイコンをその場で描く。
 * macOS ではテンプレート画像として扱い、システムの配色に合わせる
 */
function buildIcon(recording: boolean): NativeImage {
  const size = 32;
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const outer = 12;
  const inner = 9;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ring = dist <= outer && dist >= outer - 2.5;
      const dot = dist <= inner - 2;
      const on = ring || (recording && dot);
      const offset = (y * size + x) * 4;
      // BGRA
      if (on) {
        const isMacTemplate = process.platform === 'darwin';
        const red = recording && !isMacTemplate;
        buffer[offset] = red ? 0x40 : 0x00;
        buffer[offset + 1] = red ? 0x40 : 0x00;
        buffer[offset + 2] = red ? 0xe0 : 0x00;
        buffer[offset + 3] = 0xff;
      } else {
        buffer[offset + 3] = 0x00;
      }
    }
  }
  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size, scaleFactor: 2 });
  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }
  return image;
}
