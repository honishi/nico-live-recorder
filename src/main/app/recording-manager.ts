import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Notification } from 'electron';
import { ProgramDetector, type DetectedProgram } from '../core/detector/program-detector';
import { prefixLogger, type Logger } from '../core/logger';
import { recordProgram } from '../core/recorder/program-recorder';
import { NicoClient } from '../vendor/nico-client/NicoClient';
import { NicoLiveProgramStatus, type NicoLiveProgramInfo } from '../vendor/nico-client/types';
import { setPushLogger } from '../vendor/web-push/push-diagnostics';
import { WebPushManager, type PushStateStore } from '../core/push/web-push-manager';
import {
  codedError,
  ERROR_CODES,
  type AppAlert,
  type HistoryPage,
  type HistoryQuery,
  type PushStatusInfo,
  type RecordingInfo,
  type RecordingSource,
} from '../../shared/types';
import type { NicoAuth } from './auth';
import { HistoryStore } from './history-store';
import type { SettingsStore } from './settings-store';

interface ActiveRecording {
  info: RecordingInfo;
  controller: AbortController;
  done: Promise<void>;
  sizeTimer?: NodeJS.Timeout;
  /** 再開前に終わったファイルの合計サイズ */
  finishedPartBytes: number;
}

export interface RecordingManagerOptions {
  settings: SettingsStore;
  auth: NicoAuth;
  pushStore: PushStateStore;
  history: HistoryStore;
  logger: Logger;
  ffmpegPath?: string;
}

const SIZE_POLL_MS = 1_000;
const OUTPUT_DIR_CHECK_TTL_MS = 30_000;
/** 録画が途中で止まったときの再開の上限と待ち時間 */
const MAX_RECORD_ATTEMPTS = 10;
/** 検知直後の開始 (番組情報の取得) が失敗したときの再試行 */
const DETECT_START_ATTEMPTS = 3;
const DETECT_START_RETRY_MS = 30_000;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;

/**
 * 検知と録画の司令塔。
 * ログイン状態と設定に応じて push / ポーリングを起動し、対象配信者の放送を録画する。
 */
export class RecordingManager extends EventEmitter<{ change: [] }> {
  private readonly settings: SettingsStore;
  private readonly auth: NicoAuth;
  private readonly pushStore: PushStateStore;
  private readonly logger: Logger;
  private readonly ffmpegPath?: string;

  private push?: WebPushManager;
  private detector?: ProgramDetector;
  private readonly active = new Map<string, ActiveRecording>();
  private readonly history: HistoryStore;
  private historyVersionCounter = 0;
  private restarting?: Promise<void>;
  private stopped = false;
  /** ログイン cookie はあるのに API が認証エラーを返した (セッション切れ) */
  private authExpired = false;
  private outputDirCheck?: { dir: string; writable: boolean; checkedAt: number };

  constructor(options: RecordingManagerOptions) {
    super();
    this.settings = options.settings;
    this.auth = options.auth;
    this.pushStore = options.pushStore;
    this.history = options.history;
    this.logger = options.logger;
    this.ffmpegPath = options.ffmpegPath;

    const pushLogger = prefixLogger(this.logger, 'autopush');
    setPushLogger({
      debug: (...args) => pushLogger.debug(...args),
      warn: (...args) => pushLogger.warn(...args),
      error: (...args) => pushLogger.error(...args),
    });

    this.auth.on('change', () => {
      this.authExpired = false;
      void this.restartDetection();
    });
    this.settings.on('change', () => void this.restartDetection());
  }

  get detectorRunning(): boolean {
    return this.detector !== undefined;
  }

  getPushStatus(): PushStatusInfo {
    const status = this.push?.getStatus();
    if (!status) {
      return { state: 'stopped', niconicoRegistered: false };
    }
    return {
      state: status.state,
      niconicoRegistered: status.niconicoRegistered,
      lastReceivedAt: status.lastReceivedAt?.toISOString(),
      lastError: status.lastError,
    };
  }

  get historyVersion(): number {
    return this.historyVersionCounter;
  }

