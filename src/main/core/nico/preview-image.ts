import { spawn } from 'node:child_process';
import { resolveFfmpegPath } from './ffmpeg';
import type { VideoSample } from './video-sample';

const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 2 * 1024;

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
        // FFmpeg 8.0.3のx86で、外部ASM無効時に縮小画像が壊れるMMX経路を避ける。
        // scripts/ffmpeg/source.jsonの更新時に、上流修正62285beの取り込み状況と必要性を再評価する。
        'scale=320:180:force_original_aspect_ratio=decrease:flags=bicubic+accurate_rnd',
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
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let stderr = Buffer.alloc(0);
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
    // 診断は末尾2KiBだけ保持する。大量のエラーでもメモリやログを膨らませない。
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk.subarray(-MAX_STDERR_BYTES)]).subarray(
        -MAX_STDERR_BYTES,
      );
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const image = Buffer.concat(chunks);
      if (failure || code !== 0 || image[0] !== 0xff || image[1] !== 0xd8) {
        // 最後の2行と終了理由を1行にまとめ、通常のdebugログで切り分けられるようにする。
        const detail = stderr
          .toString('utf8')
          .split(/[\r\n]+/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-2)
          .join(' | ');
        const reason =
          failure?.message ??
          `preview image unavailable (ffmpeg exit ${code ?? exitSignal ?? 'unknown'})`;
        reject(new Error(detail ? `${reason}: ${detail}` : reason));
      } else resolve(image);
    });

    // 1枚を得た時点で FFmpeg が入力を閉じても、EPIPE を録画へ波及させない。
    child.stdin.on('error', () => {});
    if (sample.init) child.stdin.write(sample.init);
    child.stdin.end(sample.data);
  });
}
