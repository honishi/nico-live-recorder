import { EventEmitter } from 'node:events';
import { DEFAULT_USER_AGENT } from '../../vendor/nico-client/internal/userAgent';
import { silentLogger, type Logger } from '../logger';
import { AutoPushClient } from '../../vendor/web-push/autopush-client';
import { pushDiagnostics } from '../../vendor/web-push/push-diagnostics';
import {
  base64Encode,
  base64UrlEncode,
  decryptNotificationWithInfo,
  exportKeys,
  generateAuthSecret,
  generateKeyPair,
  importKeys,
  parseAutoPushPayload,
} from '../../vendor/web-push/web-push-crypto';

/** push 通知から得られる放送情報 */
export interface PushProgram {
  programId?: string;
  title: string;
  body: string;
  icon: string;
  createdAt?: string;
  onClick?: string;
  receivedAt: Date;
}

/** 永続化する購読状態 */
export interface PushSubscriptionState {
  uaid: string;
  channelId: string;
  endpoint: string;
  /** base64url でエクスポートした鍵 (web-push-crypto.exportKeys の形式) */
  keys: { authSecret: string; publicKey: string; privateKey: string };
  niconicoRegistered: boolean;
  canary?: { channelId: string; endpoint: string };
  createdAt: string;
  updatedAt: string;
}

export interface PushStateStore {
  load(): Promise<PushSubscriptionState | undefined>;
  save(state: PushSubscriptionState): Promise<void>;
  clear(): Promise<void>;
}

export interface WebPushManagerOptions {
  store: PushStateStore;
  /**
   * ニコニコ push API を呼ぶときの Cookie ヘッダ (user_session を含む)。
   * 未ログインなら undefined を返す
   */
  cookieHeader: () => Promise<string | undefined>;
  logger?: Logger;
  userAgent?: string;
  autoPushEndpoint?: string;
}

export type PushConnectionState =
  'stopped' | 'starting' | 'connected' | 'disconnected' | 'repair-required' | 'error';

export interface PushStatus {
  state: PushConnectionState;
  uaid?: string;
  endpoint?: string;
  niconicoRegistered: boolean;
  lastReceivedAt?: Date;
  lastError?: string;
}

export interface WebPushManagerEvents {
  program: [program: PushProgram];
  status: [status: PushStatus];
  error: [error: Error];
}

const NICO_PUSH_ENDPOINTS_URL = 'https://api.push.nicovideo.jp/v1/nicopush/webpush/endpoints.json';
const NICO_PUSH_DEST_APP = 'nico_account_webpush';
const NICO_ACCOUNT_PAGE = 'https://account.nicovideo.jp/my/account';
const NICO_SW_URL = 'https://account.nicovideo.jp/sw.js';
const KNOWN_VAPID_KEY_BASE64 =
  'BC08Fdr2JChSL0kr5imO99L6zZG6Rn0tBAWNTlrZfJtsDoeAvmJSa7CnUOHpNhd5zOk0YnRToEOT47YLet8Dpig=';
const REPAIR_CHECK_INTERVAL_MS = 60_000;

export class NotLoggedInError extends Error {
  constructor() {
    super('ニコニコにログインしていないため push 通知を登録できません');
    this.name = 'NotLoggedInError';
  }
}

/**
 * Web Push の購読管理。
 * chrome-nico-alert の WebPushManager から Chrome 拡張固有の部分 (chrome.storage、
 * content script 経由の API 呼び出し) を除き、Node で完結する形にしたもの。
 *
 * - Mozilla AutoPush に WebSocket で接続し、チャネルを登録してエンドポイントを得る
 * - そのエンドポイントと鍵をニコニコの push API に登録する (要ログイン cookie)
 * - 届いた通知を RFC8291 で復号し、放送開始として `program` イベントを出す
 */
export class WebPushManager extends EventEmitter<WebPushManagerEvents> {
  private readonly store: PushStateStore;
  private readonly cookieHeader: () => Promise<string | undefined>;
  private readonly logger: Logger;
  private readonly userAgent: string;
  private readonly autoPushEndpoint?: string;

  private client?: AutoPushClient;
  private state?: PushSubscriptionState;
  private cryptoKeys?: Awaited<ReturnType<typeof importKeys>>;
  private vapidKey?: Uint8Array;
  private status: PushStatus = { state: 'stopped', niconicoRegistered: false };
  private repairTimer?: NodeJS.Timeout;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private repairing = false;
  private unsubscribeClientState?: () => void;

  constructor(options: WebPushManagerOptions) {
    super();
    this.store = options.store;
    this.cookieHeader = options.cookieHeader;
    this.logger = options.logger ?? silentLogger;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.autoPushEndpoint = options.autoPushEndpoint;
  }