  /** 録画中のものと、当日に終わったもの (ファイルの有無を確認して返す) */
  async getRecordings(): Promise<RecordingInfo[]> {
    const active = [...this.active.values()].map((a) => a.info);
    return [...active, ...(await HistoryStore.checkExistence(this.history.finishedToday()))];
  }

  /** 停止処理中 (finishing) も含めて、まだ終わっていない録画があるか */
  hasActiveRecordings(): boolean {
    return this.active.size > 0;
  }

  /** 合計サイズから削除済みを除くため、条件に合う全件でファイルの有無を確認する */
  async getHistoryPage(query: HistoryQuery): Promise<HistoryPage> {
    const matched = await HistoryStore.checkExistence(this.history.match(query));
    return HistoryStore.paginate(matched, query, this.history.providers());
  }

  removeHistory(programId: string): boolean {
    const removed = this.history.remove(programId);
    if (removed) {
      this.historyVersionCounter += 1;
      this.emitChange();
    }
    return removed;
  }

  /** ヘッダ直下のバナーに出す、解消するまで続く問題 (重い順に 1 件だけ) */
  async getAlerts(loggedIn: boolean): Promise<AppAlert[]> {
    const alerts: AppAlert[] = [];
    const settings = this.settings.get();
    if (!(await this.isOutputDirWritable(settings.outputDir))) {
      alerts.push({
        kind: 'output-dir',
        severity: 'error',
        message: '保存先に書き込めません',
        actionLabel: '保存先を変更',
      });
    }
    if (loggedIn && this.authExpired) {
      alerts.push({
        kind: 'auth-expired',
        severity: 'error',
        message: 'ログインが切れました',
        actionLabel: 'ログイン',
      });
    }
    if (loggedIn && settings.pushEnabled && this.push?.getStatus().state === 'error') {
      alerts.push({
        kind: 'push-unavailable',
        severity: 'warn',
        message: 'push 通知に接続できません (ポーリングのみで監視中)',
        actionLabel: '再接続',
      });
    }
    alerts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
    return alerts.slice(0, 1);
  }

  async start(): Promise<void> {
    await this.restartDetection();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.detector?.stop();
    this.detector = undefined;
    await this.push?.stop().catch(() => undefined);
    this.push = undefined;
    for (const recording of this.active.values()) {
      recording.controller.abort();
    }
    await Promise.allSettled([...this.active.values()].map((r) => r.done));
  }

  /** ログイン状態や設定の変更を反映して検知を組み直す */
  restartDetection(): Promise<void> {
    if (this.restarting) {
      return this.restarting;
    }
    this.restarting = this.doRestartDetection().finally(() => {
      this.restarting = undefined;
    });
    return this.restarting;
  }

  private async doRestartDetection(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.detector?.stop();
    this.detector = undefined;

    const settings = this.settings.get();
    const loggedIn = await this.auth.isLoggedIn();
    if (!loggedIn) {
      this.logger.info('detection paused: not logged in');
      await this.push?.stop().catch(() => undefined);
      this.push = undefined;
      this.emitChange();
      return;
    }

    if (settings.pushEnabled) {
      if (!this.push) {
        this.push = new WebPushManager({
          store: this.pushStore,
          cookieHeader: () => this.auth.getCookieHeader(),
          logger: prefixLogger(this.logger, 'push'),
        });
        this.push.on('status', () => this.emitChange());
        this.push.on('error', (error) => this.logger.error('push error', error));
      }
      this.push.start().catch((error) => {
        this.logger.error('push start failed (polling continues)', error);
        this.emitChange();
      });
    } else if (this.push) {
      await this.push.stop().catch(() => undefined);
      this.push = undefined;
    }

    const detector = new ProgramDetector({
      push: this.push,
      cookieHeader: () => this.auth.getCookieHeader(),
      pollIntervalMs: settings.pollIntervalSec * 1000,
      logger: prefixLogger(this.logger, 'detector'),
    });
    for (const programId of this.active.keys()) {
      detector.markSeen(programId);
    }
    detector.on('program', (program) => void this.handleDetected(program));
    // ポーリングの成否からセッション切れを判定してバナーに出す
    detector.on('polled', () => {
      if (this.authExpired) {
        this.authExpired = false;
        this.emitChange();
      }
    });
    detector.on('pollError', (error) => {
      if (error.name === 'NotAuthenticatedError' && !this.authExpired) {
        this.authExpired = true;
        this.emitChange();
      }
    });
    detector.start();
    this.detector = detector;
    this.logger.info(
      `detection started: push=${settings.pushEnabled} poll=${settings.pollIntervalSec}s targets=${settings.targets.filter((t) => t.enabled).length}`,
    );
    this.emitChange();
  }

