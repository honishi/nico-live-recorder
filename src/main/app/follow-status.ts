import type { FollowCheckResult } from '../../shared/types';
import { checkFollowing } from './nico-user';

/** 確認できた結果を保持する時間。対象タブを開き直すたびに全員分を取りに行かないようにする */
const RESULT_TTL_MS = 5 * 60 * 1000;
/** 失敗 (unknown) を保持する時間。API の不調時に連打しない程度に短くする */
const UNKNOWN_TTL_MS = 30 * 1000;
/** 同時に問い合わせる上限。対象が多くても一斉に並列アクセスしない */
const MAX_CONCURRENT = 4;

export interface FollowStatusOptions {
  check?: (userId: string, cookieHeader: string) => Promise<FollowCheckResult>;
  now?: () => number;
  resultTtlMs?: number;
  unknownTtlMs?: number;
  maxConcurrent?: number;
}

/**
 * フォロー状態の問い合わせをまとめる。数分のキャッシュ、同じユーザーの問い合わせの合流、
 * 同時実行数の制限で、対象タブを開くたびに全対象へ並列アクセスすることを避ける
 */
export class FollowStatusCache {
  private readonly check: NonNullable<FollowStatusOptions['check']>;
  private readonly now: () => number;
  private readonly resultTtlMs: number;
  private readonly unknownTtlMs: number;
  private readonly maxConcurrent: number;
  private readonly results = new Map<string, { result: FollowCheckResult; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<FollowCheckResult>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: FollowStatusOptions = {}) {
    this.check = options.check ?? checkFollowing;
    this.now = options.now ?? Date.now;
    this.resultTtlMs = options.resultTtlMs ?? RESULT_TTL_MS;
    this.unknownTtlMs = options.unknownTtlMs ?? UNKNOWN_TTL_MS;
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT;
  }

  /** 有効なキャッシュがあればそれを、無ければ順番待ちして問い合わせる */
  get(userId: string, cookieHeader: string): Promise<FollowCheckResult> {
    const cached = this.results.get(userId);
    if (cached && cached.expiresAt > this.now()) {
      return Promise.resolve(cached.result);
    }
    // 同じユーザーの問い合わせが進行中なら、その結果を待つ
    const pending = this.inFlight.get(userId);
    if (pending) {
      return pending;
    }
    const task = this.withSlot(() => this.check(userId, cookieHeader))
      .then((result) => {
        const ttl = result === 'unknown' ? this.unknownTtlMs : this.resultTtlMs;
        this.results.set(userId, { result, expiresAt: this.now() + ttl });
        return result;
      })
      .finally(() => {
        this.inFlight.delete(userId);
      });
    this.inFlight.set(userId, task);
    return task;
  }

  /** ログイン状態が変わったときなど、保持している結果をすべて捨てる */
  clear(): void {
    this.results.clear();
  }

  /** 同時実行数の枠が空くのを待ってから実行する */
  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running += 1;
    try {
      return await task();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }
}