  getStatus(): PushStatus {
    const connected = this.client?.isConnectionOpen() === true;
    const repair = this.client?.isSubscriptionRepairRequired() === true;
    return {
      ...this.status,
      // error は start() の失敗で明示的に入るので、接続状態からの再計算で上書きしない
      state:
        this.status.state === 'stopped' ||
        this.status.state === 'starting' ||
        this.status.state === 'error'
          ? this.status.state
          : repair
            ? 'repair-required'
            : connected
              ? 'connected'
              : 'disconnected',
      uaid: this.client?.getUaid() ?? this.state?.uaid,
      endpoint: this.state?.endpoint,
      niconicoRegistered: this.state?.niconicoRegistered === true,
    };
  }

  start(): Promise<void> {
    return this.runExclusive(() => this.doStart());
  }

  stop(): Promise<void> {
    return this.runExclusive(async () => {
      this.stopRepairTimer();
      this.disconnectClient();
      this.setStatus({ state: 'stopped' });
    });
  }

  /** 購読を完全に破棄する (ニコニコ側の登録解除も試みる) */
  reset(): Promise<void> {
    // 先行処理を待っている間に、解除より後ろへ修復処理が積まれるのを防ぐ
    this.stopRepairTimer();
    return this.runExclusive(async () => {
      this.stopRepairTimer();
      // push 無効・対象なしで未起動でも、保存済みの購読を解除する
      this.state ??= await this.store.load().catch((error) => {
        this.logger.warn('push: failed to load subscription for unregister', error);
        return undefined;
      });
      if (this.state?.endpoint) {
        await this.unregisterFromNiconico(this.state.endpoint).catch((error) =>
          this.logger.warn('push: unregister from niconico failed', error),
        );
      }
      // 停止中の購読は既存の UAID で接続し、チャネル解除だけを行う
      if (this.state && !this.client?.isConnectionOpen()) {
        await this.connectAutoPush(this.state.uaid, [
          this.state.channelId,
          ...(this.state.canary ? [this.state.canary.channelId] : []),
        ]).catch((error) => this.logger.warn('push: connect for unregister failed', error));
      }
      if (this.client?.isConnectionOpen()) {
        for (const channelId of [this.state?.channelId, this.state?.canary?.channelId]) {
          if (channelId) {
            await this.client
              .unregisterChannel(channelId)
              .catch((error) => this.logger.warn('push: unregister channel failed', error));
          }
        }
      }
      this.disconnectClient();
      this.state = undefined;
      this.cryptoKeys = undefined;
      await this.store.clear();
      this.setStatus({ state: 'stopped', niconicoRegistered: false });
    });
  }

  // ---------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(task, task);
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doStart(): Promise<void> {
    if (this.client?.isConnectionOpen() && this.state?.niconicoRegistered) {
      this.logger.debug('push: already started');
      return;
    }
    this.setStatus({ state: 'starting', lastError: undefined });
    try {
      this.state ??= await this.store.load();
      if (this.state) {
        try {
          this.cryptoKeys ??= await importKeys(this.state.keys);
        } catch (error) {
          this.logger.warn('push: saved keys are broken, resubscribing', error);
          this.state = undefined;
          this.cryptoKeys = undefined;
        }
      }

      if (this.state && this.cryptoKeys) {
        await this.resumeSubscription(this.state);
      } else {
        await this.createSubscription();
      }

      await this.ensureCanaryProbe();
      this.startRepairTimer();
      this.setStatus({ state: 'connected' });
      this.logger.info('push: started');
    } catch (error) {
      this.setStatus({ state: 'error', lastError: (error as Error).message });
      this.disconnectClient();
      throw error;
    }
  }

  private async resumeSubscription(state: PushSubscriptionState): Promise<void> {
    this.logger.info('push: resuming saved subscription');
    const channelIds = [state.channelId, ...(state.canary ? [state.canary.channelId] : [])];
    try {
      await this.connectAutoPush(state.uaid, channelIds);
    } catch (error) {
      if (isUaidExpiredError(error)) {
        this.logger.warn('push: saved UAID expired, resubscribing');
        await this.discardSubscription();
        await this.createSubscription();
        return;
      }
      throw error;
    }
    if (this.client?.isSubscriptionRepairRequired()) {
      this.logger.warn('push: server reassigned UAID, resubscribing');
      await this.discardSubscription();
      await this.createSubscription();
      return;
    }
    if (!state.niconicoRegistered) {
      await this.registerToNiconico(state);
    }
  }

