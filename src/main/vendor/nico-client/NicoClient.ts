import WebSocket from 'ws';
import { abortableDelay } from './abortableDelay';
import * as cheerio from 'cheerio';
import type { Type as ProtobufType } from 'protobufjs';
import { CookieJar, HttpClient, HttpError } from './internal/httpClient';
import { DEFAULT_USER_AGENT } from './internal/userAgent';
import { ProtobufStreamReader } from './internal/protobufStreamReader';
import { int64ToSafeInteger } from './internal/int64';
import { getProtoRegistry } from './internal/protoLoader';
import { CommentViewStalledError, ViewUriNotReceivedError, ViewUriTimeoutError } from './errors';
import { isRetryableNicoError, isRetryableNicoHttpStatus } from './retryPolicy';
import {
  CommentColor,
  CommentColorName,
  CommentFullColor,
  CommentFont,
  CommentOpacity,
  CommentPosition,
  CommentSize,
  NicoComment,
  NicoClientOptions,
  NicoLiveProgramInfo,
  NicoLiveProgramStatus,
  NicoStreamDiagnosticsListener,
  StreamOptions,
} from './types';

export class ProgramNotFoundError extends Error {
  public readonly statusCode = 404;

  constructor(
    public readonly programId: string,
    public readonly url: string,
    public readonly originalError?: HttpError,
  ) {
    super(`番組 ${programId} の視聴ページ (${url}) が見つかりませんでした。`);
    this.name = 'ProgramNotFoundError';
  }
}

interface Logger {
  verbose: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface StreamState {
  nextAt?: string;
  nextReadyAt?: string;
  hasNextMarker: boolean;
  seenSegments: Set<string>;
  segmentHistory: string[];
  seenMessageIds: Set<string>;
  processedBackwardUris: Set<string>;
  reconnectCount: number;
  readonly prefetchBackward: boolean;
  /** 現在の viewUri で backward walk を実行済みか (#132)。viewUri 再取得時にリセットされる */
  backwardPrefetchDone: boolean;
  readonly diagnostics?: NicoStreamDiagnosticsListener;
}

interface BackwardWalkStats {
  packedSegments: number;
  comments: number;
  emitted: number;
  dropped: number;
  bytes: number;
  minNo?: number;
  maxNo?: number;
}

interface RetryOptions {
  shouldRetry?: (error: unknown) => boolean;
  backoffMs?: number[];
  maxAttempts?: number;
  signal?: AbortSignal;
}

function createLogger(partial?: NicoClientOptions['logger']): Logger {
  const noop = () => undefined;
  const verbose = partial?.verbose ?? partial?.debug ?? noop;
  const debug = partial?.debug ?? verbose;
  return {
    verbose,
    debug,
    info: partial?.info ?? noop,
    warn: partial?.warn ?? noop,
    error: partial?.error ?? noop,
  };
}

const POSITION_MAP: CommentPosition[] = ['naka', 'shita', 'ue'];
const SIZE_MAP: CommentSize[] = ['medium', 'small', 'big'];
const FONT_MAP: CommentFont[] = ['defont', 'mincho', 'gothic'];
const OPACITY_MAP: CommentOpacity[] = ['Normal', 'Translucent'];
const ACCOUNT_STATUS_MAP = ['Standard', 'Premium'] as const;
const COLOR_NAME_MAP: CommentColorName[] = [
  'white',
  'red',
  'pink',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'black',
  'white2',
  'red2',
  'pink2',
  'orange2',
  'yellow2',
  'green2',
  'cyan2',
  'blue2',
  'purple2',
  'black2',
];

const RAW_STATUS_MAP: Record<string, NicoLiveProgramStatus> = {
  ON_AIR: NicoLiveProgramStatus.onAir,
  ENDED: NicoLiveProgramStatus.ended,
  RELEASED: NicoLiveProgramStatus.released,
};

function normalizeProgramStatus(value: unknown): NicoLiveProgramStatus {
  if (typeof value !== 'string') {
    return NicoLiveProgramStatus.unknown;
  }
  const normalized = RAW_STATUS_MAP[value.toUpperCase()];
  return normalized ?? NicoLiveProgramStatus.unknown;
}

export class NicoClient {
  private readonly cookieJar: CookieJar;
  private readonly http: HttpClient;
  private readonly protoRegistryPromise = getProtoRegistry();
  private readonly logger: Logger;
  private readonly viewUriTimeoutMs: number;
  private programEnded = false;