  private async handleDetected(program: DetectedProgram): Promise<void> {
    const settings = this.settings.get();
    const target = settings.targets.find(
      (t) => t.enabled && program.providerId !== undefined && t.userId === program.providerId,
    );
    if (!target) {
      this.logger.debug(
        `[detector] ${program.programId} by ${program.providerName ?? program.providerId ?? '?'} is not a target`,
      );
      return;
    }
    if (program.alreadyOnAir && !settings.recordOngoingOnStart) {
      this.logger.info(`[detector] skip ongoing program ${program.programId} (${target.name})`);
      return;
    }
    this.logger.info(
      `[detector] target program via ${program.source}: ${program.programId} "${program.title}" by ${target.name}`,
    );
    // 番組情報の取得などで一時的に失敗しても、放送中なら何度か開始を試みる。
    // それでも駄目なら既知扱いを解除し、次のポーリングや push で拾い直せるようにする
    for (let attempt = 1; attempt <= DETECT_START_ATTEMPTS; attempt += 1) {
      try {
        await this.startRecording(program.programId, program.source, {
          title: program.title,
          providerId: program.providerId,
          providerName: target.name,
        });
        return;
      } catch (error) {
        const message = (error as Error).message;
        if (message.endsWith(NicoLiveProgramStatus.ended)) {
          this.logger.info(`[rec] ${program.programId} already ended, not recording`);
          return;
        }
        this.logger.warn(
          `[rec] could not start ${program.programId} (attempt ${attempt}/${DETECT_START_ATTEMPTS}): ${message}`,
        );
        if (attempt < DETECT_START_ATTEMPTS && !this.stopped) {
          await new Promise((resolve) => setTimeout(resolve, DETECT_START_RETRY_MS));
        }
      }
    }
    this.logger.error(`[rec] giving up on ${program.programId} for now; it may be detected again`);
    this.detector?.unmarkSeen(program.programId);
  }

