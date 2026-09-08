import type { Writable } from 'node:stream';
import type { VideoStopReason, VideoRecordResult } from './recording-types';
import { NicoClient } from '../../vendor/nico-client/NicoClient';
import { abortableDelay } from '../../vendor/nico-client/abortableDelay';
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
import { WatchSession } from '../nico/watch-session';
import type { HlsStreamInfo } from '../nico/watch-protocol';

// 既存の開発スクリプト等のimport互換用。新規コードは定義元を直接参照する。
export type { VideoStopReason, VideoRecordResult } from './recording-types';

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
  /** 視聴 WebSocket の再接続待ちの基準 (テストで短くする) */
  reconnectBaseDelayMs?: number;
}

const WS_RECONNECT_ATTEMPTS = 5;
const WS_RECONNECT_BASE_DELAY_MS = 2_000;
/** 再接続後にこれだけ切れずに続いたら、試行回数を数え直す */
const WS_RECONNECT_STABLE_MS = 5 * 60 * 1000;
const GRACE_AFTER_END_MS = 5_000;
const REFRESH_COOLDOWN_MS = 2_000;

function cookieHeaderOf(cookies?: Record<string, string>): string | undefined {
  if (!cookies) {
    return undefined;
  }
  const entries = Object.entries(cookies).filter(([, v]) => v.length > 0);
  return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
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
  // 片方のトラックが止まったら、他方の取得・認証更新も中断して再開判断へ戻す
  const tracksController = new AbortController();
  const tracksSignal = AbortSignal.any([tracksController.signal, ...(signal ? [signal] : [])]);

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
      signal: AbortSignal.any([AbortSignal.timeout(20_000), tracksSignal]),
    });
    if (!response.ok) {
      throw new Error(`multivariant playlist の取得に失敗しました (HTTP ${response.status})`);
    }
    return selectBestVariant(parseMultivariantPlaylist(await response.text(), stream.uri));
  };

  // 接続開始から後始末の対象にする。初期化の途中で失敗した場合も、作成済みの資源を解放する
  let muxer: FfmpegMuxer | undefined;
  let stableTimer: NodeJS.Timeout | undefined;
  let devFailTimer: NodeJS.Timeout | undefined;
  let reason: VideoStopReason = 'endlist';
  let finishing = false;
  // 初期化や認証更新の途中でも視聴セッションを閉じ、待機中の処理にも停止を伝える
  const onAbort = (): void => {
    finishing = true;
    reason = 'aborted';
    session.close();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  session.on('error', (error) => logger.warn('watch session error', error));
  try {
    signal?.throwIfAborted();
    await session.connect(signal);
    const initialStream = await session.waitForStream(false, signal);
    const tracks = await fetchMultivariant(initialStream);
    logger.info(
      `recording ${options.programId}: ${tracks.video.resolution ?? '?'} ${tracks.video.bandwidth}bps` +
        (tracks.audioUri ? ' + separate audio' : ' (muxed audio)'),
    );

    muxer = new FfmpegMuxer({
      outputPath: options.outputPath,
      ffmpegPath: options.ffmpegPath,
      separateAudio: Boolean(tracks.audioUri),
      logger,
    });
    const pipes = muxer.start();

    // 403 時の cookie 更新は single-flight にする (映像・音声から同時に呼ばれる)。
    // 更新直後にもう一方のトラックが古い cookie で 403 になっても、張り直しは繰り返さない
    let refreshing: Promise<void> | undefined;
    let refreshedAt = 0;
    const refreshCredentials = (): Promise<void> => {
      if (!refreshing && Date.now() - refreshedAt < REFRESH_COOLDOWN_MS) {
        return Promise.resolve();
      }
      if (!refreshing) {
        refreshing = (async () => {
          const stream = await session.refreshStream(tracksSignal);
          const next = await fetchMultivariant(stream);
          videoTrack.updateSource(next.video.uri);
          if (next.audioUri) {
            audioTrack?.updateSource(next.audioUri);
          }
        })().finally(() => {
          refreshing = undefined;
          refreshedAt = Date.now();
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

    // 再接続は録画全体で 1 つだけ動かし、試行回数も全体で数える。再接続したソケットがすぐ切れても
    // 別のループを起こさない (障害中に接続が束になって増えるのを防ぐ)。
    // 再接続後にしばらく安定して続いたときだけ回数を戻し、長い録画で散発的な切断に耐えられるようにする
    const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? WS_RECONNECT_BASE_DELAY_MS;
    let reconnectTask: Promise<void> | undefined;
    let reconnectAttempts = 0;
    const reconnect = async (): Promise<void> => {
      while (reconnectAttempts < WS_RECONNECT_ATTEMPTS) {
        reconnectAttempts += 1;
        await abortableDelay(reconnectBaseDelayMs * reconnectAttempts, signal);
        if (finishing || signal?.aborted) {
          return;
        }
        try {
          await session.connect(signal);
          await session.waitForStream(true, signal);
          logger.info(
            `watch session reconnected (attempt ${reconnectAttempts}/${WS_RECONNECT_ATTEMPTS})`,
          );
          stableTimer = setTimeout(() => {
            reconnectAttempts = 0;
          }, WS_RECONNECT_STABLE_MS);
          stableTimer.unref();
          return;
        } catch (error) {
          logger.warn(
            `watch session reconnect ${reconnectAttempts}/${WS_RECONNECT_ATTEMPTS} failed`,
            error,
          );
        }
      }
      // 上限に達したら、番組が終わったかを確認して止める
      try {
        const latest = await client.getProgramInfo(signal);
        stopTracks(
          latest.status === NicoLiveProgramStatus.ended ? 'program-ended' : 'disconnected',
        );
      } catch {
        stopTracks('disconnected');
      }
    };
    session.on('close', ({ intentional }) => {
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = undefined;
      }
      if (intentional || finishing || signal?.aborted || reconnectTask) {
        return;
      }
      reconnectTask = reconnect().finally(() => {
        reconnectTask = undefined;
      });
    });

    // 開発用: 再開処理を確かめるために、指定 ms 後に映像を失敗させる
    const devFailAfterMs = Number(process.env['NLR_DEV_FAIL_VIDEO_AFTER_MS'] ?? 0);
    let devFailure: Error | undefined;
    devFailTimer =
      devFailAfterMs > 0
        ? setTimeout(() => {
            if (!finishing) {
              devFailure = new Error('dev: injected video failure');
              videoTrack.requestStop();
              audioTrack?.requestStop();
            }
          }, devFailAfterMs)
        : undefined;

    const runTrack = async (track: HlsTrackDownloader, pipe: Writable): Promise<TrackResult> => {
      try {
        const result = await track.run(pipe, tracksSignal);
        if (result.reason === 'idle') {
          finishing = true;
          reason = 'idle';
          tracksController.abort();
        }
        return result;
      } catch (error) {
        tracksController.abort();
        throw error;
      } finally {
        // 終わった入力はすぐ閉じる。ffmpeg がもう一方の入力を読み進められるようにする
        pipe.end();
      }
    };
    const [videoOutcome, audioOutcome] = await Promise.allSettled([
      runTrack(videoTrack, pipes.video),
      audioTrack && pipes.audio ? runTrack(audioTrack, pipes.audio) : Promise.resolve(undefined),
    ]);
    // 両方の後始末を待ってから失敗を伝え、古い取得処理を次の録画に持ち越さない
    if (videoOutcome.status === 'rejected') {
      throw videoOutcome.reason;
    }
    if (audioOutcome.status === 'rejected') {
      throw audioOutcome.reason;
    }
    const videoResult = videoOutcome.value;
    const audioResult = audioOutcome.value;
    if (devFailure) {
      throw devFailure;
    }
    if (!finishing) {
      reason = videoResult.reason === 'idle' ? 'idle' : 'endlist';
    }
    const exit = await muxer.finish();
    // 多重化に失敗した ts は使えないので、ユーザーの停止以外では失敗として扱う (再開の対象になる)
    if (exit.exitCode !== 0) {
      const detail = `ffmpeg exited with ${exit.exitCode === null ? `signal ${exit.signal ?? '?'}` : `code ${exit.exitCode}`}`;
      if (!signal?.aborted) {
        throw new Error(detail);
      }
      logger.warn(`${detail} after stop request`);
    }
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
    muxer?.kill();
    throw error;
  } finally {
    tracksController.abort();
    signal?.removeEventListener('abort', onAbort);
    if (stableTimer) {
      clearTimeout(stableTimer);
    }
    if (devFailTimer) {
      clearTimeout(devFailTimer);
    }
    session.close();
  }
}