  static readonly ProgramEndedErrorName = 'ProgramEndedError';
  static readonly AccessDeniedErrorName = 'AccessDeniedError';
  private static readonly defaultRetryBackoffMs = [1000, 2000, 4000];
  private static readonly defaultViewUriTimeoutMs = 15000;
  private static readonly minViewIntervalMs = 1000;
  private static readonly maxStalledViews = 10;
  private static readonly viewRecoveryTimeoutMs = 10 * 60_000;
  private static readonly maxViewBackoffMs = 30_000;

  constructor(
    private readonly programId: string,
    options: NicoClientOptions = {},
  ) {
    this.cookieJar = new CookieJar(options.cookies);
    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.http = new HttpClient(userAgent, this.cookieJar);
    this.logger = createLogger(options.logger);
    this.viewUriTimeoutMs = options.viewUriTimeoutMs ?? NicoClient.defaultViewUriTimeoutMs;
  }

  async getProgramInfo(signal?: AbortSignal): Promise<NicoLiveProgramInfo> {
    return this.fetchProgramInfo(signal);
  }

  async *streamComments(
    options: StreamOptions = {},
    initialProgramInfo?: NicoLiveProgramInfo,
  ): AsyncGenerator<NicoComment> {
    if (options.signal?.aborted) {
      return;
    }

    let programInfo: NicoLiveProgramInfo;
    try {
      programInfo = initialProgramInfo ?? (await this.fetchProgramInfo(options.signal));
      const webSocketUrl = this.requireStreamableWebSocketUrl(programInfo);
      this.programEnded = false;

      this.logger.info(
        `番組タイトル: ${programInfo.title} (${programInfo.nicoliveProgramId}) [${programInfo.status}]`,
      );

      let viewUri = await this.fetchViewUri(webSocketUrl, options.signal);

      const state = this.createStreamState(options);
      state.nextAt = options.startPosition === 'lastKnown' ? undefined : 'now';

      let lastViewStartedAt = -Infinity;
      let latestCursor: number | undefined;
      let stalledViews = 0;
      let stalledSince: number | undefined;

      while (!options.signal?.aborted) {
        // 即時応答は最低1秒、停滞中は最大30秒に間隔を延ばして回復を待つ。
        const intervalMs = Math.min(
          NicoClient.maxViewBackoffMs,
          NicoClient.minViewIntervalMs * 2 ** Math.min(Math.max(stalledViews - 1, 0), 5),
        );
        const waitMs = intervalMs - (performance.now() - lastViewStartedAt);
        if (waitMs > 0) await this.delay(waitMs, options.signal);
        if (options.signal?.aborted) return;
        lastViewStartedAt = performance.now();
        this.resetStreamState(state);

        for await (const comment of this.processChunkEntries(viewUri, state, options)) {
          if (options.signal?.aborted) {
            return;
          }
          yield comment;
        }

        if (this.programEnded) {
          this.logger.info('番組終了検知によりコメントストリームを終了します。');
          break;
        }

        if (options.signal?.aborted) {
          return;
        }

        // viewUri 失効 (View API の 403/404) はここで回復せず throw する。0b5dc04b/d187d975 の
        // インライン回復は 2026-07-19 障害の切り分けで、障害前の既知の実装に戻すため revert した (#102 参照)。
        // 注意: 403/404 は retryPolicy の対象外で NicoListener もリトライしない (404 は not_found 扱い)
        // ため、失効するとその番組の収集はそこで終了する。これは 477884f0 以前と同じ挙動で、
        // 失効が実運用上稀であることを踏まえて許容している。回復パスを再導入する場合、
        // 再取得後は backward walk が 1 回だけ再実行され (#132)、その重複は無制限の
        // seenMessageIds が吸収する (shouldEmitComment のコメント参照。#102 / #134)
        if (!state.hasNextMarker) {
          if (options.signal?.aborted) {
            return;
          }
          this.logger.warn(
            'ChunkedEntry.next が取得できなかったため、viewUri を再取得してストリーミングを継続します。',
          );
          try {
            programInfo = await this.fetchProgramInfo(options.signal);
            const nextWebSocketUrl = this.requireStreamableWebSocketUrl(programInfo);
            viewUri = await this.fetchViewUri(nextWebSocketUrl, options.signal);
          } catch (error) {
            if (error instanceof Error && error.name === NicoClient.ProgramEndedErrorName) {
              this.logger.warn?.('番組が終了したためストリーミングを終了します。');
              break;
            }
            throw error;
          }
          state.nextAt = 'now';
          // 再取得までの隙間で取りこぼしたコメントを回復するため、新しい viewUri での
          // backward walk を 1 回だけ再許可する (重複は seenMessageIds が吸収する。#132/#134)
          state.backwardPrefetchDone = false;
          state.reconnectCount += 1;
          this.logger.verbose?.(
            `Reconnected to viewUri ${viewUri} (count=${state.reconnectCount}).`,
          );
          await this.delay(1000, options.signal);
          continue;
        }

        // 投稿件数ではなく取得位置を見る。後退や循環で古い履歴を取り直し続けない。
        const nextCursor = Number(state.nextReadyAt);
        if (latestCursor !== undefined && nextCursor <= latestCursor) {
          stalledViews += 1;
          stalledSince ??= performance.now();
          // 回数だけですぐ諦めず、10分以上回復しない場合に限って停止する。
          if (
            stalledViews >= NicoClient.maxStalledViews &&
            performance.now() - stalledSince >= NicoClient.viewRecoveryTimeoutMs
          )
            throw new CommentViewStalledError();
        } else {
          latestCursor = nextCursor;
          stalledViews = 0;
          stalledSince = undefined;
        }
        state.nextAt = String(latestCursor);
      }
    } catch (error) {
      if (error instanceof Error && error.name === NicoClient.ProgramEndedErrorName) {
        this.logger.debug?.('指定された番組は終了済みです。コメント取得はスキップします。');
        return;
      }
      throw error;
    }
  }

