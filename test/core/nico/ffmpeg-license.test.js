import { describe, expect, test } from 'vitest';
import { assertLicense, configureArgs } from '../../../scripts/ffmpeg/config.mjs';

const license = `ffmpeg is free software; you can redistribute it and/or
modify it under the terms of the GNU Lesser General Public
License as published by the Free Software Foundation; either
version 2.1 of the License, or (at your option) any later version.`;
const configuration = configureArgs().join(' ');

describe('FFmpeg 配布ライセンスのゲート', () => {
  test('改行・引用符を含む LGPL 2.1 の実際の出力形式を受け入れる', () => {
    expect(() =>
      assertLicense(license, configuration.replace('file,pipe', "'file,pipe'")),
    ).not.toThrow();
  });

  test.each(['nonfree', 'gpl', 'version3'])('--enable-%s を含む構成を拒否する', (flag) => {
    expect(() => assertLicense(license, `${configuration} --enable-${flag}`)).toThrow();
  });

  test('今回問題になった再配布不可の表示を拒否する', () => {
    expect(() =>
      assertLicense(
        'This version of ffmpeg has nonfree parts compiled in.\nTherefore it is not legally redistributable.',
        configuration,
      ),
    ).toThrow();
  });

  test.each([
    '',
    'GNU General Public License version 3',
    'GNU Lesser General Public License version 3',
  ])('不明または採用条件と異なるライセンスを拒否する: %s', (output) => {
    expect(() => assertLicense(output, configuration)).toThrow();
  });

  test('外部依存の自動検出を無効にしていないビルドを拒否する', () => {
    expect(() =>
      assertLicense(license, configuration.replace('--disable-autodetect', '')),
    ).toThrow();
  });
});