  private async createSubscription(): Promise<void> {
    this.logger.info('push: creating new subscription');
    const cookie = await this.cookieHeader();
    if (!cookie) {
      throw new NotLoggedInError();
    }

    this.vapidKey ??= await this.fetchVapidKey();

    const keyPair = await generateKeyPair();
    const authSecret = generateAuthSecret();
    const exported = exportKeys({
      authSecret,
      publicKey: keyPair.publicKeyBytes,
      privateKey: keyPair.privateKeyBytes,
    });
    this.cryptoKeys = await importKeys(exported);

    const uaid = await this.connectAutoPush(undefined, []);
    const channelId = crypto.randomUUID();
    const registration = await this.client!.registerChannel(
      channelId,
      base64UrlEncode(this.vapidKey),
    );
    if (!registration.pushEndpoint) {
      throw new Error('AutoPush がエンドポイントを返しませんでした');
    }

    const now = new Date().toISOString();
    const state: PushSubscriptionState = {
      uaid,
      channelId,
      endpoint: registration.pushEndpoint,
      keys: exported,
      niconicoRegistered: false,
      createdAt: now,
      updatedAt: now,
    };
    this.state = state;
    await this.store.save(state);
    await this.registerToNiconico(state);
  }

  private async discardSubscription(): Promise<void> {
    this.disconnectClient();
    this.state = undefined;
    this.cryptoKeys = undefined;
    await this.store.clear();
  }

  /** 購読解除を先に行い、停止中や交換済みの接続からの通知を遮断する。 */
  private disconnectClient(): void {
    this.unsubscribeClientState?.();
    this.unsubscribeClientState = undefined;
    const client = this.client;
    this.client = undefined;
    client?.disconnect();
  }

  private async connectAutoPush(uaid: string | undefined, channelIds: string[]): Promise<string> {
    this.disconnectClient();
    const client = new AutoPushClient(this.autoPushEndpoint);
    this.client = client;
    // 交換済みのクライアントの遅延通知では現在の状態を更新しない。
    this.unsubscribeClientState = client.onStateChanged(() => {
      if (this.client === client) this.emit('status', this.getStatus());
    });
    client.onMessage('notification', (message) => {
      void this.handleNotification(message as { data?: string; channelID?: string });
    });
    try {
      await client.connect();
      const hello = await client.sendHello(uaid, channelIds);
      if (hello.status !== 200) {
        throw new Error(`AutoPush hello failed: status ${hello.status}`);
      }
      return hello.uaid;
    } catch (error) {
      if (this.client === client) {
        this.disconnectClient();
      } else {
        client.disconnect();
      }
      throw error;
    }
  }

  /**
   * 疎通確認用の canary チャネル。鍵無しで登録し、自分で POST した通知が
   * 同じソケットに戻るかで AutoPush 側のルーティング不整合を検知する
   */
  private async ensureCanaryProbe(): Promise<void> {
    const client = this.client;
    const state = this.state;
    if (!client || !state || !client.isConnectionOpen()) {
      return;
    }
    if (state.canary) {
      client.configureCanaryProbe(state.canary.channelId, state.canary.endpoint);
      return;
    }
    try {
      const channelId = crypto.randomUUID();
      const registration = await client.registerChannel(channelId);
      if (!registration.pushEndpoint) {
        return;
      }
      state.canary = { channelId, endpoint: registration.pushEndpoint };
      state.updatedAt = new Date().toISOString();
      await this.store.save(state);
      client.configureCanaryProbe(channelId, registration.pushEndpoint);
    } catch (error) {
      this.logger.warn('push: canary probe setup failed (continuing without it)', error);
    }
  }

  private startRepairTimer(): void {
    this.stopRepairTimer();
    this.repairTimer = setInterval(() => {
      if (this.client?.isSubscriptionRepairRequired() && !this.repairing) {
        this.repairing = true;
        this.logger.warn('push: subscription repair required, resubscribing');
        this.runExclusive(async () => {
          await this.discardSubscription();
          await this.createSubscription();
          await this.ensureCanaryProbe();
          this.setStatus({ state: 'connected' });
        })
          .catch((error) => {
            this.setStatus({ state: 'error', lastError: (error as Error).message });
            this.emit('error', error as Error);
          })
          .finally(() => {
            this.repairing = false;
          });
      }
    }, REPAIR_CHECK_INTERVAL_MS);
  }

