import crypto from 'node:crypto';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { DEFAULT_USER_AGENT } from '../../vendor/nico-client/internal/userAgent';
import { silentLogger, type Logger } from '../logger';
import type { StreamCookie } from './watch-session';

// ---------------------------------------------------------------------------
// playlist parsing
// ---------------------------------------------------------------------------

export interface HlsKey {
  method: string;
  uri?: string;
  iv?: string;
}

export interface HlsSegment {
  seq: number;
  uri: string;
  duration: number;
  mapUri?: string;
  key?: HlsKey;
  programDateTime?: string;
}

export interface MediaPlaylist {
  targetDuration: number;
  mediaSequence: number;
  endList: boolean;
  segments: HlsSegment[];
}

export interface VariantStream {
  uri: string;
  bandwidth: number;
  resolution?: string;
  codecs?: string;
  audioGroupId?: string;
}

export interface RenditionMedia {
  type: string;
  groupId: string;
  name: string;
  uri?: string;
  isDefault: boolean;
}

export interface MultivariantPlaylist {
  variants: VariantStream[];
  media: RenditionMedia[];
}

/** `KEY=VALUE,KEY="quoted, value"` 形式の属性リストを解析する */
export function parseAttributes(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    result[match[1]] = match[3] !== undefined ? match[3] : match[2];
  }
  return result;
}

function resolveUri(uri: string, baseUrl: string): string {
  return new URL(uri, baseUrl).toString();
}

export function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylist {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const playlist: MediaPlaylist = {
    targetDuration: 3,
    mediaSequence: 0,
    endList: false,
    segments: [],
  };
  let seq = 0;
  let mapUri: string | undefined;
  let key: HlsKey | undefined;
  let pendingDuration: number | undefined;
  let pendingDateTime: string | undefined;

  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      playlist.targetDuration = Number(line.slice('#EXT-X-TARGETDURATION:'.length)) || 3;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      playlist.mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) || 0;
      seq = playlist.mediaSequence;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      mapUri = attrs['URI'] ? resolveUri(attrs['URI'], baseUrl) : undefined;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      const method = attrs['METHOD'] ?? 'NONE';
      key =
        method === 'NONE'
          ? undefined
          : {
              method,
              uri: attrs['URI'] ? resolveUri(attrs['URI'], baseUrl) : undefined,
              iv: attrs['IV']?.replace(/^0x/i, ''),
            };
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      pendingDateTime = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length);
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      playlist.endList = true;
    } else if (line.startsWith('#')) {
      // EXT-X-PART など部分セグメントは扱わない (完成したセグメントのみ取得する)
      continue;
    } else if (pendingDuration !== undefined) {
      playlist.segments.push({
        seq: seq++,
        uri: resolveUri(line, baseUrl),
        duration: pendingDuration,
        mapUri,
        key,
        programDateTime: pendingDateTime,
      });
      pendingDuration = undefined;
      pendingDateTime = undefined;
    }
  }
  return playlist;
}

export function parseMultivariantPlaylist(text: string, baseUrl: string): MultivariantPlaylist {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const result: MultivariantPlaylist = { variants: [], media: [] };
  let pendingVariant: Omit<VariantStream, 'uri'> | undefined;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      result.media.push({
        type: attrs['TYPE'] ?? '',
        groupId: attrs['GROUP-ID'] ?? '',
        name: attrs['NAME'] ?? '',
        uri: attrs['URI'] ? resolveUri(attrs['URI'], baseUrl) : undefined,
        isDefault: attrs['DEFAULT'] === 'YES',
      });
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      pendingVariant = {
        bandwidth: Number(attrs['BANDWIDTH'] ?? attrs['AVERAGE-BANDWIDTH'] ?? 0) || 0,
        resolution: attrs['RESOLUTION'],
        codecs: attrs['CODECS'],
        audioGroupId: attrs['AUDIO'],
      };
    } else if (line.length > 0 && !line.startsWith('#') && pendingVariant) {
      result.variants.push({ ...pendingVariant, uri: resolveUri(line, baseUrl) });
      pendingVariant = undefined;
    }
  }
  return result;
}