  private parseNextAt(value: unknown): string | undefined {
    const numeric = int64ToSafeInteger(value);
    return numeric === undefined ? undefined : String(numeric);
  }

  private rememberSegment(uri: string, seen: Set<string>, history: string[], limit = 256): boolean {
    if (seen.has(uri)) {
      return false;
    }
    seen.add(uri);
    history.push(uri);
    if (history.length > limit) {
      const oldest = history.shift();
      if (oldest) {
        seen.delete(oldest);
      }
    }
    return true;
  }

  private static createAbortError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    await abortableDelay(ms, signal);
  }

  private async fetchProgramInfo(signal?: AbortSignal): Promise<NicoLiveProgramInfo> {
    const url = `https://live.nicovideo.jp/watch/${this.programId}`;
    let html: string;
    try {
      html = await this.http.getText(url, { signal });
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) {
        throw new ProgramNotFoundError(this.programId, url, error);
      }
      throw error;
    }
    const $ = cheerio.load(html);
    const embedded = $('#embedded-data');
    const props = embedded.attr('data-props');
    if (!props) {
      throw new Error(
        '視聴ページから番組情報を取得できませんでした (data-props が見つかりません)。',
      );
    }
    const parsed = JSON.parse(props) as Record<string, any>;
    const program = parsed.program;
    const site = parsed.site;
    const relive = site?.relive;
    if (!program || !relive) {
      throw new Error('番組情報の解析に失敗しました。');
    }

    const supplier = program?.supplier ?? {};
    const providerIdRaw =
      typeof supplier?.programProviderId !== 'undefined'
        ? supplier.programProviderId
        : supplier?.id;
    const providerId =
      typeof providerIdRaw === 'number'
        ? String(providerIdRaw)
        : typeof providerIdRaw === 'string'
          ? providerIdRaw
          : undefined;
    const providerName =
      typeof supplier?.name === 'string' && supplier.name.trim().length > 0
        ? String(supplier.name)
        : undefined;
    const providerLevel =
      typeof supplier?.level === 'number' && Number.isFinite(supplier.level)
        ? Math.trunc(supplier.level)
        : undefined;

    const webSocketUrl =
      typeof relive.webSocketUrl === 'string' && relive.webSocketUrl.length > 0
        ? String(relive.webSocketUrl)
        : undefined;

