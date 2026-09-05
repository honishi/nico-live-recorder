import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type { AppLogger } from '../../src/main/app/app-logger';

// electron を偽物に差し替え、画像の選び方 (状態・OS・テーマ → ファイル名) だけを検証する
const fake = vi.hoisted(() => ({
  loaded: [] as string[],
  templates: [] as string[],
  dark: false,
}));
vi.mock('electron', () => ({
  app: { name: 'test' },
  Menu: { buildFromTemplate: (items: unknown[]) => items },
  Tray: class {
    setImage(): void {}
    setToolTip(): void {}
    setContextMenu(): void {}
    on(): void {}
    destroy(): void {}
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return fake.dark;
    },
    on(): void {},
  },
  nativeImage: {
    createFromPath: (file: string) => {
      fake.loaded.push(file);
      const exists = fs.existsSync(file);
      return {
        isEmpty: () => !exists,
        getSize: () => ({ width: 16, height: 16 }),
        getScaleFactors: () => [1, 2],
        setTemplateImage: () => fake.templates.push(file),
      };
    },
  },
}));

import { AppTray } from '../../src/main/app/tray';

const iconDir = fileURLToPath(new URL('../../resources/tray/', import.meta.url));
const callbacks = { showWindow() {}, openOutputDir() {}, stopRecording() {}, quit() {} };
const warn = vi.fn();
const logger = { warn, debug: vi.fn() } as unknown as AppLogger;

/** process.platform を一時的に差し替える (CI は ubuntu と windows で回る) */
function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    run();
  } finally {
    Object.defineProperty(process, 'platform', { value: original });
  }
}

/** PNG の IHDR から幅と高さを読む */
function pngSize(file: string): { width: number; height: number } {
  const header = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, header, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

beforeEach(() => {
  fake.loaded.length = 0;
  fake.templates.length = 0;
  fake.dark = false;
  warn.mockClear();
});

describe('AppTray', () => {
  it('macOS では状態ごとの Template 画像を読み、一度読んだものは使い回す', () => {
    withPlatform('darwin', () => {
      const tray = new AppTray(iconDir, logger, callbacks);
      tray.update([], '録画中', 'recording');
      tray.update([], '未ログイン', 'logged-out');
      tray.update([], '待機中', 'idle');
    });
    expect(fake.loaded.map((f) => path.basename(f))).toEqual([
      'trayIdleTemplate.png',
      'trayRecordingTemplate.png',
      'trayOfflineTemplate.png',
    ]);
    expect(fake.templates).toEqual(fake.loaded);
    expect(warn).not.toHaveBeenCalled();
  });

  it('Windows はテーマに応じて黒 (Template) と白を選び、テンプレート指定はしない', () => {
    withPlatform('win32', () => {
      const tray = new AppTray(iconDir, logger, callbacks);
      fake.dark = true;
      tray.update([], '待機中', 'idle');
      tray.update([], '録画中', 'recording');
    });
    expect(fake.loaded.map((f) => path.basename(f))).toEqual([
      'trayIdleTemplate.png',
      'trayIdleWhite.png',
      'trayRecordingWhite.png',
    ]);
    expect(fake.templates).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('画像が無くても warn を出すだけで止めない', () => {
    withPlatform('darwin', () => {
      new AppTray(path.join(iconDir, 'missing'), logger, callbacks);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trayIdleTemplate.png'));
  });
});

describe('resources/tray', () => {
  it('3 状態 x 白黒 x 1x/@1.25x/@1.5x/@2x の 24 枚が 16 / 20 / 24 / 32px で揃っている', () => {
    const files = fs
      .readdirSync(iconDir)
      .filter((f) => f.endsWith('.png'))
      .sort();
    // 倍率ごとの接尾辞と期待する px。nativeImage が拾える接尾辞 (@1.25x など) に合わせる
    const scales: Array<[string, number]> = [
      ['', 16],
      ['@1.25x', 20],
      ['@1.5x', 24],
      ['@2x', 32],
    ];
    const expected = ['Idle', 'Recording', 'Offline']
      .flatMap((state) => ['Template', 'White'].map((variant) => `tray${state}${variant}`))
      .flatMap((name) => scales.map(([suffix]) => `${name}${suffix}.png`))
      .sort();
    expect(files).toEqual(expected);
    for (const file of files) {
      const [, size] = scales.find(
        ([suffix]) => file.endsWith(`${suffix}.png`) && (suffix !== '' || !file.includes('@')),
      )!;
      expect(pngSize(path.join(iconDir, file)), file).toEqual({ width: size, height: size });
    }
  });
});
