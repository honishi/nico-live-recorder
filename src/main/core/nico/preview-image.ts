import { spawn } from 'node:child_process';
import { resolveFfmpegPath } from './ffmpeg';
import type { VideoSample } from './video-sample';

const MAX_IMAGE_BYTES = 256 * 1024;

/** 必要なセグメントだけを別プロセスで読み、最初のキーフレーム1枚を JPEG にする。 */
export function extractPreviewImage(
  sample: VideoSample,
  signal: AbortSignal,
  ffmpegPath = resolveFfmpegPath(),
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-threads',
        '1',
        '-skip_frame',
        'nokey',
        '-i',
        'pipe:0',
        '-map',
        '0:v:0',
        '-an',
        '-frames:v',
        '1',
        '-vf',
        'scale=320:180:force_original_aspect_ratio=decrease',
        '-filter_threads',
        '1',
        '-threads',
        '1',
        '-c:v',
        'mjpeg',
        '-q:v',
        '5',
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error): void => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const onAbort = (): void => stop(new Error('preview cancelled'));
    const timer = setTimeout(() => stop(new Error('preview timed out')), 3_000);
    signal.addEventListener('abort', onAbort, { once: true });

    // 不正入力でも出力を無制限に保持しない。終了を待つ間も次のプロセスは起動しない。
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_IMAGE_BYTES) stop(new Error('preview image too large'));
      else chunks.push(chunk);
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const image = Buffer.concat(chunks);
      if (failure || code !== 0 || image[0] !== 0xff || image[1] !== 0xd8) {
        reject(failure ?? new Error('preview image unavailable'));
      } else resolve(image);
    });

    // 1枚を得た時点で FFmpeg が入力を閉じても、EPIPE を録画へ波及させない。
    child.stdin.on('error', () => {});
    if (sample.init) child.stdin.write(sample.init);
    child.stdin.end(sample.data);
  });
}
