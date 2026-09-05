import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { silentLogger, type Logger } from '../logger';

/** 同梱 FFmpeg を解決する。CLI の開発実行はリポジトリ直下を作業ディレクトリにする。 */
export function resolveFfmpegPath(
  bundleDir = path.resolve('resources', 'ffmpeg', `${process.platform}-${process.arch}`),
): string {
  const override = process.env['NICO_FFMPEG_PATH'];
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  // パッケージ版では呼び出し元が Resources/ffmpeg を渡す。旧バイナリへはフォールバックしない。
  const binary = path.join(bundleDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (!existsSync(binary)) {
    throw new Error(`同梱 FFmpeg がありません: ${binary} (開発時は npm run ffmpeg:build を実行)`);
  }
  return binary;
}

export interface FfmpegMuxerOptions {
  outputPath: string;
  ffmpegPath?: string;
  /** false なら映像パイプのみ (映像 playlist に音声が多重化されている場合) */
  separateAudio?: boolean;
  logger?: Logger;
}

export interface FfmpegExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * 映像・音声の fMP4 ストリームをパイプで受け取り、1 本の MPEG-TS に多重化する ffmpeg プロセス。
 * fd3 = 映像、fd4 = 音声。入力パイプを閉じると ffmpeg は自然に終了する
 * (Windows でもシグナル無しで止められる)。
 */
export class FfmpegMuxer {
  private readonly outputPath: string;
  private readonly ffmpegPath: string;
  private readonly separateAudio: boolean;
  private readonly logger: Logger;
  private child?: ChildProcess;
  private exitPromise?: Promise<FfmpegExit>;

  constructor(options: FfmpegMuxerOptions) {
    this.outputPath = options.outputPath;
    this.ffmpegPath = options.ffmpegPath ?? resolveFfmpegPath();
    this.separateAudio = options.separateAudio ?? true;
    this.logger = options.logger ?? silentLogger;
  }

  start(): { video: Writable; audio?: Writable } {
    if (this.child) {
      throw new Error('ffmpeg は既に起動しています');
    }
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-copyts'];
    args.push('-thread_queue_size', '1024', '-i', 'pipe:3');
    if (this.separateAudio) {
      args.push('-thread_queue_size', '1024', '-i', 'pipe:4', '-map', '0:v', '-map', '1:a');
    }
    args.push('-c', 'copy', '-f', 'mpegts', '-y', this.outputPath);

    this.logger.debug(`ffmpeg ${args.join(' ')}`);
    const stdio: Array<'ignore' | 'pipe'> = ['ignore', 'ignore', 'pipe', 'pipe'];
    if (this.separateAudio) {
      stdio.push('pipe');
    }
    // .js / .cjs を指定されたときは node で実行する (テストの偽 ffmpeg。Windows では shell script を spawn できない)
    const [command, commandArgs] = /\.[cm]?js$/.test(this.ffmpegPath)
      ? [process.execPath, [this.ffmpegPath, ...args]]
      : [this.ffmpegPath, args];
    const child = spawn(command, commandArgs, { stdio, windowsHide: true });
    this.child = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          this.logger.warn(`ffmpeg: ${line.trim()}`);
        }
      }
    });

    this.exitPromise = new Promise<FfmpegExit>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });

    const video = child.stdio[3] as Writable;
    const audio = this.separateAudio ? (child.stdio[4] as Writable) : undefined;
    // 書き込み先が先に閉じたときの EPIPE でプロセス全体を落とさない
    for (const pipe of [video, audio]) {
      pipe?.on('error', (error) => this.logger.warn(`ffmpeg pipe error: ${error.message}`));
    }
    return { video, audio };
  }

  /** 入力パイプを閉じて ffmpeg の自然終了を待つ */
  async finish(): Promise<FfmpegExit> {
    if (!this.child || !this.exitPromise) {
      throw new Error('ffmpeg は起動していません');
    }
    for (const fd of [3, 4]) {
      const pipe = this.child.stdio[fd] as Writable | undefined;
      if (pipe && !pipe.writableEnded) {
        pipe.end();
      }
    }
    const exit = await this.exitPromise;
    this.logger.info(`ffmpeg exited code=${exit.exitCode} signal=${exit.signal ?? 'none'}`);
    return exit;
  }

  wait(): Promise<FfmpegExit> {
    if (!this.exitPromise) {
      throw new Error('ffmpeg は起動していません');
    }
    return this.exitPromise;
  }

  kill(): void {
    this.child?.kill();
  }
}
