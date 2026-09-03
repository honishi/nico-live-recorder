import { NicoClient } from '../../vendor/nico-client/NicoClient';
import { DEFAULT_USER_AGENT } from '../../vendor/nico-client/internal/userAgent';
import { NicoLiveProgramStatus, type NicoLiveProgramInfo } from '../../vendor/nico-client/types';
import { silentLogger, type Logger } from '../logger';
import { FfmpegMuxer } from '../nico/ffmpeg';
import {
  cookieHeaderFor,
  HlsTrackDownloader,
  parseMultivariantPlaylist,
  selectBestVariant,
  type TrackResult,
} from '../nico/hls';
import { WatchSession, type HlsStreamInfo } from '../nico/watch-session';

export interface VideoRecorderOptions {
  programId: string;
  outputPath: string;
  /** ログイン済み cookie (user_session など)。未指定なら匿名視聴 */
  cookies?: Record<string, string>;
  userAgent?: string;
  ffmpegPath?: string;
  logger?: Logger;
  /** 取得済みの番組情報があれば渡す (視聴ページの再取得を省く) */
  programInfo?: NicoLiveProgramInfo;
}

export type VideoStopReason = 'program-ended' | 'endlist' | 'aborted' | 'idle' | 'disconnected';

export interface VideoRecordResult {
  outputPath: string;
  startedAt: Date;
  endedAt: Date;
  reason: VideoStopReason;
  video: TrackResult;
  audio?: TrackResult;
  ffmpegExitCode: number | null;
}

const WS_RECONNECT_ATTEMPTS = 5;
const WS_RECONNECT_BASE_DELAY_MS = 2_000;
const GRACE_AFTER_END_MS = 5_000;

function cookieHeaderOf(cookies?: Record<string, string>): string | undefined {
  if (!cookies) {
    return undefined;
  }
  const entries = Object.entries(cookies).filter(([, v]) => v.length > 0);
  return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 1 番組の映像を録画する。
 * 視聴 WebSocket → HLS (映像・音声別 playlist) → 復号 → ffmpeg で MPEG-TS に多重化。
 */
export async function recordVideo(
  options: VideoRecorderOptions,
  signal?: AbortSignal,
): Promise<VideoRecordResult> {
  const logger = options.logger ?? silentLogger;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const startedAt = new Date();

  const client = new NicoClient(options.programId, { cookies: options.cookies, userAgent });
  const info = options.programInfo ?? (await client.getProgramInfo(signal));
  if (info.status === NicoLiveProgramStatus.ended) {
    throw new Error(`番組 ${options.programId} は終了済みです`);
  }
  if (!info.webSocketUrl) {
    throw new Error(
      `番組 ${options.programId} の webSocketUrl を取得できませんでした (ログインが必要な番組の可能性)`,
    );
  }

  const session = new WatchSession(info.webSocketUrl, {
    userAgent,
    cookieHeader: cookieHeaderOf(options.cookies),
    logger,
  });

  const fetchMultivariant = async (stream: HlsStreamInfo) => {
    const response = await fetch(stream.uri, {
      headers: { 'user-agent': userAgent, cookie: cookieHeaderFor(stream.cookies, stream.uri) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`multivariant playlist の取得に失敗しました (HTTP ${response.status})`);
    }
    return selectBestVariant(parseMultivariantPlaylist(await response.text(), stream.uri));
  };

  await session.connect();
  const initialStream = await session.waitForStream();
  const tracks = await fetchMultivariant(initialStream);
  logger.info(
    `recording ${options.programId}: ${tracks.video.resolution ?? '?'} ${tracks.video.bandwidth}bps` +
      (tracks.audioUri ? ' + separate audio' : ' (muxed audio)'),
  );

  const muxer = new FfmpegMuxer({
    outputPath: options.outputPath,
    ffmpegPath: options.ffmpegPath,
    separateAudio: Boolean(tracks.audioUri),
    logger,
  });
  const pipes = muxer.start();

  // 403 時の cookie 更新は single-flight にする (映像・音声から同時に呼ばれる)
  let refreshing: Promise<void> | undefined;
  const refreshCredentials = (): Promise<void> => {
    if (!refreshing) {
      refreshing = (async () => {
        const stream = await session.refreshStream();
        const next = await fetchMultivariant(stream);
        videoTrack.updateSource(next.video.uri);
        if (next.audioUri) {
          audioTrack?.updateSource(next.audioUri);
        }
      })().finally(() => {
        refreshing = undefined;
      });
    }
    return refreshing;
  };

  const trackOptions = {
    cookies: () => session.latestStreamInfo?.cookies ?? initialStream.cookies,
    userAgent,
    logger,
    onForbidden: refreshCredentials,
  };
  const videoTrack = new HlsTrackDownloader({
    ...trackOptions,
    label: 'video',
    playlistUrl: tracks.video.uri,
  });
  const audioTrack = tracks.audioUri
    ? new HlsTrackDownloader({ ...trackOptions, label: 'audio', playlistUrl: tracks.audioUri })
    : undefined;

  let reason: VideoStopReason = 'endlist';
  let finishing = false;
  const stopTracks = (why: VideoStopReason): void => {
    if (finishing) {
      return;
    }
    finishing = true;
    reason = why;
    // 番組終了後も playlist に残りのセグメントが載るので少し待ってから止める
    setTimeout(() => {
      videoTrack.requestStop();
      audioTrack?.requestStop();
    }, GRACE_AFTER_END_MS);
  };

  session.on('ended', () => stopTracks('program-ended'));
  session.on('disconnect', (why) => {
    logger.warn(`watch session disconnected by server: ${why}`);
  });
  session.on('error', (error) => logger.warn('watch session error', error));
  session.on('close', ({ intentional }) => {
    if (intentional || finishing || signal?.aborted) {
      return;
    }
    void (async () => {
      for (let attempt = 1; attempt <= WS_RECONNECT_ATTEMPTS; attempt += 1) {
        if (finishing || signal?.aborted) {
          return;
        }
        await delay(WS_RECONNECT_BASE_DELAY_MS * attempt);
        try {
          await session.connect();
          await session.waitForStream(true);
          logger.info('watch session reconnected');
          return;
        } catch (error) {
          logger.warn(`watch session reconnect ${attempt}/${WS_RECONNECT_ATTEMPTS} failed`, error);
        }
      }
      // 再接続できない場合は番組が終わったかを確認して止める
      try {
        const latest = await client.getProgramInfo();
        stopTracks(
          latest.status === NicoLiveProgramStatus.ended ? 'program-ended' : 'disconnected',
        );
      } catch {
        stopTracks('disconnected');
      }
    })();
  });

  const onAbort = (): void => {
    finishing = true;
    reason = 'aborted';
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const [videoResult, audioResult] = await Promise.all([
      videoTrack.run(pipes.video, signal),
      audioTrack && pipes.audio ? audioTrack.run(pipes.audio, signal) : Promise.resolve(undefined),
    ]);
    if (!finishing) {
      reason = videoResult.reason === 'idle' ? 'idle' : 'endlist';
    }
    const exit = await muxer.finish();
    return {
      outputPath: options.outputPath,
      startedAt,
      endedAt: new Date(),
      reason: signal?.aborted ? 'aborted' : reason,
      video: videoResult,
      audio: audioResult,
      ffmpegExitCode: exit.exitCode,
    };
  } catch (error) {
    muxer.kill();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    session.close();
  }
}
