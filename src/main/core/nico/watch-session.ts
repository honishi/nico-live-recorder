import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import { DEFAULT_USER_AGENT } from '../../vendor/nico-client/internal/userAgent';
import { silentLogger, type Logger } from '../logger';
import { asString } from '../util';
import { parseStreamMessage, type HlsStreamInfo } from './watch-protocol';

export type { HlsStreamInfo, StreamCookie } from './watch-protocol';

export interface WatchSessionOptions {
  userAgent?: string;
  /** ログイン済みなら `user_session=...` などを渡す */
  cookieHeader?: string;
  logger?: Logger;
  /** startWatching で要求する画質。`abr` なら multivariant playlist が返る */
  quality?: string;
  latency?: 'low' | 'high';
  /** `stream` メッセージ待ちのタイムアウト */
  streamTimeoutMs?: number;
  /** 接続開始から WebSocket の open までの上限 */
  connectTimeoutMs?: number;
}

export interface WatchSessionCloseInfo {
  code: number;
  reason: string;
  /** close() / refreshStream() による意図した切断か */
  intentional: boolean;
}

export interface WatchSessionEvents {
  stream: [info: HlsStreamInfo];
  messageServer: [info: { viewUri: string; vposBaseTime?: string }];
  schedule: [info: { begin?: Date; end?: Date }];
  /** サーバーから END_PROGRAM で切断された (番組終了) */
  ended: [reason: string];
  /** END_PROGRAM 以外の理由でサーバーから切断された */
  disconnect: [reason: string];
  close: [info: WatchSessionCloseInfo];
  error: [error: Error];
}

const DEFAULT_STREAM_TIMEOUT_MS = 15_000;
const DEFAULT_KEEP_SEAT_INTERVAL_SEC = 30;
const END_PROGRAM_REASON = 'END_PROGRAM';

/**
 * ニコ生の視聴 WebSocket (wsapi/v2/watch) のクライアント。
 * startWatching を送って HLS 配信情報 (URI + cookie) を受け取り、
 * 接続中は ping への応答と keepSeat の送信で視聴席を維持する。
 */
export class WatchSession extends EventEmitter<WatchSessionEvents> {
  private ws?: WebSocket;
  private url: string;
  private readonly userAgent: string;
  private readonly cookieHeader?: string;
  private readonly logger: Logger;
  private readonly quality: string;
  private readonly latency: 'low' | 'high';
  private readonly streamTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  private keepSeatTimer?: NodeJS.Timeout;
  private latestStream?: HlsStreamInfo;
  /** 自分で閉じたソケット。close イベントで「意図した切断か」を判定するのに使う */
  private readonly intentionallyClosed = new WeakSet<WebSocket>();
  private closedForever = false;

  constructor(webSocketUrl: string, options: WatchSessionOptions = {}) {
    super();
    this.url = webSocketUrl;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.cookieHeader = options.cookieHeader;
    this.logger = options.logger ?? silentLogger;
    this.quality = options.quality ?? 'abr';
    this.latency = options.latency ?? 'high';
    this.streamTimeoutMs = options.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  }