    const screenshot = program?.screenshot?.urlSet ?? {};
    const largeScreenshotUrl = typeof screenshot.large === 'string' ? screenshot.large : undefined;
    const middleScreenshotUrl =
      typeof screenshot.middle === 'string' ? screenshot.middle : undefined;
    const smallScreenshotUrl = typeof screenshot.small === 'string' ? screenshot.small : undefined;
    const microScreenshotUrl = typeof screenshot.micro === 'string' ? screenshot.micro : undefined;
    const ogImageUrl = $('meta[property="og:image"]').attr('content')?.trim();
    const twitterImageUrl = $('meta[name="twitter:image"]').attr('content')?.trim();
    const openGraphImageUrl = ogImageUrl || twitterImageUrl || undefined;
    const thumbnailUrl = largeScreenshotUrl;
    const programTimeshift = parsed.programTimeshift;
    const timeshiftStatus =
      typeof programTimeshift?.publication?.status === 'string'
        ? String(programTimeshift.publication.status)
        : undefined;
    const hasTimeshift = timeshiftStatus === 'Open';

    const supplierIntroduction =
      typeof program?.supplier?.introduction === 'string'
        ? String(program.supplier.introduction)
        : '';

    const statistics = program?.statistics ?? {};
    const parseNonNegativeInteger = (value: unknown): number => {
      const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
      if (!Number.isFinite(num) || num < 0) {
        return 0;
      }
      return Math.trunc(num);
    };
    const commentCount = parseNonNegativeInteger(statistics.commentCount);
    const watchCount = parseNonNegativeInteger(statistics.watchCount);

    const info: NicoLiveProgramInfo = {
      nicoliveProgramId: String(program.nicoliveProgramId),
      title: String(program.title ?? ''),
      description: String(program.description ?? ''),
      providerId,
      providerName,
      providerLevel,
      status: normalizeProgramStatus(program.status),
      openTime: Number(program.openTime ?? 0),
      beginTime: Number(program.beginTime ?? 0),
      vposBaseTime: Number(program.vposBaseTime ?? 0),
      endTime: Number(program.endTime ?? 0),
      scheduledEndTime: Number(program.scheduledEndTime ?? 0),
      webSocketUrl,
      thumbnailUrl,
      openGraphImageUrl,
      largeScreenshotUrl,
      middleScreenshotUrl,
      smallScreenshotUrl,
      microScreenshotUrl,
      hasTimeshift,
      supplierIntroduction,
      commentCount,
      watchCount,
    };