  /**
   * 録画を開始する。番組情報を先に取得し、取得できない番組は例外にする
   * (手動録画の入力エラーを呼び出し側で表示するため)
   */
  async startRecording(
    programId: string,
    source: RecordingSource,
    meta: { title?: string; providerId?: string; providerName?: string } = {},
  ): Promise<RecordingInfo> {
    const existing = this.active.get(programId);
    if (existing) {
      return existing.info;
    }
    const settings = this.settings.get();
    const cookies = await this.auth.getCookieRecord();

    let programInfo: NicoLiveProgramInfo;
    try {
      programInfo = await new NicoClient(programId, { cookies }).getProgramInfo();
    } catch (error) {
      throw codedError(ERROR_CODES.programUnavailable, (error as Error).message);
    }
    if (programInfo.status === NicoLiveProgramStatus.ended || !programInfo.webSocketUrl) {
      throw codedError(ERROR_CODES.programUnavailable, programInfo.status);
    }
    this.detector?.markSeen(programId);

    const providerName = meta.providerName ?? programInfo.providerName;
    const providerId = meta.providerId ?? programInfo.providerId;
    const outputDir = path.join(
      settings.outputDir,
      sanitizeDirName(providerName ?? providerId ?? 'unknown'),
    );
    // 同じ番組を録り直す場合 (クラッシュ後の再起動など) は、前回のファイルとコメント数を引き継ぐ
    const previous = this.history.get(programId);
    const previousPaths = previous?.videoPaths ?? [];
    const previousBytes = await sumFileSizes(previousPaths);
    const info: RecordingInfo = {
      programId,
      title: programInfo.title || meta.title || programId,
      providerId,
      providerName,
      source,
      state: 'starting',
      startedAt: new Date().toISOString(),
      commentCount: previous?.commentCount ?? 0,
      videoBytes: previousBytes,
      outputDir,
      videoPaths: previousPaths.length > 0 ? previousPaths : undefined,
      commentsPath: previous?.commentsPath,
    };
    const controller = new AbortController();
    const recording: ActiveRecording = {
      info,
      controller,
      done: Promise.resolve(),
      finishedPartBytes: previousBytes,
    };
    this.active.set(programId, recording);
    // 開始時点で履歴に残す。途中でアプリが落ちても「中断」として復元できる
    this.history.upsert(info);
    this.emitChange();

    recording.done = (async () => {
      try {
        info.state = 'recording';
        this.emitChange();
        this.logger.info(`[rec] start ${programId} "${info.title}" by ${providerName ?? '?'}`);
        this.notify('録画を開始しました', `${providerName ?? ''} ${info.title}`);

        recording.sizeTimer = setInterval(() => void this.refreshSize(recording), SIZE_POLL_MS);

        // 映像が異常終了し、番組がまだ放送中なら、連番付きの別ファイルで録画を再開する
        let attempt = 1;
        let delayMs = RETRY_BASE_DELAY_MS;
        let outcome: 'done' | 'failed' = 'done';
        let lastReason = 'no video';
        while (true) {
          // コメント件数はパートをまたいで累計する
          const countBefore = info.commentCount;
          const result = await recordProgram(
            {
              programId,
              outputDir,
              cookies,
              ffmpegPath: this.ffmpegPath,
              logger: prefixLogger(this.logger, programId),
              programInfo,
              attempt,
              // 既存ファイルと重ならない連番を recorder が選ぶので、実際の値をここで受け取る
              onPaths: (paths) => {
                info.attempt = paths.attempt;
                info.videoPath = paths.videoPath;
                info.commentsPath ??= paths.commentsPath;
              },
              // コメントは最初のパートのファイルに追記し続ける
              commentsPath: info.commentsPath,
              prefetchBackwardComments: attempt === 1 && !previous,
              onComment: (_comment, count) => {
                info.commentCount = countBefore + count;
              },
            },
            controller.signal,
          );
          info.videoPath = result.videoPath;
          info.videoPaths = [...(info.videoPaths ?? []), result.videoPath];
          await this.refreshSize(recording);
          recording.finishedPartBytes = info.videoBytes;

          const errorText = result.errors.map((e) => `${e.target}: ${e.message}`).join(' / ');
          lastReason = result.video?.reason ?? 'no video';
          const videoOk = result.video !== undefined;
          const abnormal =
            !controller.signal.aborted &&
            (!videoOk || lastReason === 'idle' || lastReason === 'disconnected');
          if (!abnormal) {
            outcome = videoOk ? 'done' : 'failed';
            info.error = result.errors.length > 0 ? errorText : undefined;
            break;
          }
          if (attempt >= MAX_RECORD_ATTEMPTS) {
            outcome = 'failed';
            info.error = `再開の上限 (${MAX_RECORD_ATTEMPTS} 回) に達しました: ${errorText || lastReason}`;
            break;
          }

          info.state = 'starting';
          this.emitChange();
          this.logger.warn(
            `[rec] video stopped (${errorText || lastReason}) for ${programId}, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_RECORD_ATTEMPTS})`,
          );
          await abortableDelay(delayMs, controller.signal);
          if (controller.signal.aborted) {
            outcome = 'done';
            break;
          }
          // 待っている間に番組が終わっていたら、そこまでの録画で完了とする。
          // 番組情報の取得に失敗したときは終了とみなさず、次の試行に回す
          const latest = await new NicoClient(programId, { cookies })
            .getProgramInfo()
            .catch((error: unknown) => {
              this.logger.warn(`[rec] could not check ${programId} before resuming`, error);
              return undefined;
            });
          if (latest && (latest.status === NicoLiveProgramStatus.ended || !latest.webSocketUrl)) {
            this.logger.info(`[rec] ${programId} has ended, not resuming`);
            outcome = 'done';
            info.error = undefined;
            break;
          }
          if (latest) {
            // 切断の原因が WebSocket URL の失効でも再開できるよう、最新の番組情報で繋ぎ直す
            programInfo = latest;
          }
          attempt += 1;
          delayMs = Math.min(RETRY_MAX_DELAY_MS, delayMs * 2);
          info.state = 'recording';
          this.emitChange();
          this.logger.info(`[rec] resume ${programId} (attempt ${attempt})`);
        }

        info.state = outcome;
        this.logger.info(
          `[rec] ${outcome === 'done' ? 'finished' : 'failed'} ${programId} "${info.title}" (${lastReason}, ${info.commentCount} comments, ${attempt} part${attempt > 1 ? 's' : ''})`,
        );
        this.notify(
          outcome === 'done' ? '録画が終了しました' : '録画に失敗しました',
          `${providerName ?? ''} ${info.title}`,
        );
      } catch (error) {
        info.state = 'failed';
        info.error = (error as Error).message;
        this.logger.error(`[rec] failed ${programId}`, error);
        this.notify('録画に失敗しました', `${info.title}: ${info.error}`);
      } finally {
        if (recording.sizeTimer) {
          clearInterval(recording.sizeTimer);
        }
        info.endedAt = new Date().toISOString();
        this.active.delete(programId);
        this.history.upsert(info);
        this.historyVersionCounter += 1;
        this.emitChange();
      }
    })();
    return info;
  }

