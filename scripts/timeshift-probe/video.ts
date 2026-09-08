import path from 'node:path';
import { downloadMetrics, downloadProbeTrack } from './download';
import { FfmpegMuxer } from '../../src/main/core/nico/ffmpeg';
import {
  HlsTrackDownloader,
  cookieHeaderFor,
  parseMediaPlaylist,
  parseMultivariantPlaylist,
  selectBestVariant,
} from '../../src/main/core/nico/hls';
import type { HlsStreamInfo } from '../../src/main/core/nico/watch-session';
import { checkedFetch, ProbeError, ProbeTimings } from './common';

const UNSUPPORTED_TAGS = ['EXT-X-BYTERANGE', 'EXT-X-DISCONTINUITY', 'EXT-X-GAP'];
const OBSERVED_TAGS = [
  ...UNSUPPORTED_TAGS,
  'EXT-X-DISCONTINUITY-SEQUENCE',
  'EXT-X-MAP',
  'EXT-X-KEY',
  'EXT-X-ENDLIST',
];

// タグ名は完全一致で数え、URI・属性値を保存しない。SEQUENCE と実際の不連続境界を区別する。
function inspectTags(text: string) {
  const counts: Record<string, number> = {};
  const firstUnsupportedPositions: { tag: string; segmentIndex: number; atSeconds: number }[] = [];
  let segmentIndex = 0;
  let atSeconds = 0;
  let pendingDuration: number | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const tag = line.startsWith('#') ? line.slice(1).split(':', 1)[0] : '';
    if (OBSERVED_TAGS.includes(tag)) counts[tag] = (counts[tag] ?? 0) + 1;
    if (UNSUPPORTED_TAGS.includes(tag) && firstUnsupportedPositions.length < 20) {
      firstUnsupportedPositions.push({ tag, segmentIndex, atSeconds });
    }
    if (line.startsWith('#EXTINF:')) pendingDuration = Number(line.slice(8).split(',')[0]) || 0;
    if (line && !line.startsWith('#') && pendingDuration !== undefined) {
      segmentIndex += 1;
      atSeconds += pendingDuration;
      pendingDuration = undefined;
    }
  }
  return { counts, firstUnsupportedPositions };
}

// 初回 playlist の短区間を固定する。seconds が null なら元の ENDLIST を要求して全体を選ぶ。
export function clipPlaylist(
  text: string,
  url: string,
  seconds: number | null,
  onDiagnostics: (summary: Record<string, unknown>) => void = () => {},
) {
  const parsed = parseMediaPlaylist(text, url);
  if (seconds === null && !parsed.endList) throw new ProbeError('ORIGINAL_ENDLIST_MISSING');
  if (!parsed.segments.length) throw new ProbeError('EMPTY_PLAYLIST');
  let duration = 0;
  let count = 0;
  for (const segment of parsed.segments) {
    if (segment.key && segment.key.method !== 'AES-128')
      throw new ProbeError('UNSUPPORTED_ENCRYPTION');
    duration += segment.duration;
    count += 1;
    if (seconds !== null && duration >= seconds) break;
  }
  const lines: string[] = [];
  let pendingSegment = false;
  let included = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '#EXT-X-ENDLIST') continue;
    lines.push(line);
    if (line.startsWith('#EXTINF:')) pendingSegment = true;
    if (pendingSegment && line.trim() && !line.startsWith('#')) {
      pendingSegment = false;
      included += 1;
      if (included === count) break;
    }
  }
  const selected = parsed.segments.slice(0, count);
  const selectedText = lines.join('\n');
  const tags = inspectTags(text);
  const selectedTags = inspectTags(selectedText);
  // 保存前の blank 群から最初の本編へ移る境界だけを許可する。本編を一度でも保存した後の
  // 不連続は引き続き拒否する。元の sequence は維持し、AES の暗黙 IV をずらさない。
  const firstSavedIndex = selected.findIndex((s) => !s.uri.includes('/blank/'));
  const leadingBlankBoundaryCount = selectedTags.firstUnsupportedPositions.filter(
    (position) =>
      position.tag === 'EXT-X-DISCONTINUITY' &&
      firstSavedIndex > 0 &&
      position.segmentIndex === firstSavedIndex,
  ).length;
  const unsupportedTags = UNSUPPORTED_TAGS.filter((tag) => {
    const count = selectedTags.counts[tag] ?? 0;
    return tag === 'EXT-X-DISCONTINUITY' ? count > leadingBlankBoundaryCount : count > 0;
  });
  const summary = {
    playlistSegments: parsed.segments.length,
    playlistDuration: parsed.segments.reduce((sum, s) => sum + s.duration, 0),
    originalEndList: parsed.endList,
    selectedDuration: duration,
    selectedSegments: count,
    blankSegments: selected.filter((s) => s.uri.includes('/blank/')).length,
    expectedSavedSegments: selected.filter((s) => !s.uri.includes('/blank/')).length,
    leadingBlankSegments: firstSavedIndex < 0 ? selected.length : firstSavedIndex,
    leadingBlankBoundaryCount,
    savedDuration: selected
      .filter((s) => !s.uri.includes('/blank/'))
      .reduce((sum, s) => sum + s.duration, 0),
    tags,
    selectedTagCounts: selectedTags.counts,
    unsupportedTags,
  };
  // 拒否した playlist も種類・位置を報告する。取得対象外の境界は短区間取得を妨げない。
  onDiagnostics(summary);
  if (unsupportedTags.length) throw new ProbeError('UNSUPPORTED_PLAYLIST_TAG');
  return { text: `${selectedText}\n#EXT-X-ENDLIST\n`, summary };
}

