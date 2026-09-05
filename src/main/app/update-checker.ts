import { EventEmitter } from 'node:events';
import { gt, prerelease, valid } from 'semver';
import type { UpdateStatus } from '../../shared/types';
import type { Logger } from '../core/logger';

const RELEASES_URL = 'https://github.com/honishi/nico-live-recorder/releases';
const RELEASE_API_URL = 'https://api.github.com/repos/honishi/nico-live-recorder/releases/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_COOLDOWN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** 公開リリースを読むだけにとどめ、録画のライフサイクルには関与しない */
export class UpdateChecker extends EventEmitter {
  private status: UpdateStatus = { checking: false, result: 'unchecked', nextCheckAt: 0 };
  private inFlight?: Promise<UpdateStatus>;
  private interval?: NodeJS.Timeout;
  private controller?: AbortController;
  private stopped = false;

  constructor(
    private readonly currentVersion: string,
    private readonly logger: Logger,
  ) {
    super();
  }

  getStatus(): UpdateStatus {
    return structuredClone(this.status);
  }

  start(): void {
    if (this.interval || this.stopped) {
      return;
    }
    void this.check();
    this.interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.interval.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.interval);
    this.controller?.abort();
  }

  check(): Promise<UpdateStatus> {
    // 手動確認と定期確認をまとめ、連打でも GitHub へのアクセスを増やさない
    if (this.inFlight) {
      return this.inFlight;
    }
    if (this.stopped || Date.now() < this.status.nextCheckAt) {
      return Promise.resolve(this.getStatus());
    }
    this.inFlight = this.fetchRelease().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchRelease(): Promise<UpdateStatus> {
    this.status = { ...this.status, checking: true };
    this.emit('change');
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let next: UpdateStatus = {
      ...this.status,
      checking: false,
      result: 'error',
      nextCheckAt: 0,
    };

    try {
      // GitHub のトークンやニコニコの Cookie は送らず、公開 API だけを利用する
      const response = await fetch(RELEASE_API_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'nico-live-recorder',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        credentials: 'omit',
        signal: controller.signal,
      });
      // 成功以外の応答も本文を解放して接続を残さない
      if (!response.ok) {
        await response.body?.cancel();
      }
      if (response.status === 404) {
        // 非公開リポジトリとリリース未公開は区別できない。「最新版」とは判定しない
        next.result = 'unavailable';
      } else if (response.status === 403 || response.status === 429) {
        next.result = 'rate-limited';
        // 制限解除時刻が得られない場合も 1 時間待ち、手動確認にも同じ待機を適用する
        const retryAfter = Number(response.headers.get('retry-after')) * 1000;
        const resetAt = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        next.nextCheckAt = Math.max(
          Date.now() + 60 * 60 * 1000,
          Number.isFinite(retryAfter) ? Date.now() + retryAfter : 0,
          Number.isFinite(resetAt) ? resetAt : 0,
        );
      } else if (!response.ok) {
        throw new Error(`GitHub release check: HTTP ${response.status}`);
      } else {
        const release: unknown = await response.json();
        next = { ...next, ...this.compareRelease(release) };
      }
      if (next.release && next.release.version !== this.status.release?.version) {
        this.logger.info(`新しいバージョン v${next.release.version} があります`);
      }
    } catch (error) {
      this.logger.debug('update check failed', error);
    } finally {
      clearTimeout(timeout);
      this.controller = undefined;
    }

    // 終了後には状態の配信を行わない。失敗時も前回見つけた更新の案内は残す
    if (!this.stopped) {
      this.status = {
        ...next,
        checkedAt: new Date().toISOString(),
        nextCheckAt: Math.max(next.nextCheckAt, Date.now() + CHECK_COOLDOWN_MS),
      };
      this.emit('change');
    }
    return this.getStatus();
  }

  private compareRelease(value: unknown): Pick<UpdateStatus, 'result' | 'release'> {
    if (
      !value ||
      typeof value !== 'object' ||
      !('tag_name' in value) ||
      typeof value.tag_name !== 'string'
    ) {
      throw new Error('invalid GitHub release response');
    }
    const tag = value.tag_name;
    const version = valid(tag);
    if (!version || !valid(this.currentVersion)) {
      throw new Error('invalid release or app version');
    }
    if (!('draft' in value) || !('prerelease' in value)) {
      throw new Error('missing release visibility');
    }
    if (value.draft !== false || value.prerelease !== false || prerelease(version)) {
      return { result: 'unavailable', release: undefined };
    }
    if (!gt(version, this.currentVersion)) {
      return { result: 'current', release: undefined };
    }
    // API の html_url をそのまま開かず、このリポジトリのリリース URL を組み立てる
    return {
      result: 'available',
      release: { version, url: `${RELEASES_URL}/tag/${encodeURIComponent(tag)}` },
    };
  }
}
