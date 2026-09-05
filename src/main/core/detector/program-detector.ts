import { EventEmitter } from 'node:events';
import { NicoClient } from '../../vendor/nico-client/NicoClient';
import { NicoLiveProgramStatus } from '../../vendor/nico-client/types';
import type { WebPushManager, PushProgram } from '../push/web-push-manager';
import { silentLogger, type Logger } from '../logger';
import { fetchFollowingOnAirPrograms, NotAuthenticatedError } from '../nico/follow-programs';
import { numberInRange, POLL_INTERVAL_SEC } from '../../../shared/limits';

export type DetectionSource = 'push' | 'poll';

export interface DetectedProgram {
  programId: string;
  title: string;
  providerId?: string;
  providerName?: string;
  source: DetectionSource;
  detectedAt: Date;
  beginAt?: Date;
  /** ポーリングの初回取得で既に放送中だったもの */
  alreadyOnAir: boolean;
}

export interface ProgramDetectorOptions {
  /** push 経由の検知。未指定ならポーリングのみ */
  push?: WebPushManager;
  /** ログイン cookie ヘッダ。未ログイン (undefined) ならポーリングは休止する */
  cookieHeader: () => Promise<string | undefined>;
  pollIntervalMs?: number;
  logger?: Logger;
  userAgent?: string;
  /** 放送開始からこの時間を過ぎた push は古いものとして捨てる */
  maxPushAgeMs?: number;
}

export interface ProgramDetectorEvents {
  program: [program: DetectedProgram];
  /** ポーリングが成功した (放送中の件数) */
  polled: [count: number];
  pollError: [error: Error];
}

/** ポーリング間隔の許容範囲 (ms)。設定と同じ範囲で、外れた値は既定に戻す */
const POLL_INTERVAL_MS = {
  min: POLL_INTERVAL_SEC.min * 1000,
  max: POLL_INTERVAL_SEC.max * 1000,
  default: POLL_INTERVAL_SEC.default * 1000,
};
const DEFAULT_MAX_PUSH_AGE_MS = 10 * 60 * 1000;
const SEEN_HISTORY_LIMIT = 5_000;

/**
 * 放送開始の検知。push を主、フォロー中番組 API のポーリングを副として併用し、
 * 同じ番組は 1 回だけ `program` イベントにする。
 */
export class ProgramDetector extends EventEmitter<ProgramDetectorEvents> {
  private readonly push?: WebPushManager;
  private readonly cookieHeader: () => Promise<string | undefined>;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;
  private readonly userAgent?: string;
  private readonly maxPushAgeMs: number;

  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private pollTimer?: NodeJS.Timeout;
  private polling = false;
  private running = false;
  private firstPollDone = false;
  private readonly onPushProgram = (program: PushProgram): void => {
    void this.handlePush(program);
  };

  constructor(options: ProgramDetectorOptions) {
    super();
    this.push = options.push;
    this.cookieHeader = options.cookieHeader;
    this.logger = options.logger ?? silentLogger;
    // NaN や短すぎる間隔をそのまま setInterval に渡すと API を連続で叩くので、ここでも範囲を確かめる
    const requested = options.pollIntervalMs;
    this.pollIntervalMs = numberInRange(requested, POLL_INTERVAL_MS) ?? POLL_INTERVAL_MS.default;
    if (requested !== undefined && this.pollIntervalMs !== requested) {
      this.logger.warn(
        `[detector] invalid poll interval ${String(requested)}ms, using ${POLL_INTERVAL_MS.default}ms`,
      );
    }
    this.userAgent = options.userAgent;
    this.maxPushAgeMs = options.maxPushAgeMs ?? DEFAULT_MAX_PUSH_AGE_MS;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.push?.on('program', this.onPushProgram);
    void this.pollOnce();
    this.pollTimer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    this.push?.off('program', this.onPushProgram);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** 既知として扱う (録画中・録画済みなど) */
  markSeen(programId: string): void {
    if (this.seen.has(programId)) {
      return;
    }
    this.seen.add(programId);
    this.seenOrder.push(programId);
    while (this.seenOrder.length > SEEN_HISTORY_LIMIT) {
      const oldest = this.seenOrder.shift();
      if (oldest) {
        this.seen.delete(oldest);
      }
    }
  }

  /** 既知扱いを解除し、次の検知で再度通知できるようにする (開始に失敗したときなど) */
  unmarkSeen(programId: string): void {
    if (this.seen.delete(programId)) {
      const index = this.seenOrder.indexOf(programId);
      if (index >= 0) {
        this.seenOrder.splice(index, 1);
      }
    }
  }

  private async handlePush(program: PushProgram): Promise<void> {
    const programId = program.programId;
    if (!programId) {
      return;
    }
    if (this.seen.has(programId)) {
      this.logger.debug(`detector: push for ${programId} already known`);
      return;
    }
    if (program.createdAt) {
      const age = Date.now() - new Date(program.createdAt).getTime();
      if (Number.isFinite(age) && age > this.maxPushAgeMs) {
        this.logger.info(`detector: stale push for ${programId} (${Math.round(age / 1000)}s old)`);
        // 古いのは通知だけで、番組はまだ放送中かもしれない。ポーリングで拾えるよう既知にしない
        return;
      }
    }
    this.markSeen(programId);
    try {
      const cookies = await this.cookiesRecord();
      const info = await new NicoClient(programId, {
        cookies,
        userAgent: this.userAgent,
      }).getProgramInfo();
      if (info.status === NicoLiveProgramStatus.ended) {
        this.logger.info(`detector: ${programId} already ended`);
        return;
      }
      this.emit('program', {
        programId,
        title: info.title,
        providerId: info.providerId,
        providerName: info.providerName,
        source: 'push',
        detectedAt: new Date(),
        beginAt: info.beginTime > 0 ? new Date(info.beginTime * 1000) : undefined,
        alreadyOnAir: false,
      });
    } catch (error) {
      this.logger.warn(`detector: failed to resolve ${programId} from push`, error);
      // 解決に失敗した場合はポーリングで拾えるように未知に戻す
      this.seen.delete(programId);
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.running || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const cookie = await this.cookieHeader();
      if (!cookie) {
        return;
      }
      const programs = await fetchFollowingOnAirPrograms(cookie, { userAgent: this.userAgent });
      const initial = !this.firstPollDone;
      this.firstPollDone = true;
      this.emit('polled', programs.length);
      for (const program of programs) {
        if (this.seen.has(program.id)) {
          continue;
        }
        this.markSeen(program.id);
        this.emit('program', {
          programId: program.id,
          title: program.title,
          providerId: program.providerId ?? program.socialGroupId,
          providerName: program.providerName ?? program.socialGroupName,
          source: 'poll',
          detectedAt: new Date(),
          beginAt: program.beginAt,
          alreadyOnAir: initial,
        });
      }
    } catch (error) {
      if (error instanceof NotAuthenticatedError) {
        this.logger.warn('detector: not authenticated, polling paused until login');
      } else {
        this.logger.warn('detector: poll failed', error);
      }
      this.emit('pollError', error as Error);
    } finally {
      this.polling = false;
    }
  }

  private async cookiesRecord(): Promise<Record<string, string> | undefined> {
    const header = await this.cookieHeader();
    if (!header) {
      return undefined;
    }
    const record: Record<string, string> = {};
    for (const pair of header.split(';')) {
      const [name, ...rest] = pair.trim().split('=');
      if (name) {
        record[name] = rest.join('=');
      }
    }
    return record;
  }
}