export async function sampleVideo(
  stream: HlsStreamInfo,
  dir: string,
  seconds: number | null,
  signal: AbortSignal,
  onProgress: (summary: Record<string, unknown>) => void = () => {},
  segmentThreads?: number,
) {
  const controller = new AbortController();
  const workSignal = AbortSignal.any([signal, controller.signal]);
  const timings = new ProbeTimings();
  const engine = segmentThreads === undefined ? 'core' : 'probe-prefetch';
  const progress = {
    engine,
    segmentThreads: segmentThreads ?? 1,
    timingsMs: timings.milliseconds,
    status: 'playlists',
    tracks: [] as Record<string, unknown>[],
    httpErrors: [] as number[],
    fullCoverage: 'not-verified',
  };
  onProgress(progress);
  const get = (url: string) => checkedFetch(url, workSignal, cookieHeaderFor(stream.cookies, url));
  const master = await timings.measure('master', async () => (await get(stream.uri)).text());
  const tracks = selectBestVariant(parseMultivariantPlaylist(master, stream.uri));
  const urls = [tracks.video.uri, ...(tracks.audioUri ? [tracks.audioUri] : [])];
  const downloads = urls.map(() => (segmentThreads === undefined ? undefined : downloadMetrics()));
  const playlistResults = await Promise.allSettled(
    urls.map(async (url, index) =>
      timings.measure(index === 0 ? 'videoPlaylist' : 'audioPlaylist', async () =>
        clipPlaylist(await (await get(url)).text(), url, seconds, (summary) => {
          progress.tracks[index] = {
            label: index === 0 ? 'video' : 'audio',
            ...summary,
            download: downloads[index],
          };
        }),
      ),
    ),
  );
  const playlists = playlistResults.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  progress.status = 'downloading';
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
  let trackFailure: unknown;
  let trackFailed = false;
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
        const result = await timings.measure(index === 0 ? 'videoDownload' : 'audioDownload', () =>
          segmentThreads === undefined
            ? downloader.run(sink, workSignal)
            : downloadProbeTrack(
                parseMediaPlaylist(playlists[index].text, url).segments,
                sink,
                stream.cookies,
                segmentThreads,
                workSignal,
                downloads[index]!,
              ),
        );
        if (result.reason !== 'endlist') throw new ProbeError('TRACK_INCOMPLETE');
        return result;
      } catch (error) {
        if (!trackFailed) trackFailure = error;
        trackFailed = true;
        controller.abort();
        throw error;
      } finally {
        sink.end();
      }
    });
    const results = await Promise.allSettled(tasks);
    for (const download of downloads) {
      for (const code of download?.httpErrors ?? []) {
        if (!progress.httpErrors.includes(code)) progress.httpErrors.push(code);
      }
    }
    if (trackFailed) throw trackFailure;
    const exit = await timings.measure('muxerFinish', () => muxer.finish());
    if (exit.exitCode !== 0) throw new ProbeError('FFMPEG_FAILED');
    const saved = results.map((r) => {
      if (r.status !== 'fulfilled') throw new ProbeError('TRACK_FAILED');
      return r.value;
    });
    missingSegments += downloads.reduce(
      (total, download) => total + (download?.missingSegments ?? 0),
      0,
    );
    const complete =
      !missingSegments &&
      saved.every(
        (result, index) =>
          result.segments > 0 && result.segments === playlists[index].summary.expectedSavedSegments,
      );
    let status = 'incomplete';
    if (complete) status = seconds === null ? 'playlist-saved' : 'sample-saved';
    return {
      status,
      engine,
      segmentThreads: segmentThreads ?? 1,
      timingsMs: timings.milliseconds,
      playlistCoverage: complete && seconds === null ? 'complete' : 'not-verified',
      missingSegments,
      tracks: saved.map((result, i) => ({
        label: i === 0 ? 'video' : 'audio',
        ...playlists[i].summary,
        saved: result,
        download: downloads[i],
      })),
      fullCoverage: 'not-verified',
      playbackAndSync: 'requires-human-check',
    };
  } finally {
    workSignal.removeEventListener('abort', kill);
    muxer.kill();
    await exited.catch(() => undefined);
  }
}
