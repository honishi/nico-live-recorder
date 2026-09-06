import type { FollowCheckResult, FollowStatus } from '../../shared/types';
import { silentLogger, type Logger } from '../core/logger';
import { checkFollowing, type FollowingResponse } from './nico-user';

const RESULT_TTL_MS = 5 * 60 * 1000;
const REQUEST_INTERVAL_MS = 1000;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

interface CachedFollow {
  result: FollowCheckResult;
  expiresAt: number;
  failed: boolean;
  retryable?: boolean;
}

export interface FollowStatusOptions {
  check?: (userId: string, cookieHeader: string) => Promise<FollowingResponse>;
  now?: () => number;
  logger?: Logger;
}

/**
 * 全呼び出し元でキャッシュ・開始間隔・休止を共有する。実行は 1 件だけ。
 * 枠がなければ待機時刻を返し、画面外になった対象が後から勝手に送信される列を作らない。
 */
export class FollowStatusCache {
  private readonly check: NonNullable<FollowStatusOptions['check']>;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly results = new Map<string, CachedFollow>();
  private running?: { userId: string; generation: number; promise: Promise<FollowStatus> };
  private generation = 0;
  private nextStartAt = 0;
  private pauseUntil = 0;
  private failures = 0;

  constructor(options: FollowStatusOptions = {}) {
    this.check = options.check ?? checkFollowing;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
  }

  /** manual でも休止・開始間隔を守る。停止後の明示的な再確認だけで再試行枠を戻す */
  get(userId: string, cookieHeader: string, manual = false): Promise<FollowStatus> {
    const now = this.now();
    const cached = this.results.get(userId);
    if (cached && !cached.failed && cached.expiresAt > now) {
      return Promise.resolve(this.snapshot(userId, 'done', cached.expiresAt));
    }
    if (this.running?.userId === userId && this.running.generation === this.generation) {
      return this.running.promise;
    }

    // 休止中の別ユーザーや追加操作も外部に出さず、再開時は 1 件だけ通す
    const stopped = this.failures > RETRY_DELAYS_MS.length;
    if (now < this.pauseUntil || (stopped && !manual)) {
      return Promise.resolve({
        ...this.snapshot(userId, stopped ? 'stopped' : 'paused', this.pauseUntil),
        servicePaused: true,
      });
    }
    if (cached?.failed && !cached.retryable && (!manual || now < cached.expiresAt)) {
      return Promise.resolve(this.snapshot(userId, 'stopped', cached.expiresAt));
    }
    if (this.running || now < this.nextStartAt) {
      return Promise.resolve(
        this.snapshot(userId, 'waiting', Math.max(this.nextStartAt, now + 200)),
      );
    }
    if (stopped) {
      this.failures = 0;
    }

    // ログイン切替前に開始した応答は表示にもキャッシュにも流さない
    const generation = this.generation;
    this.nextStartAt = now + REQUEST_INTERVAL_MS;
    const promise = this.run(userId, cookieHeader, generation).finally(() => {
      if (this.running?.promise === promise) {
        this.running = undefined;
      }
    });
    this.running = { userId, generation, promise };
    return promise;
  }

  /** アカウントに属する結果を破棄する。実行中の枠と開始間隔は維持する */
  clear(): void {
    this.generation += 1;
    this.results.clear();
    this.pauseUntil = 0;
    this.failures = 0;
  }

  private snapshot(userId: string, state: FollowStatus['state'], retryAt: number): FollowStatus {
    const cached = this.results.get(userId);
    return {
      result: cached?.result,
      stale:
        cached !== undefined &&
        cached.result !== 'unknown' &&
        (cached.failed || cached.expiresAt <= this.now()),
      state,
      retryAt,
    };
  }

  private async run(userId: string, cookie: string, generation: number): Promise<FollowStatus> {
    let response: FollowingResponse;
    try {
      response = await this.check(userId, cookie);
    } catch (error) {
      // 問い合わせ実装の予期しない例外でも、次の対象への連続アクセスを避ける
      this.logger.debug(`[follow] user ${userId}: check failed`, error);
      response = { result: 'unknown', retryable: true };
    }
    if (generation !== this.generation) {
      return { state: 'waiting', stale: false, retryAt: this.now() + REQUEST_INTERVAL_MS };
    }

    const now = this.now();
    if (response.result !== 'unknown') {
      this.results.set(userId, {
        result: response.result,
        expiresAt: now + RESULT_TTL_MS,
        failed: false,
      });
      if (this.failures > 0) {
        this.logger.debug('[follow] checks resumed');
      }
      this.failures = 0;
      this.pauseUntil = 0;
      return this.snapshot(userId, 'done', now + RESULT_TTL_MS);
    }

    // 前回の成功結果は残し、現在の確認済み結果とは区別する
    const previous = this.results.get(userId);
    this.results.set(userId, {
      result: previous?.result ?? 'unknown',
      expiresAt: now + 30_000,
      failed: true,
      retryable: response.retryable,
    });
    if (!response.retryable) {
      // 認証エラーや応答形式の変更は自動で繰り返さない
      this.failures = 0;
      this.pauseUntil = 0;
      return this.snapshot(userId, 'stopped', now + 30_000);
    }

    this.failures += 1;
    const delay = RETRY_DELAYS_MS[Math.min(this.failures - 1, RETRY_DELAYS_MS.length - 1)];
    this.pauseUntil = Math.max(now + delay, response.retryAt ?? 0);
    const state = this.failures > RETRY_DELAYS_MS.length ? 'stopped' : 'paused';
    this.logger.debug(
      `[follow] checks ${state}: failures=${this.failures}, retry-at=${new Date(this.pauseUntil).toISOString()}`,
    );
    return { ...this.snapshot(userId, state, this.pauseUntil), servicePaused: true };
  }
}