export interface SelectedTracks {
  video: VariantStream;
  /** 別 playlist で配信される音声。無い場合は映像 playlist に音声が多重化されている */
  audioUri?: string;
}

/** 最も帯域の大きい variant と、それに紐づく音声 rendition を選ぶ */
export function selectBestVariant(playlist: MultivariantPlaylist): SelectedTracks {
  if (playlist.variants.length === 0) {
    throw new Error('multivariant playlist に variant がありません');
  }
  const video = [...playlist.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  let audioUri: string | undefined;
  if (video.audioGroupId) {
    const candidates = playlist.media.filter(
      (m) => m.type === 'AUDIO' && m.groupId === video.audioGroupId && m.uri,
    );
    audioUri = (candidates.find((m) => m.isDefault) ?? candidates[0])?.uri;
  }
  return { video, audioUri };
}

// ---------------------------------------------------------------------------
// cookies
// ---------------------------------------------------------------------------

/**
 * リクエスト先のパスに一致する cookie だけを Cookie ヘッダにする。
 * ニコ生は同名の CloudFront cookie をパス別に複数配るため、全部を送ると拒否される。
 */
export function cookieHeaderFor(cookies: StreamCookie[], url: string): string {
  const { pathname } = new URL(url);
  return cookies
    .filter((c) => pathname.startsWith(c.path))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// ---------------------------------------------------------------------------
// track downloader
// ---------------------------------------------------------------------------

export class HlsForbiddenError extends Error {
  constructor(public readonly url: string) {
    super(`HTTP 403 ${url}`);
    this.name = 'HlsForbiddenError';
  }
}

export class HlsHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`HTTP ${status} ${url}`);
    this.name = 'HlsHttpError';
  }
}

/** 認証更新で取得元が変わったら、旧 playlist 由来の URL を捨てて取り直す */
class HlsSourceChangedError extends Error {}

export type TrackStopReason = 'endlist' | 'stopped' | 'aborted' | 'idle';

export interface TrackResult {
  reason: TrackStopReason;
  segments: number;
  bytes: number;
  firstSeq?: number;
  lastSeq?: number;
}

export interface HlsTrackDownloaderOptions {
  label: string;
  playlistUrl: string;
  /** 常に最新の cookie を返す (再接続で更新されるため関数で受け取る) */
  cookies: () => StreamCookie[];
  userAgent?: string;
  logger?: Logger;
  /**
   * 鍵やセグメントが 403 を返したときに呼ばれる。視聴セッションの再接続で
   * cookie を更新する。戻った後にリトライする
   */
  onForbidden?: () => Promise<void>;
  requestTimeoutMs?: number;
  /** 新しいセグメントがこの時間現れなければ idle として終了する */
  idleTimeoutMs?: number;
  /** true なら初回 playlist の先頭から取得する。false ならライブエッジ付近 (末尾 3 個) から */
  startFromBeginning?: boolean;
  fetchImpl?: typeof fetch;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const LIVE_EDGE_SEGMENTS = 3;
const MAX_FETCH_ATTEMPTS = 4;

/**
 * media playlist を追跡し、セグメントを取得・復号して Writable に流す。
 * 1 トラック (映像 or 音声) につき 1 インスタンス。
 */
export class HlsTrackDownloader {
  private playlistUrl: string;
  private readonly label: string;
  private readonly cookies: () => StreamCookie[];
  private readonly userAgent: string;
  private readonly logger: Logger;
  private readonly onForbidden?: () => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly startFromBeginning: boolean;
  private readonly fetchImpl: typeof fetch;
  private stopRequested = false;
  private readonly keyCache = new Map<string, Buffer>();