  private stopRepairTimer(): void {
    if (this.repairTimer) {
      clearInterval(this.repairTimer);
      this.repairTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------
  // Niconico push API
  // ---------------------------------------------------------------------

  private async nicoPushRequest(method: 'POST' | 'DELETE', body: unknown): Promise<Response> {
    const cookie = await this.cookieHeader();
    if (!cookie) {
      throw new NotLoggedInError();
    }
    return fetch(NICO_PUSH_ENDPOINTS_URL, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Frontend-Id': '8',
        'X-Request-With': NICO_ACCOUNT_PAGE,
        Origin: 'https://account.nicovideo.jp',
        Referer: NICO_ACCOUNT_PAGE,
        'User-Agent': this.userAgent,
        Cookie: cookie,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }

  private async registerToNiconico(state: PushSubscriptionState): Promise<void> {
    const keys = await importKeys(state.keys);
    const response = await this.nicoPushRequest('POST', {
      destApp: NICO_PUSH_DEST_APP,
      endpoint: {
        endpoint: state.endpoint,
        auth: base64Encode(keys.authSecret),
        p256dh: base64Encode(keys.publicKey),
      },
    });
    const text = await response.text().catch(() => '');
    pushDiagnostics.record('nico_register_result', {
      success: response.ok,
      status: response.status,
    });
    if (!response.ok) {
      state.niconicoRegistered = false;
      await this.store.save(state);
      throw new Error(`ニコニコ push API への登録に失敗しました (HTTP ${response.status}) ${text}`);
    }
    state.niconicoRegistered = true;
    state.updatedAt = new Date().toISOString();
    await this.store.save(state);
    this.logger.info('push: registered endpoint to niconico');
  }

  private async unregisterFromNiconico(endpoint: string): Promise<void> {
    const response = await this.nicoPushRequest('DELETE', {
      destApp: NICO_PUSH_DEST_APP,
      endpoint: { endpoint },
    });
    await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`ニコニコ push API からの登録解除に失敗しました (HTTP ${response.status})`);
    }
    this.logger.info('push: unregistered endpoint from niconico');
  }

  /**
   * ニコニコの Service Worker から VAPID 公開鍵を取り出す。
   * スクリプト内の Uint8Array 定義のうち 3 つ目 (本番環境用) を使う。
   * 取れなければ既知の鍵にフォールバックする
   */
  private async fetchVapidKey(): Promise<Uint8Array> {
    try {
      const sw = await (
        await fetch(NICO_SW_URL, {
          headers: { 'User-Agent': this.userAgent },
          signal: AbortSignal.timeout(15_000),
        })
      ).text();
      const importMatch = sw.match(/importScripts\(['"](.*?)['"]\)/);
      if (!importMatch) {
        throw new Error('importScripts not found in sw.js');
      }
      const main = await (
        await fetch(importMatch[1], {
          headers: { 'User-Agent': this.userAgent },
          signal: AbortSignal.timeout(15_000),
        })
      ).text();
      const pattern = /(?:new\s+)?Uint8Array\s*\(\s*\[([\d,\s]+)\]\s*\)/g;
      const matches: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(main)) !== null) {
        matches.push(match[1]);
      }
      const chosen = matches.length >= 3 ? matches[2] : matches[matches.length - 1];
      if (!chosen) {
        throw new Error('VAPID key not found in service worker script');
      }
      const bytes = chosen
        .split(',')
        .map((n) => Number.parseInt(n.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      if (bytes.length !== 65 || bytes[0] !== 0x04) {
        throw new Error(`unexpected VAPID key length ${bytes.length}`);
      }
      const key = new Uint8Array(bytes);
      if (base64Encode(key) !== KNOWN_VAPID_KEY_BASE64) {
        this.logger.warn('push: VAPID key differs from the known value, using fetched key');
      }
      return key;
    } catch (error) {
      this.logger.warn('push: failed to fetch VAPID key, falling back to known key', error);
      return new Uint8Array(Buffer.from(KNOWN_VAPID_KEY_BASE64, 'base64'));
    }
  }

  // ---------------------------------------------------------------------
  // notifications
  // ---------------------------------------------------------------------

  private async handleNotification(message: { data?: string; channelID?: string }): Promise<void> {
    if (!this.cryptoKeys) {
      this.logger.warn('push: notification received but keys are missing');
      return;
    }
    if (!message.data) {
      this.logger.debug('push: notification without data');
      return;
    }
    try {
      const payload = parseAutoPushPayload(message.data);
      const { plaintext } = await decryptNotificationWithInfo(payload, this.cryptoKeys);
      const data = JSON.parse(plaintext) as {
        title?: string;
        body?: string;
        icon?: string;
        data?: { on_click?: string; onClick?: string; created_at?: string };
      };
      const onClick = data.data?.on_click ?? data.data?.onClick;
      const program: PushProgram = {
        programId: onClick?.match(/watch\/(lv\d+)/)?.[1],
        title: data.title ?? '',
        body: data.body ?? '',
        icon: data.icon ?? '',
        createdAt: data.data?.created_at,
        onClick,
        receivedAt: new Date(),
      };
      this.setStatus({ lastReceivedAt: program.receivedAt });
      this.logger.info(`push: received "${program.title}" ${program.programId ?? '(non-live)'}`);
      this.emit('program', program);
    } catch (error) {
      this.logger.error('push: failed to process notification', error);
      pushDiagnostics.record('pipeline_error', { error: (error as Error).message });
    }
  }

  private setStatus(patch: Partial<PushStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }
}

function isUaidExpiredError(error: unknown): boolean {
  const message = (error as Error)?.message ?? '';
  return message.includes('expired') || message.includes('409') || message.includes('410');
}
