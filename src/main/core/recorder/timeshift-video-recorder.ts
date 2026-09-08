import fs from 'node:fs/promises';
import { FfmpegMuxer } from '../nico/ffmpeg';
import {
  cookieHeaderFor,
  parseMediaPlaylist,
  parseMultivariantPlaylist,
  selectBestVariant,
} from '../nico/hls';
import type { HlsStreamInfo } from '../nico/watch-session';
import { checkedFetch, TimeshiftError } from '../nico/timeshift-common';
import { downloadMetrics, downloadTimeshiftTrack } from '../nico/timeshift-download';
import {
  prepareTimeshiftPlaylist,
  type TimeshiftPlaylistDiagnostic,
} from '../nico/timeshift-playlist';
import type { VideoRecordResult } from './video-recorder';
import type { TimeshiftProgress } from '../../../shared/types';
import type { Logger } from '../logger';

export interface TimeshiftVideoReport {
  startedAt: string;
  endedAt?: string;
  playlists?: { label: 'video' | 'audio'; diagnostic?: TimeshiftPlaylistDiagnostic }[];
  tracks: { expected: number; saved: number; missing: number; httpErrors: number[] }[];
}

/** ENDLIST のある固定 playlist を取得し、実際に書き込んだセグメント数で完了を判定する。 */
export async function recordTimeshiftVideo(
  stream: HlsStreamInfo,
  options: {
    outputPath: string;
    ffmpegPath?: string;
    logger?: Logger;
    onReport?: (report: TimeshiftVideoReport) => void;
    onProgress?: (progress: Partial<TimeshiftProgress>) => void;
  },
  signal: AbortSignal,
): Promise<VideoRecordResult> {
  const startedAt = new Date();
  const controller = new AbortController();
  const work = AbortSignal.any([signal, controller.signal]);
  const get = async (url: string): Promise<string> => {
    const response = await checkedFetch(url, work, cookieHeaderFor(stream.cookies, url));
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const raw of response.body!) {
      const chunk: unknown = raw;
      if (!(chunk instanceof Uint8Array)) throw new TimeshiftError('INVALID_RESPONSE_CHUNK');
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) throw new TimeshiftError('PLAYLIST_BYTE_LIMIT');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString();
  };
  const best = selectBestVariant(parseMultivariantPlaylist(await get(stream.uri), stream.uri));
  const urls = [best.video.uri, ...(best.audioUri ? [best.audioUri] : [])];
  const report: TimeshiftVideoReport = {
    startedAt: startedAt.toISOString(),
    tracks: [],
    playlists: urls.map((_url, index) => ({ label: index === 0 ? 'video' : 'audio' })),
  };
  options.onReport?.(report);
  const prepared = await Promise.allSettled(
    urls.map(async (url, index) =>
      prepareTimeshiftPlaylist(await get(url), url, (diagnostic) => {
        report.playlists![index].diagnostic = diagnostic;
        const label = index === 0 ? 'video' : 'audio';
        if (diagnostic.unsupportedCount) {
          options.logger?.warn(
            `timeshift ${label} playlist rejected: ${JSON.stringify(diagnostic)}`,
          );
        } else {
          options.logger?.debug(`timeshift ${label} playlist: ${JSON.stringify(diagnostic)}`);
        }
      }),
    ),
  );
  const playlists = prepared.map((result) => {
    if (result.status === 'rejected') {
      report.endedAt = new Date().toISOString();
      throw result.reason;
    }
    return result.value;
  });
  const totalSegments = playlists.reduce(
    (sum, item) => sum + item.summary.expectedSavedSegments,
    0,
  );
  report.tracks = playlists.map((item) => ({
    expected: item.summary.expectedSavedSegments,
    saved: 0,
    missing: 0,
    httpErrors: [],
  }));
  const counts = urls.map(() => 0);
  options.onProgress?.({ phase: 'downloading', totalSegments, savedSegments: 0 });
  work.throwIfAborted();
  const muxer = new FfmpegMuxer({ ...options, separateAudio: !!best.audioUri });
  const pipes = muxer.start();
  const exited = muxer.wait();
  let tracksEnded = 0;
  let finishTimer: NodeJS.Timeout | undefined;
  // FFmpeg の早期終了は、パイプで待機している要求も解除する。
  void exited.then(
    (exit) => {
      if (exit.exitCode !== 0 || tracksEnded !== urls.length)
        controller.abort(new TimeshiftError('FFMPEG_FAILED'));
    },
    () => controller.abort(new TimeshiftError('FFMPEG_FAILED')),
  );
  const kill = (): void => muxer.kill();
  work.addEventListener('abort', kill, { once: true });
  let failure: unknown;
  try {
    work.throwIfAborted();
    const results = await Promise.allSettled(
      urls.map(async (url, index) => {
        const sink = index === 0 ? pipes.video : pipes.audio!;
        const metrics = downloadMetrics();
        try {
          const result = await downloadTimeshiftTrack(
            parseMediaPlaylist(playlists[index].text, url).segments,
            sink,
            stream.cookies,
            5,
            work,
            metrics,
            (saved) => {
              counts[index] = saved;
              report.tracks[index].saved = saved;
              options.onProgress?.({ savedSegments: counts.reduce((a, b) => a + b, 0) });
            },
            playlists[index].continuityCheckSeqs,
          );
          if (
            metrics.missingSegments ||
            result.segments === 0 ||
            result.segments !== playlists[index].summary.expectedSavedSegments
          )
            throw new TimeshiftError('SEGMENTS_INCOMPLETE');
          return result;
        } catch (error) {
          failure ??= error;
          controller.abort(error);
          throw error;
        } finally {
          report.tracks[index].missing = metrics.missingSegments;
          report.tracks[index].httpErrors = metrics.httpErrors;
          tracksEnded += 1;
          sink.end();
        }
      }),
    );
    if (failure) throw failure instanceof Error ? failure : new TimeshiftError('TRACK_FAILED');
    options.onProgress?.({ phase: 'saving' });
    finishTimer = setTimeout(
      () => controller.abort(new TimeshiftError('FFMPEG_FINISH_TIMEOUT')),
      15_000,
    );
    const exit = await muxer.finish();
    work.throwIfAborted();
    if (exit.exitCode !== 0) throw new TimeshiftError('FFMPEG_FAILED');
    if ((await fs.stat(options.outputPath)).size === 0) throw new TimeshiftError('OUTPUT_EMPTY');
    const saved = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    return {
      outputPath: options.outputPath,
      startedAt,
      endedAt: new Date(),
      reason: 'endlist',
      video: saved[0],
      audio: saved[1],
      ffmpegExitCode: exit.exitCode,
    };
  } finally {
    clearTimeout(finishTimer);
    report.endedAt = new Date().toISOString();
    options.onReport?.(report);
    work.removeEventListener('abort', kill);
    muxer.kill();
    await exited.catch(() => undefined);
  }
}