  get latestStreamInfo(): HlsStreamInfo | undefined {
    return this.latestStream;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** WebSocket を開き、startWatching を送る。open まで待って解決する */
  connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    if (this.closedForever) {
      return Promise.reject(new Error('WatchSession は既に close されています'));
    }
    this.disposeSocket();

    return new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {
        'User-Agent': this.userAgent,
        Origin: 'https://live.nicovideo.jp',
      };
      if (this.cookieHeader) {
        headers['Cookie'] = this.cookieHeader;
      }
      const ws = new WebSocket(this.url, { headers });
      this.ws = ws;
      let opened = false;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`WebSocket 接続が ${this.connectTimeoutMs}ms 以内に完了しませんでした`));
        ws.terminate();
      }, this.connectTimeoutMs);
      // open 前でも停止を受け付ける。terminate が後から出す error は既存のハンドラで受ける
      const onAbort = (): void => {
        cleanup();
        this.intentionallyClosed.add(ws);
        reject(new DOMException('Aborted', 'AbortError'));
        ws.terminate();
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      ws.on('open', () => {
        cleanup();
        opened = true;
        this.logger.debug('watch ws opened');
        this.send({
          type: 'startWatching',
          data: {
            stream: {
              quality: this.quality,
              protocol: 'hls',
              latency: this.latency,
              chasePlay: false,
            },
            room: { protocol: 'webSocket', commentable: true },
            reconnect: false,
          },
        });
        this.send({ type: 'getAkashic', data: { chasePlay: false } });
        resolve();
      });
      ws.on('message', (raw) => this.handleMessage(rawDataToString(raw)));
      ws.on('error', (error) => {
        cleanup();
        this.logger.warn('watch ws error', error);
        if (!opened) {
          reject(error);
        } else {
          this.emit('error', error);
        }
      });
      ws.on('close', (code, reasonBuf) => {
        cleanup();
        const reason = reasonBuf.toString();
        this.logger.debug(`watch ws closed code=${code} reason=${reason}`);
        this.stopKeepSeat();
        if (this.ws === ws) {
          this.ws = undefined;
        }
        if (!opened) {
          reject(new Error(`watch ws closed before open (code=${code})`));
        }
        this.emit('close', { code, reason, intentional: this.intentionallyClosed.has(ws) });
      });
    });
  }

  /**
   * 次の `stream` メッセージを待つ。既に受信済みで `fresh` が false なら即座に返す。
   */
  waitForStream(fresh = false, signal?: AbortSignal): Promise<HlsStreamInfo> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    if (!fresh && this.latestStream) {
      return Promise.resolve(this.latestStream);
    }
    return new Promise<HlsStreamInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(`stream メッセージを ${this.streamTimeoutMs}ms 以内に受信できませんでした`),
        );
      }, this.streamTimeoutMs);
      const onStream = (info: HlsStreamInfo): void => {
        cleanup();
        resolve(info);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const onClose = (info: WatchSessionCloseInfo): void => {
        // 張り直しで自分が閉じた古いソケットの close は、新しい接続の stream 待ちを妨げない
        if (info.intentional && !this.closedForever) {
          return;
        }
        cleanup();
        reject(new Error(`stream 待機中に WebSocket が閉じました (code=${info.code})`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('stream', onStream);
        this.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      this.on('stream', onStream);
      this.on('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * 接続を張り直して新しい HLS 配信情報 (cookie 更新) を取得する。
   * 鍵やセグメントの取得が 403 になったときに使う。
   */
  async refreshStream(signal?: AbortSignal): Promise<HlsStreamInfo> {
    this.logger.info('watch ws reconnecting to refresh stream credentials');
    await this.connect(signal);
    return this.waitForStream(true, signal);
  }

  close(): void {
    this.closedForever = true;
    this.disposeSocket();
  }

  private disposeSocket(): void {
    this.stopKeepSeat();
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) {
      return;
    }
    this.intentionallyClosed.add(ws);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private startKeepSeat(intervalSec: number): void {
    this.stopKeepSeat();
    this.keepSeatTimer = setInterval(() => this.send({ type: 'keepSeat' }), intervalSec * 1000);
  }

  private stopKeepSeat(): void {
    if (this.keepSeatTimer) {
      clearInterval(this.keepSeatTimer);
      this.keepSeatTimer = undefined;
    }
  }

  private handleMessage(text: string): void {
    let message: { type?: string; data?: Record<string, unknown> };
    try {
      message = JSON.parse(text) as { type?: string; data?: Record<string, unknown> };
    } catch (error) {
      this.logger.warn('watch ws: failed to parse message', error);
      return;
    }
    const data = message.data ?? {};
    switch (message.type) {
      case 'ping':
        this.send({ type: 'pong' });
        this.send({ type: 'keepSeat' });
        break;
      case 'seat': {
        const interval = Number(data['keepIntervalSec']);
        this.startKeepSeat(
          Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_KEEP_SEAT_INTERVAL_SEC,
        );
        break;
      }
      case 'stream':
        this.handleStream(data);
        break;
      case 'messageServer':
        if (typeof data['viewUri'] === 'string') {
          this.emit('messageServer', {
            viewUri: data['viewUri'],
            vposBaseTime:
              typeof data['vposBaseTime'] === 'string' ? data['vposBaseTime'] : undefined,
          });
        }
        break;
      case 'schedule':
        this.emit('schedule', {
          begin: typeof data['begin'] === 'string' ? new Date(data['begin']) : undefined,
          end: typeof data['end'] === 'string' ? new Date(data['end']) : undefined,
        });
        break;
      case 'reconnect':
        this.handleReconnect(data);
        break;
      case 'disconnect': {
        const reason = asString(data['reason'], 'UNKNOWN');
        this.logger.info(`watch ws disconnect requested: ${reason}`);
        if (reason === END_PROGRAM_REASON) {
          this.emit('ended', reason);
        } else {
          this.emit('disconnect', reason);
        }
        break;
      }
      case 'error':
        this.logger.warn('watch ws server error', data);
        break;
      default:
        break;
    }
  }

  private handleStream(data: Record<string, unknown>): void {
    const info = parseStreamMessage(data, 'live');
    if (!info) return;
    this.latestStream = info;
    this.logger.debug(
      `watch ws stream received quality=${info.quality} cookies=${info.cookies.length}`,
    );
    this.emit('stream', info);
  }

  /**
   * サーバー主導の再接続要求。新しい audience_token で指定秒後に張り直す
   */
  private handleReconnect(data: Record<string, unknown>): void {
    const token = data['audienceToken'];
    const waitSec = Number(data['waitTimeSec'] ?? 0);
    if (typeof token === 'string' && token.length > 0) {
      const url = new URL(this.url);
      url.searchParams.set('audience_token', token);
      this.url = url.toString();
    }
    this.logger.info(`watch ws reconnect requested (wait ${waitSec}s)`);
    this.disposeSocket();
    setTimeout(
      () => {
        if (this.closedForever) {
          return;
        }
        this.connect().catch((error) => this.emit('error', error as Error));
      },
      Math.max(0, waitSec) * 1000,
    );
  }
}

/** ws の受信データ (Buffer / ArrayBuffer / Buffer[]) を UTF-8 文字列にする */
function rawDataToString(raw: RawData): string {
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  return Buffer.from(raw as ArrayBuffer).toString('utf8');
}
