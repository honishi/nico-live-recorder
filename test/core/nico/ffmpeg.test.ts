import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveFfmpegPath } from '../../../src/main/core/nico/ffmpeg';

describe('resolveFfmpegPath', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nlr ffmpeg path '));
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  test('開発者・利用者が指定した実行ファイルを優先する', () => {
    vi.stubEnv('NICO_FFMPEG_PATH', ' /custom/ffmpeg ');
    expect(resolveFfmpegPath(directory)).toBe('/custom/ffmpeg');
  });

  test('未同梱なら旧 ffmpeg-static を使わずエラーにする', () => {
    vi.stubEnv('NICO_FFMPEG_PATH', ' ');
    expect(() => resolveFfmpegPath(path.join(directory, 'missing'))).toThrow(
      '同梱 FFmpeg がありません',
    );
  });

  test('空白を含むパッケージの Resources にある OS 別の実体を解決する', () => {
    vi.stubEnv('NICO_FFMPEG_PATH', '');
    const binary = path.join(directory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    writeFileSync(binary, '');
    expect(resolveFfmpegPath(directory)).toBe(binary);
  });
});