  stopRecording(programId: string): boolean {
    const recording = this.active.get(programId);
    if (!recording) {
      return false;
    }
    recording.info.state = 'finishing';
    recording.controller.abort();
    this.logger.info(`[rec] stop requested ${programId}`);
    this.emitChange();
    return true;
  }

  private async isOutputDirWritable(dir: string): Promise<boolean> {
    const cached = this.outputDirCheck;
    if (cached && cached.dir === dir && Date.now() - cached.checkedAt < OUTPUT_DIR_CHECK_TTL_MS) {
      return cached.writable;
    }
    let writable = false;
    try {
      await fs.access(dir, fs.constants.W_OK);
      writable = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // まだ無いディレクトリは、作れる場所なら書き込めるとみなす
        try {
          await fs.access(path.dirname(dir), fs.constants.W_OK);
          writable = true;
        } catch {
          writable = false;
        }
      }
    }
    this.outputDirCheck = { dir, writable, checkedAt: Date.now() };
    return writable;
  }

  /** 現在のファイルのサイズに、再開前のファイルの合計を足して videoBytes にする */
  private async refreshSize(recording: ActiveRecording): Promise<void> {
    const info = recording.info;
    const videoPath = info.videoPath ?? (await this.findVideoPath(info));
    if (!videoPath) {
      return;
    }
    try {
      const stat = await fs.stat(videoPath);
      const total = recording.finishedPartBytes + stat.size;
      if (total !== info.videoBytes || info.videoPath !== videoPath) {
        info.videoBytes = total;
        info.videoPath = videoPath;
        this.emitChange();
      }
    } catch {
      // まだファイルが無い
    }
  }

  /** ファイル名は録画側が決めるので、現在の attempt に対応する .ts を保存先から探す */
  private async findVideoPath(info: RecordingInfo): Promise<string | undefined> {
    try {
      const entries = await fs.readdir(info.outputDir);
      const suffix = (info.attempt ?? 1) > 1 ? `_${info.attempt}.ts` : '.ts';
      const name = entries.find(
        (e) =>
          e.includes(`_${info.programId}_`) &&
          e.endsWith(suffix) &&
          ((info.attempt ?? 1) > 1 || !/_\d+\.ts$/.test(e)),
      );
      return name ? path.join(info.outputDir, name) : undefined;
    } catch {
      return undefined;
    }
  }

  private notify(title: string, body: string): void {
    if (!this.settings.get().notificationsEnabled || !Notification.isSupported()) {
      return;
    }
    try {
      new Notification({ title, body }).show();
    } catch (error) {
      this.logger.warn('notification failed', error);
    }
  }

  private emitChange(): void {
    this.emit('change');
  }
}

async function sumFileSizes(paths: string[]): Promise<number> {
  let total = 0;
  for (const filePath of paths) {
    try {
      total += (await fs.stat(filePath)).size;
    } catch {
      // 消されたファイルは数えない
    }
  }
  return total;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sanitizeDirName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'unknown';
}
