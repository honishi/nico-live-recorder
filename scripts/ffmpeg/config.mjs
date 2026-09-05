import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const source = JSON.parse(readFileSync(new URL('./source.json', import.meta.url), 'utf8'));
export const sourceName = `ffmpeg-${source.version}.tar.xz`;

// 外部ライブラリの自動検出も止め、開発機の環境でライセンスが変わるのを防ぐ。
export function configureArgs(platform = process.platform) {
  const args = [
    '--disable-gpl',
    '--disable-nonfree',
    '--disable-version3',
    '--disable-autodetect',
    '--disable-everything',
    '--disable-network',
    '--disable-doc',
    '--disable-debug',
    '--disable-shared',
    '--enable-static',
    '--disable-x86asm',
    '--disable-avdevice',
    '--disable-swscale',
    '--disable-swresample',
    '--disable-ffplay',
    '--enable-ffmpeg',
    '--enable-ffprobe',
    '--enable-protocol=file,pipe',
    '--enable-demuxer=mov,mpegts,aac,h264',
    '--enable-muxer=mpegts',
    '--enable-parser=h264,aac',
    // 入力の解析と ffprobe の検証用。エンコーダは有効にしない。
    '--enable-decoder=h264,aac',
    '--enable-bsf=h264_mp4toannexb,aac_adtstoasc',
  ];
  if (platform === 'win32') {
    args.push('--cc=gcc', '--disable-pthreads', '--enable-w32threads', '--extra-ldflags=-static');
  } else if (platform === 'darwin') {
    args.push(
      '--cc=clang',
      '--extra-cflags=-mmacosx-version-min=12.0',
      '--extra-ldflags=-mmacosx-version-min=12.0',
    );
  }
  return args;
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function assertLicense(license, configuration) {
  license = license.replace(/\s+/g, ' ');
  configuration = configuration.replace(/["']/g, '');
  if (/--enable-(?:nonfree|gpl|version3)(?:\s|$|=)/i.test(configuration)) {
    throw new Error('FFmpeg に禁止したライセンス設定が含まれています');
  }
  if (
    /nonfree parts|not legally redistributable|unredistributable/i.test(license) ||
    !/GNU Lesser General Public License/.test(license) ||
    !/version 2\.1 of the License, or \(at your option\) any later version/.test(license)
  ) {
    throw new Error('FFmpeg のライセンスが LGPL-2.1-or-later ではありません');
  }
  for (const flag of configureArgs()) {
    if (!configuration.includes(flag)) {
      throw new Error(`FFmpeg のビルド設定が不足しています: ${flag}`);
    }
  }
}
