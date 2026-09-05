import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signAsync } from '@electron/osx-sign';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import sign from '../../../scripts/mac/sign.mjs';

// テストでは証明書・codesign・Apple のタイムスタンプサーバーを使わない。
vi.mock('@electron/osx-sign', () => ({ signAsync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const hash = (content) => createHash('sha256').update(content).digest('hex');
let work;
let app;
let bundle;
let manifestPath;
let manifest;
let options;

beforeEach(() => {
  vi.resetAllMocks();
  work = mkdtempSync(path.join(tmpdir(), 'nlr-sign-test-'));
  app = path.join(work, 'NicoLiveRecorder.app');
  bundle = path.join(app, 'Contents', 'Resources', 'ffmpeg');
  mkdirSync(bundle, { recursive: true });
  manifestPath = path.join(bundle, 'manifest.json');
  const files = { ffmpeg: 'original ffmpeg', ffprobe: 'original ffprobe', 'LICENSE.md': 'license' };
  manifest = { source: { version: 'test' }, files: {} };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(bundle, name), content);
    manifest.files[name] = hash(content);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
  options = {
    app,
    identity: 'test-identity',
    keychain: 'test-keychain',
    optionsForFile: () => ({ entitlements: 'electron.plist', hardenedRuntime: true }),
  };
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

function signBinaries(settings) {
  for (const name of ['ffmpeg', 'ffprobe']) {
    const binary = path.join(bundle, name);
    expect(settings.optionsForFile(binary)).toEqual({ entitlements: [], hardenedRuntime: true });
    writeFileSync(binary, `signed ${name}`);
  }
}

describe('macOS 署名時の FFmpeg 整合性', () => {
  test.each(['absolute', 'relative'])(
    'アプリの %s パスでも最終署名前にハッシュを確定する',
    async (pathType) => {
      if (pathType === 'relative') options.app = path.relative(process.cwd(), app);
      signAsync.mockImplementation(async (settings) => {
        expect(settings.identity).toBe(options.identity);
        expect(settings.keychain).toBe(options.keychain);
        signBinaries(settings);
        expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(manifest);
        expect(settings.optionsForFile(settings.app)).toEqual(options.optionsForFile(settings.app));
        expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({
          ...manifest,
          files: {
            ...manifest.files,
            ffmpeg: hash('signed ffmpeg'),
            ffprobe: hash('signed ffprobe'),
          },
        });
      });
      await sign(options, { forceCodeSigning: true });
      expect(execFileSync).toHaveBeenCalledTimes(2);
      for (const name of ['ffmpeg', 'ffprobe']) {
        expect(execFileSync).toHaveBeenCalledWith(
          '/usr/bin/codesign',
          ['--verify', '--strict', path.join(bundle, name)],
          expect.any(Object),
        );
      }
    },
  );

  test('証明書のない通常ビルドはスキップし、署名必須のビルドは失敗する', async () => {
    options.identity = undefined;
    await sign(options, { forceCodeSigning: false });
    await expect(sign(options, { forceCodeSigning: true })).rejects.toThrow('署名用証明書');
    expect(signAsync).not.toHaveBeenCalled();
  });

  test('署名前に実体が変わっていれば署名を開始しない', async () => {
    writeFileSync(path.join(bundle, 'ffmpeg'), 'modified');
    await expect(sign(options, {})).rejects.toThrow('署名前の同梱ファイル不一致');
    expect(signAsync).not.toHaveBeenCalled();
  });

  test('署名漏れのバイナリがあれば manifest を更新しない', async () => {
    signAsync.mockImplementation(async (settings) => settings.optionsForFile(app));
    await expect(sign(options, {})).rejects.toThrow('署名対象に含まれていません');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(manifest);
  });

  test('バイナリの署名検証に失敗したら manifest を更新しない', async () => {
    signAsync.mockImplementation(async (settings) => {
      signBinaries(settings);
      settings.optionsForFile(app);
    });
    execFileSync.mockImplementation(() => {
      throw new Error('invalid signature');
    });
    await expect(sign(options, {})).rejects.toThrow('invalid signature');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(manifest);
  });

  test('署名中の資料改変を新しいハッシュで上書きして受け入れない', async () => {
    signAsync.mockImplementation(async (settings) => {
      signBinaries(settings);
      writeFileSync(path.join(bundle, 'LICENSE.md'), 'modified');
      settings.optionsForFile(app);
    });
    await expect(sign(options, {})).rejects.toThrow('署名中に同梱資料が変更されました');
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(manifest);
  });
});