    return info;
  }

  private requireStreamableWebSocketUrl(programInfo: NicoLiveProgramInfo): string {
    if (programInfo.status === NicoLiveProgramStatus.ended) {
      const error = new Error('番組は終了済みです。コメントストリームは取得できません。');
      error.name = NicoClient.ProgramEndedErrorName;
      throw error;
    }
    if (!programInfo.webSocketUrl) {
      const error = new Error(
        'webSocketUrl が取得できませんでした。ログインが必要な番組の可能性があります。',
      );
      error.name = NicoClient.AccessDeniedErrorName;
      throw error;
    }
    return programInfo.webSocketUrl;
  }

  private async fetchViewUri(webSocketUrl: string, signal?: AbortSignal): Promise<string> {
    return this.retryWithBackoff('fetchViewUri', () => this.openViewSocket(webSocketUrl, signal), {
      signal,
    });
  }

  private async retryWithBackoff<T>(
    operationName: string,
    action: () => Promise<T>,
    options: RetryOptions = {},
  ): Promise<T> {
    const backoff = (options.backoffMs ?? NicoClient.defaultRetryBackoffMs).filter((ms) => ms >= 0);
    const resolvedBackoff = backoff.length > 0 ? backoff : [0];
    const maxAttempts = Math.max(options.maxAttempts ?? resolvedBackoff.length, 1);
    const shouldRetryFn =
      options.shouldRetry ?? ((error: unknown) => this.shouldRetryDefault(error));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) {
        throw NicoClient.createAbortError(`[${operationName}] リトライが中断されました。`);
      }
      try {
        return await action();
      } catch (error) {
        const shouldRetry = shouldRetryFn(error);
        const isLastAttempt = attempt === maxAttempts;
        if (!shouldRetry || isLastAttempt) {
          throw error;
        }

        const waitMs =
          resolvedBackoff[Math.min(attempt - 1, resolvedBackoff.length - 1)] ??
          resolvedBackoff[resolvedBackoff.length - 1];
        const message =
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : 'unknown error';

        this.logger.warn?.(
          `[${operationName}] リトライ ${attempt + 1}/${maxAttempts} を ${waitMs}ms 後に実行します: ${message}`,
        );

        if (waitMs > 0) {
          await this.delay(waitMs, options.signal);
        }
      }
    }

    throw new Error(`[${operationName}] リトライが予期せず終了しました。`);
  }

  private shouldRetryDefault(error: unknown): boolean {
    return isRetryableNicoError(error);
  }

  private async openViewSocket(webSocketUrl: string, signal?: AbortSignal): Promise<string> {
    if (!webSocketUrl) {
      throw new Error('webSocketUrl が空です。');
    }
    if (signal?.aborted) {
      throw NicoClient.createAbortError('WebSocket 接続が中断されました。');
    }

    const cookieHeader = this.cookieJar.serialize();

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const ws = new WebSocket(webSocketUrl, {
        headers: {
          'User-Agent': this.http.userAgent ?? DEFAULT_USER_AGENT,
          Origin: 'https://live.nicovideo.jp',
          Cookie: cookieHeader ?? '',
        },
      });

      // サーバーが接続受理後に無応答のままだと Promise が永久に settle しないため、
      // 接続開始から messageServer 受信までの全体デッドラインを設ける
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new ViewUriTimeoutError(this.viewUriTimeoutMs));
        // CONNECTING 中の terminate() は nextTick で error を emit するため、
        // 既存の error/close ハンドラを残したまま破棄して未処理 error を防ぐ
        ws.terminate();
      }, this.viewUriTimeoutMs);

      // abort 時はタイムアウトを待たずに即座に reject して接続を破棄する。
      // 残りの後始末は terminate() が emit する error/close 経由の cleanup に任せる
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(NicoClient.createAbortError('WebSocket 接続が中断されました。'));
        ws.terminate();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        ws.removeAllListeners();
        // close ハンドシェイク中のソケットエラー (ECONNRESET 等) でリスナー不在の
        // 'error' が emit されると uncaughtException になるため、no-op を残す
        ws.on('error', () => {});
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      };

      ws.once('open', () => {
        ws.send(
          JSON.stringify({
            type: 'startWatching',
            data: {
              reconnect: false,
            },
          }),
        );
      });

      ws.on('message', (raw) => {
        try {
          const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
          const payload = JSON.parse(text) as Record<string, any>;
          if (payload.type === 'messageServer' && payload.data?.viewUri) {
            cleanup();
            settled = true;
            resolve(String(payload.data.viewUri));
          }
        } catch (error) {
          cleanup();
          settled = true;
          reject(error);
        }
      });

      ws.once('error', (error) => {
        cleanup();
        settled = true;
        reject(error);
      });

      ws.once('close', () => {
        cleanup();
        if (!settled) {
          settled = true;
          reject(new ViewUriNotReceivedError());
        }
      });
    });
  }

  private async *fetchChunkedEntries(
    viewUri: string,
    at: string | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<any, void, unknown> {
    const target = this.buildViewApiTarget(viewUri, at);
    const registry = await this.protoRegistryPromise;
    yield* this.decodeProtobufStream(
      target,
      registry.ChunkedEntry,
      signal,
      'NDGR View API ストリームが中断されました。',
      'NDGR View API からの取得に失敗しました',
    );
  }

  private buildViewApiTarget(viewUri: string, at: string | undefined): string {
    if (!at) {
      return viewUri;
    }
    const separator = viewUri.includes('?') ? '&' : '?';
    return `${viewUri}${separator}at=${encodeURIComponent(at)}`;
  }

  private createStreamState(options: StreamOptions): StreamState {
    return {
      nextAt: undefined,
      nextReadyAt: undefined,
      hasNextMarker: false,
      seenSegments: new Set<string>(),
      segmentHistory: [],
      seenMessageIds: new Set<string>(),
      processedBackwardUris: new Set<string>(),
      reconnectCount: 0,
      prefetchBackward: options.prefetchBackward ?? true,
      backwardPrefetchDone: false,
      diagnostics: options.diagnostics,
    };
  }

  private resetStreamState(state: StreamState): void {
    state.nextReadyAt = undefined;
    state.hasNextMarker = false;
  }

  private async *processChunkEntries(
    viewUri: string,
    state: StreamState,
    options: StreamOptions,
  ): AsyncGenerator<NicoComment, void, undefined> {
    state.diagnostics?.({
      type: 'poll_request',
      viewUri,
      at: state.nextAt,
      reconnectCount: state.reconnectCount,
    });

    let entryIndex = 0;
    for await (const entry of this.fetchChunkedEntries(viewUri, state.nextAt, options.signal)) {
      if (options.signal?.aborted) {
        return;
      }

      entryIndex += 1;
      this.logger.verbose?.(
        `[ChunkedEntry ${entryIndex}] segment=${Boolean(entry.segment)} previous=${Boolean(entry.previous)} backward=${Boolean(entry.backward)} next=${entry.next?.at ?? 'none'}`,
      );

      const parsedNext = this.parseNextAt(entry.next?.at);
      if (parsedNext !== undefined) {
        state.nextReadyAt = parsedNext;
        state.hasNextMarker = true;
      }

      const backwardUri: string | undefined = entry.backward?.segment?.uri || undefined;
      state.diagnostics?.({
        type: 'chunked_entry',
        entryIndex,
        hasSegment: Boolean(entry.segment),
        hasPrevious: Boolean(entry.previous),
        backwardUri,
        backwardAlreadyProcessed: backwardUri
          ? state.processedBackwardUris.has(backwardUri)
          : undefined,
        backwardPrefetchSkipped:
          backwardUri && state.prefetchBackward ? state.backwardPrefetchDone : undefined,
        nextAt: parsedNext,
      });

      if (state.prefetchBackward && backwardUri && !state.backwardPrefetchDone) {
        yield* this.handleBackwardSegment(backwardUri, state, options.signal);
      }

      yield* this.processSegmentUris(entry, state, options.signal);

      if (this.programEnded) {
        return;
      }
    }
  }

  // backward URI は約 32 秒のポーリング接続ごとに別の URI で配り直され、毎回番組開始までの
  // 全履歴を指す (#135 の実測: 30 分で 57 walk / 受信の約 98% が重複)。そのため walk は
  // viewUri 取得ごとに 1 回だけ実行し (backwardPrefetchDone)、以降の backward はスキップ
  // する (#132)。processedBackwardUris の同一 URI チェックは補助的なガードにすぎない。
  // walk 内の重複排除は shouldEmitComment (無制限の seenMessageIds) が担う
  private async *handleBackwardSegment(
    uri: string,
    state: StreamState,
    signal?: AbortSignal,
  ): AsyncGenerator<NicoComment, void, undefined> {
    if (state.processedBackwardUris.has(uri)) {
      return;
    }
    state.processedBackwardUris.add(uri);
    const stats: BackwardWalkStats = {
      packedSegments: 0,
      comments: 0,
      emitted: 0,
      dropped: 0,
      bytes: 0,
    };
    const startedAt = Date.now();
    yield* this.fetchBackwardComments(uri, state, signal, stats);
    state.backwardPrefetchDone = true;
    state.diagnostics?.({
      type: 'backward_walk',
      startUri: uri,
      packedSegments: stats.packedSegments,
      comments: stats.comments,
      emitted: stats.emitted,
      dropped: stats.dropped,
      bytes: stats.bytes,
      durationMs: Date.now() - startedAt,
      minNo: stats.minNo,
      maxNo: stats.maxNo,
    });
    this.logger.verbose?.(`[Backward] ${uri} restored ${stats.emitted} comments.`);
  }

  private collectSegmentUris(entry: any): string[] {
    const uris: string[] = [];
    if (entry.segment?.uri) {
      uris.push(entry.segment.uri);
    }
    if (entry.previous?.uri) {
      uris.push(entry.previous.uri);
    }
    return uris;
  }

  private async *processSegmentUris(
    entry: any,
    state: StreamState,
    signal?: AbortSignal,
  ): AsyncGenerator<NicoComment, void, undefined> {
    const segmentUris = this.collectSegmentUris(entry);
    for (const segmentUri of segmentUris) {
      if (!this.rememberSegment(segmentUri, state.seenSegments, state.segmentHistory)) {
        continue;
      }

      let emitted = 0;
      let dropped = 0;
      for await (const comment of this.fetchChunkedMessages(segmentUri, signal)) {
        if (signal?.aborted) {
          return;
        }
        const shouldEmit = this.shouldEmitComment(comment, state);
        state.diagnostics?.({
          type: 'comment',
          route: 'forward',
          emitted: shouldEmit,
          id: comment.id,
          no: comment.no,
          at: comment.at.toISOString(),
          content: comment.content,
        });
        if (!shouldEmit) {
          dropped += 1;
          continue;
        }
        emitted += 1;
        yield comment;
      }
      state.diagnostics?.({ type: 'segment', uri: segmentUri, emitted, dropped });
      this.logger.verbose?.(`[Segment] ${segmentUri} completed with ${emitted} comments.`);
      if (this.programEnded) {
        return;
      }
    }
  }

  private async *fetchChunkedMessages(
    segmentUri: string,
    signal?: AbortSignal,
  ): AsyncGenerator<NicoComment, void, unknown> {
    const registry = await this.protoRegistryPromise;
    for await (const decoded of this.decodeProtobufStream(
      segmentUri,
      registry.ChunkedMessage,
      signal,
      'NDGR Segment API ストリームが中断されました。',
      'NDGR Segment API からの取得に失敗しました',
    )) {
      const message = decoded as any;
      if (message?.state?.program_status?.state === 1) {
        if (!this.programEnded) {
          this.programEnded = true;
          this.logger.info('番組終了ステータスを受信しました。コメントストリームを停止します。');
        }
        return;
      }
      const comment = this.convertChunkedMessage(message);
      if (comment) {
        yield comment;
      }
    }
  }

  private async *fetchPackedSegments(
    uri: string,
    signal?: AbortSignal,
    stats?: BackwardWalkStats,
  ): AsyncGenerator<any, void, unknown> {
    const registry = await this.protoRegistryPromise;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of this.http.stream(uri, { signal })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stats) {
          stats.bytes += buffer.length;
        }
        chunks.push(buffer);
      }
    } catch (error) {
      if (signal?.aborted && error instanceof Error && error.name === 'AbortError') {
        this.logger.verbose('NDGR Backward API ストリームが中断されました。');
        return;
      }
      if (error instanceof HttpError) {
        this.logHttpErrorWithRetryLevel('NDGR Backward API からの取得に失敗しました', error);
      }
      throw error;
    }

    if (chunks.length === 0) {
      return;
    }

    const buffer = Buffer.concat(chunks);
    yield registry.PackedSegment.decode(buffer);
  }

  private async *fetchBackwardComments(
    backwardUri: string,
    state: StreamState,
    signal?: AbortSignal,
    stats?: BackwardWalkStats,
  ): AsyncGenerator<NicoComment, void, unknown> {
    const visited = new Set<string>();
    let current: string | undefined = backwardUri;

    while (current && !visited.has(current)) {
      visited.add(current);
      let nextUri: string | undefined;

      for await (const packed of this.fetchPackedSegments(current, signal, stats)) {
        const packedSegment = packed as any;
        if (stats) {
          stats.packedSegments += 1;
        }
        if (Array.isArray(packedSegment?.messages)) {
          for (const message of packedSegment.messages) {
            const comment = this.convertChunkedMessage(message);
            if (!comment) {
              continue;
            }
            if (stats) {
              stats.comments += 1;
              if (comment.no > 0) {
                stats.minNo =
                  stats.minNo === undefined ? comment.no : Math.min(stats.minNo, comment.no);
                stats.maxNo =
                  stats.maxNo === undefined ? comment.no : Math.max(stats.maxNo, comment.no);
              }
            }
            const shouldEmit = this.shouldEmitComment(comment, state);
            state.diagnostics?.({
              type: 'comment',
              route: 'backward',
              emitted: shouldEmit,
              id: comment.id,
              no: comment.no,
              at: comment.at.toISOString(),
              content: comment.content,
            });
            if (shouldEmit) {
              if (stats) {
                stats.emitted += 1;
              }
              yield comment;
            } else if (stats) {
              stats.dropped += 1;
            }
          }
        }
        if (packedSegment?.next?.uri) {
          nextUri = packedSegment.next.uri;
        }
      }

      current = nextUri;
    }
  }

  private async *decodeProtobufStream<T>(
    uri: string,
    type: ProtobufType,
    signal: AbortSignal | undefined,
    abortLog: string,
    httpErrorLog: string,
  ): AsyncGenerator<T, void, unknown> {
    const reader = new ProtobufStreamReader();
    try {
      for await (const chunk of this.http.stream(uri, { signal })) {
        reader.addChunk(chunk);
        while (true) {
          const message = reader.unshift();
          if (!message) {
            break;
          }
          yield type.decode(message) as T;
        }
      }
    } catch (error) {
      if (signal?.aborted && error instanceof Error && error.name === 'AbortError') {
        this.logger.verbose(abortLog);
        return;
      }
      if (error instanceof HttpError) {
        this.logHttpErrorWithRetryLevel(httpErrorLog, error);
      }
      throw error;
    }
  }

  private logHttpErrorWithRetryLevel(message: string, error: HttpError): void {
    const logMessage = `${message}: ${error.message}`;
    if (isRetryableNicoHttpStatus(error.statusCode)) {
      this.logger.warn?.(logMessage);
      return;
    }
    this.logger.error?.(logMessage);
  }

  private convertChunkedMessage(decoded: any): NicoComment | undefined {
    const meta = decoded.meta;
    if (!meta) {
      return undefined;
    }
    const message = decoded.message ?? decoded.payload;
    if (!message) {
      return undefined;
    }

    const candidateChat = message.chat ?? message.overflowed_chat;
    if (!candidateChat || !candidateChat.modifier) {
      return undefined;
    }

    const at = this.toDate(meta.at);
    const liveId = this.getLiveId(meta);
    const color = this.toCommentColor(candidateChat.modifier);

    const accountStatusIndex = candidateChat.account_status ?? 0;
    const accountStatus = ACCOUNT_STATUS_MAP[accountStatusIndex] ?? 'Standard';

    const position = POSITION_MAP[candidateChat.modifier.position ?? 0] ?? 'naka';
    const size = SIZE_MAP[candidateChat.modifier.size ?? 0] ?? 'medium';
    const font = FONT_MAP[candidateChat.modifier.font ?? 0] ?? 'defont';
    const opacity = OPACITY_MAP[candidateChat.modifier.opacity ?? 0] ?? 'Normal';

    const comment: NicoComment = {
      id: String(meta.id ?? ''),
      at,
      liveId: liveId ?? 0,
      rawUserId: int64ToSafeInteger(candidateChat.raw_user_id) ?? 0,
      hashedUserId: String(candidateChat.hashed_user_id ?? ''),
      accountStatus,
      no: Number(candidateChat.no ?? 0),
      vpos: Number(candidateChat.vpos ?? 0),
      position,
      size,
      color,
      font,
      opacity,
      content: String(candidateChat.content ?? ''),
    };

    return comment;
  }

  // seenMessageIds は意図的に無制限 (番組終了まで全 ID を保持する)。
  // backward walk は #132 で viewUri 取得ごとに 1 回に制限したが、viewUri 再取得後の walk は
  // 番組開始までの全履歴を再取得するため、その重複 (emit 済み全件) を吸収できるのは
  // このセットだけ。上限付き FIFO 化 (#101 / 0b5dc04b) した際は、上限超過分の番組で
  // 重複がすり抜けて DB への重複 INSERT がシャットダウンまで続き、コメント取り込みが
  // 最大 8 時間超遅延した (2026-07-19 障害。#101 のコメント参照)。
  // メモリは 10 万コメント級の番組でも数十 MB 程度なので許容し、無制限のまま維持する
  private shouldEmitComment(comment: NicoComment, state: StreamState): boolean {
    const key = comment.id || `${comment.liveId}:${comment.no}`;
    if (state.seenMessageIds.has(key)) {
      return false;
    }
    state.seenMessageIds.add(key);
    return true;
  }

  private toDate(timestamp: any): Date {
    if (!timestamp) {
      return new Date();
    }
    const seconds = int64ToSafeInteger(timestamp.seconds) ?? 0;
    const nanos = Number(timestamp.nanos ?? 0);
    const millis = seconds * 1000 + Math.floor(nanos / 1_000_000);
    return new Date(millis);
  }

  private getLiveId(meta: any): number | undefined {
    return int64ToSafeInteger(meta.origin?.chat?.live_id);
  }

  private toCommentColor(modifier: any): CommentColor {
    if (typeof modifier.named_color === 'number') {
      return COLOR_NAME_MAP[modifier.named_color] ?? 'white';
    }
    if (modifier.full_color) {
      const color = modifier.full_color as CommentFullColor;
      return {
        r: Number(color.r ?? 255),
        g: Number(color.g ?? 255),
        b: Number(color.b ?? 255),
      };
    }
    return 'white';
  }
}
