import path from 'node:path';
import { FfmpegMuxer } from '../../src/main/core/nico/ffmpeg';
import {
  HlsTrackDownloader,
  cookieHeaderFor,
  parseMediaPlaylist,
  parseMultivariantPlaylist,
  selectBestVariant,
} from '../../src/main/core/nico/hls';
import type { HlsStreamInfo } from '../../src/main/core/nico/watch-session';
import { checkedFetch, ProbeError } from './common';

// 最初の playlist の短区間を固定して保存する。追加した ENDLIST は全編完了の証拠にしない。
export function clipPlaylist(text: string, url: string, seconds: number) {
  if (/#EXT-X-(BYTERANGE|DISCONTINUITY|GAP)\b/.test(text))
    throw new ProbeError('UNSUPPORTED_PLAYLIST_TAG');
  const parsed = parseMediaPlaylist(text, url);
  if (!parsed.segments.length) throw new ProbeError('EMPTY_PLAYLIST');
  let duration = 0;
  let count = 0;
  for (const segment of parsed.segments) {
    if (segment.key && segment.key.method !== 'AES-128')
      throw new ProbeError('UNSUPPORTED_ENCRYPTION');
    duration += segment.duration;
    count += 1;
    if (duration >= seconds) break;
  }
  const lines: string[] = [];
  let pendingSegment = false;
  let included = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '#EXT-X-ENDLIST') continue;
    lines.push(line);
    if (line.startsWith('#EXTINF:')) pendingSegment = true;
    if (pendingSegment && line.trim() && !line.startsWith('#')) {
      pendingSegment = false;
      included += 1;
      if (included === count) break;
    }
  }
  const selected = parsed.segments.slice(0, count);
  return {
    text: `${lines.join('\n')}\n#EXT-X-ENDLIST\n`,
    summary: {
      playlistSegments: parsed.segments.length,
      playlistDuration: parsed.segments.reduce((sum, s) => sum + s.duration, 0),
      originalEndList: parsed.endList,
      selectedDuration: duration,
      selectedSegments: count,
      blankSegments: selected.filter((s) => s.uri.includes('/blank/')).length,
      expectedSavedSegments: selected.filter((s) => !s.uri.includes('/blank/')).length,
    },
  };
}

export async function sampleVideo(
  stream: HlsStreamInfo,
  dir: string,
  seconds: number,
  signal: AbortSignal,
  onProgress: (summary: Record<string, unknown>) => void = () => {},
) {
  const controller = new AbortController();
  const workSignal = AbortSignal.any([signal, controller.signal]);
  const get = (url: string) => checkedFetch(url, workSignal, cookieHeaderFor(stream.cookies, url));
  const master = await (await get(stream.uri)).text();
  const tracks = selectBestVariant(parseMultivariantPlaylist(master, stream.uri));
  const urls = [tracks.video.uri, ...(tracks.audioUri ? [tracks.audioUri] : [])];
  const playlists = await Promise.all(
    urls.map(async (url) => clipPlaylist(await (await get(url)).text(), url, seconds)),
  );
  const progress = {
    status: 'downloading',
    tracks: playlists.map((p) => p.summary),
    httpErrors: [] as number[],
    fullCoverage: 'not-verified',
  };
  onProgress(progress);
  const muxer = new FfmpegMuxer({
    outputPath: path.join(dir, 'video.ts'),
    separateAudio: Boolean(tracks.audioUri),
  });
  const pipes = muxer.start();
  // ffmpeg が先に失敗しても、全トラックを停止してプロセス終了まで回収する。
  const exited = muxer.wait();
  void exited.catch(() => controller.abort());
  const kill = (): void => muxer.kill();
  workSignal.addEventListener('abort', kill, { once: true });
  let missingSegments = 0;
  try {
    workSignal.throwIfAborted();
    const tasks = urls.map(async (url, index) => {
      const fetchImpl: typeof fetch = async (input, init) => {
        if (input === url) return new Response(playlists[index].text);
        const response = await fetch(input, init);
        if (!response.ok && !progress.httpErrors.includes(response.status))
          progress.httpErrors.push(response.status);
        if (response.status === 404) missingSegments += 1;
        return response;
      };
      const downloader = new HlsTrackDownloader({
        label: index === 0 ? 'video' : 'audio',
        playlistUrl: url,
        cookies: () => stream.cookies,
        fetchImpl,
      });
      const sink = index === 0 ? pipes.video : pipes.audio!;
      try {
        const result = await downloader.run(sink, workSignal);
        if (result.reason !== 'endlist') throw new ProbeError('TRACK_INCOMPLETE');
        return result;
      } catch (error) {
        controller.abort();
        throw error;
      } finally {
        sink.end();
      }
    });
    const results = await Promise.allSettled(tasks);
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const exit = await muxer.finish();
    if (exit.exitCode !== 0) throw new ProbeError('FFMPEG_FAILED');
    const saved = results.map((r) => {
      if (r.status !== 'fulfilled') throw new ProbeError('TRACK_FAILED');
      return r.value;
    });
    return {
      status:
        missingSegments ||
        saved.some(
          (r, i) => r.segments !== playlists[i].summary.expectedSavedSegments || r.segments === 0,
        )
          ? 'incomplete'
          : 'sample-saved',
      missingSegments,
      tracks: saved.map((result, i) => ({ ...playlists[i].summary, saved: result })),
      fullCoverage: 'not-verified',
      playbackAndSync: 'requires-human-check',
    };
  } finally {
    workSignal.removeEventListener('abort', kill);
    muxer.kill();
    await exited.catch(() => undefined);
  }
}