  constructor(options: HlsTrackDownloaderOptions) {
    this.label = options.label;
    this.playlistUrl = options.playlistUrl;
    this.cookies = options.cookies;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.logger = options.logger ?? silentLogger;
    this.onForbidden = options.onForbidden;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.startFromBeginning = options.startFromBeginning ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 再接続で playlist の URL が変わった場合に差し替える */
  updateSource(playlistUrl: string): void {
    if (playlistUrl !== this.playlistUrl) {
      this.logger.info(`${this.label}: playlist url updated`);
      this.playlistUrl = playlistUrl;
    }
  }

  /** 次の playlist 取得を最後にして終了する (番組終了時など) */
  requestStop(): void {
    this.stopRequested = true;
  }

  async run(sink: Writable, signal?: AbortSignal): Promise<TrackResult> {
    const result: TrackResult = { reason: 'stopped', segments: 0, bytes: 0 };
    let lastSeq: number | undefined;
    let lastPlaylist: { url: string; text: string } | undefined;
    let sentMapUri: string | undefined;
    let lastProgressAt = Date.now();

    const write = async (chunk: Buffer): Promise<void> => {
      if (sink.destroyed || sink.writableEnded) {
        throw new Error(`${this.label}: sink is closed`);
      }
      if (!sink.write(chunk)) {
        // ffmpeg が読み進めなくても、停止要求で待機を解除して録画の後始末へ進む
        await once(sink, 'drain', { signal });
      }
    };

    while (true) {
      try {
        if (signal?.aborted) {
          result.reason = 'aborted';
          break;
        }
        const finalPass = this.stopRequested;
        // 次回の取得間隔は「取得を始めた時刻」から数える (RFC 8216 6.3.4)
        const fetchStartedAt = Date.now();
        const playlistUrl = this.playlistUrl;
        const playlistText = (await this.fetchWithRetry(playlistUrl, signal)).toString('utf8');
        // RFC 8216 の「変化した」は本文の変化 (古いセグメントの削除や属性の変更も含む)。
        // 再接続で URL が変わったときは、本文が同じでも相対 URI の解決先が変わるので別物として扱う
        const changed =
          lastPlaylist === undefined ||
          lastPlaylist.url !== playlistUrl ||
          lastPlaylist.text !== playlistText;
        lastPlaylist = { url: playlistUrl, text: playlistText };
        const playlist = parseMediaPlaylist(playlistText, playlistUrl);

        let fresh = playlist.segments.filter((s) => lastSeq === undefined || s.seq > lastSeq);
        if (lastSeq === undefined && !this.startFromBeginning) {
          fresh = fresh.slice(-LIVE_EDGE_SEGMENTS);
        }
        // /blank/ セグメントは配信休止中のダミー映像なので除外する (streamlink と同じ)
        fresh = fresh.filter((s) => !s.uri.includes('/blank/'));

        for (const segment of fresh) {
          if (signal?.aborted) {
            break;
          }
          if (segment.mapUri && segment.mapUri !== sentMapUri) {
            await write(await this.fetchWithRetry(segment.mapUri, signal, playlistUrl));
            sentMapUri = segment.mapUri;
          }
          let data: Buffer;
          try {
            data = await this.fetchWithRetry(segment.uri, signal, playlistUrl);
          } catch (error) {
            if (error instanceof HlsHttpError && error.status === 404) {
              this.logger.warn(`${this.label}: segment ${segment.seq} expired, skipping`);
              lastSeq = segment.seq;
              continue;
            }
            throw error;
          }
          if (segment.key) {
            data = await this.decrypt(data, segment, signal, playlistUrl);
          }
          await write(data);
          result.segments += 1;
          result.bytes += data.length;
          result.firstSeq ??= segment.seq;
          result.lastSeq = segment.seq;
          lastSeq = segment.seq;
          lastProgressAt = Date.now();
        }

        if (playlist.endList) {
          result.reason = 'endlist';
          break;
        }
        if (finalPass) {
          result.reason = 'stopped';
          break;
        }
        if (Date.now() - lastProgressAt > this.idleTimeoutMs) {
          this.logger.warn(`${this.label}: no new segments for ${this.idleTimeoutMs}ms`);
          result.reason = 'idle';
          break;
        }
        // RFC 8216 6.3.4: 内容が変わった playlist は target duration、変わっていなければその半分以上あけてから
        // 取り直す。セグメントの取得にかかった時間はその中に含める
        const minIntervalMs = playlist.targetDuration * (changed ? 1000 : 500);
        await this.delay(Math.max(0, fetchStartedAt + minIntervalMs - Date.now()), signal);
      } catch (error) {
        if (signal?.aborted) {
          result.reason = 'aborted';
          break;
        }
        if (error instanceof HlsSourceChangedError) {
          // 保存済みの seq は維持する。URL 更新だけが続く場合も idle の上限で戻す
          if (Date.now() - lastProgressAt > this.idleTimeoutMs) {
            result.reason = 'idle';
            break;
          }
          continue;
        }
        throw error;
      }
    }
    this.logger.info(
      `${this.label}: finished reason=${result.reason} segments=${result.segments} bytes=${result.bytes}`,
    );
    return result;
  }

  private async decrypt(
    data: Buffer,
    segment: HlsSegment,
    signal: AbortSignal | undefined,
    sourceUrl: string,
  ): Promise<Buffer> {
    const key = segment.key;
    if (!key || !key.uri) {
      return data;
    }
    if (key.method !== 'AES-128') {
      throw new Error(`${this.label}: unsupported key method ${key.method}`);
    }
    let keyBytes = this.keyCache.get(key.uri);
    if (!keyBytes) {
      keyBytes = await this.fetchWithRetry(key.uri, signal, sourceUrl);
      if (keyBytes.length !== 16) {
        throw new Error(`${this.label}: invalid key length ${keyBytes.length}`);
      }
      this.keyCache.set(key.uri, keyBytes);
    }
    const iv = Buffer.alloc(16);
    if (key.iv) {
      Buffer.from(key.iv.padStart(32, '0'), 'hex').copy(iv);
    } else {
      iv.writeBigUInt64BE(BigInt(segment.seq), 8);
    }
    const decipher = crypto.createDecipheriv('aes-128-cbc', keyBytes, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  private async fetchWithRetry(
    url: string,
    signal?: AbortSignal,
    sourceUrl = this.playlistUrl,
  ): Promise<Buffer> {
    let forbiddenHandled = false;
    for (let attempt = 1; ; attempt += 1) {
      if (sourceUrl !== this.playlistUrl) {
        throw new HlsSourceChangedError();
      }
      try {
        return await this.fetchOnce(url, signal);
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        if (sourceUrl !== this.playlistUrl) {
          throw new HlsSourceChangedError();
        }
        if (error instanceof HlsForbiddenError && this.onForbidden && !forbiddenHandled) {
          this.logger.warn(`${this.label}: 403 for ${url}, refreshing stream credentials`);
          forbiddenHandled = true;
          await this.onForbidden();
          continue;
        }
        if (error instanceof HlsHttpError && error.status === 404) {
          throw error;
        }
        if (attempt >= MAX_FETCH_ATTEMPTS) {
          throw error;
        }
        const backoff = 500 * 2 ** (attempt - 1);
        this.logger.warn(
          `${this.label}: fetch failed (${(error as Error).message}), retry ${attempt}/${MAX_FETCH_ATTEMPTS - 1} in ${backoff}ms`,
        );
        await this.delay(backoff, signal);
      }
    }
  }

  private async fetchOnce(url: string, signal?: AbortSignal): Promise<Buffer> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImpl(url, {
      headers: {
        'user-agent': this.userAgent,
        cookie: cookieHeaderFor(this.cookies(), url),
      },
      signal: combined,
    });
    if (response.status === 403) {
      await response.arrayBuffer().catch(() => undefined);
      throw new HlsForbiddenError(url);
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new HlsHttpError(response.status, url);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
