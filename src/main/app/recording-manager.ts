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
  type AppSettings,
  type RecordingSource,
} from '../../shared/types';
import type { NicoAuth } from './auth';
import { formatBytes } from '../../shared/format';
import { HistoryStore } from './history-store';
import type { SettingsStore } from './settings-store';

/** 1 パート (1 つの出力ファイル) の進行状態。パートが終わったら丸ごと捨てる */
interface RecordingPart {
  /** このパートだけを止めるための controller (録画全体の停止とは別) */
  controller: AbortController;
  /** 書き込み中のファイル。recorder が連番を決めた時点 (onPaths) で分かる */
  path?: string;
  /** ファイルを一度でも観測したか (消えたことの判定に使う) */
  fileSeen: boolean;
  /** 出力ファイルの消失で止めた */
  lost: boolean;
  /** 消えたパートを一覧と容量から外す処理。録画本体が先に終わっても、これを待ってから状態を確定する */
  cleanup?: Promise<void>;
}

interface ActiveRecording {
  info: RecordingInfo;
  controller: AbortController;
  done: Promise<void>;
  sizeTimer?: NodeJS.Timeout;
  /** 終わったパートの合計サイズ */
  finishedPartBytes: number;
  /** 履歴に途中経過を書いた時刻 (クラッシュ時の復元用) */
  snapshotAt: number;
  /** 進行中のパート。再開待ちの間は undefined で、サイズ監視は何も数えない */
  part?: RecordingPart;
}

export interface RecordingManagerOptions {
  settings: SettingsStore;
  auth: NicoAuth;
  pushStore: PushStateStore;
  history: HistoryStore;
  logger: Logger;
  ffmpegPath?: string;
  /** 保存先の空き容量 (バイト) を返す。テストで差し替える。取得できなければ undefined */
  diskProbe?: (dir: string) => Promise<number | undefined>;
}

const SIZE_POLL_MS = 1_000;
const OUTPUT_DIR_CHECK_TTL_MS = 30_000;
/** 録画が途中で止まったときの再開の上限と待ち時間 */
const MAX_RECORD_ATTEMPTS = 10;
/** 保存先の空き容量を確認する間隔 */
const DISK_CHECK_MS = 60_000;
const GIB = 1024 ** 3;
/** 空き容量の表示は 0.01 GB 単位なので、それより細かい変動では画面を更新しない */
const DISK_SHOWN_UNIT = GIB / 100;
/** 検知直後の開始 (番組情報の取得) が失敗したときの再試行 */
const DETECT_START_ATTEMPTS = 3;
const DETECT_START_RETRY_MS = 30_000;
/** 録画中の途中経過を履歴に書く間隔 (クラッシュしても進捗が残るように) */
const HISTORY_SNAPSHOT_MS = 30_000;
/** 終了時に push の停止を待つ上限 (進行中の start の後ろに並ぶため) */
const PUSH_STOP_TIMEOUT_MS = 3_000;
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
  private readonly diskProbe: (dir: string) => Promise<number | undefined>;
  private diskTimer?: NodeJS.Timeout;
  /** 最後に測れた空き容量。保存先が変わったら捨てる */
  private diskSample?: { dir: string; free: number };
  /** 最後に測ったときの保存先としきい値。設定変更で測り直す必要があるかの判断に使う */
  private diskChecked?: Pick<AppSettings, 'outputDir' | 'minFreeSpaceGb'>;
  private diskGeneration = 0;
  /** 最後に判定したとき空き容量が少なかったか (切り替わったときだけ通知する) */
  private diskLow = false;
  /** 最後に画面へ出した空き容量 (表示の桁で丸めたもの)。変わらなければ change を出さない */
  private diskShown?: number;

  private push?: WebPushManager;
  private detector?: ProgramDetector;
  private readonly active = new Map<string, ActiveRecording>();
  /** 検知器を作り直しても、ユーザーが止めた放送を自動で再開しない */
  private readonly manuallyStopped = new Set<string>();
  /** 開始処理中 (番組情報の取得など active に入る前) の番組。同じ番組の二重開始を防ぐ */
  private readonly starting = new Map<string, Promise<RecordingInfo>>();
  private readonly history: HistoryStore;
  private historyVersionCounter = 0;
  private restarting?: Promise<void>;
  private loggingOut?: Promise<void>;
  /** 再起動の実行中に別の変更が来た (終わってから最新の設定でもう一度回す) */
  private restartAgain = false;
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
    this.diskProbe = options.diskProbe ?? freeSpaceOf;

    const pushLogger = prefixLogger(this.logger, 'autopush');
    setPushLogger({
      debug: (...args) => pushLogger.debug(...args),
      info: (...args) => pushLogger.info(...args),
      warn: (...args) => pushLogger.warn(...args),
      error: (...args) => pushLogger.error(...args),
    });

    this.auth.on('change', () => {
      this.authExpired = false;
      void this.restartDetection();
    });
    let detectionSettings = detectionKey(this.settings.get());
    this.settings.on('change', (settings) => {
      // 通知や保存先の変更で初回ポーリングに戻さない。検知に関わる変更だけを反映する
      const next = detectionKey(settings);
      if (next !== detectionSettings) {
        detectionSettings = next;
        void this.restartDetection();
      }
      // 空き容量は保存先かしきい値が変わったときだけ測り直す (対象の追加などでは statfs を走らせない)
      if (
        settings.outputDir !== this.diskChecked?.outputDir ||
        settings.minFreeSpaceGb !== this.diskChecked?.minFreeSpaceGb
      ) {
        void this.refreshDiskSpace();
      }
    });
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

  /** 確認ダイアログ用。番組情報の取得中と録画中を重複なく数える */
  getActiveRecordingCount(): number {
    return new Set([...this.starting.keys(), ...this.active.keys()]).size;
  }

  /** 合計サイズから削除済みを除くため、条件に合う全件でファイルの有無を確認する */
  async getHistoryPage(query: HistoryQuery): Promise<HistoryPage> {
    const matched = await HistoryStore.checkExistence(this.history.match(query));
    return HistoryStore.paginate(matched, query, this.history.providers());
  }

  getCommentPaths(programId: string): string[] {
    const info = this.history.get(programId);
    return info?.commentsPaths ?? (info?.commentsPath ? [info.commentsPath] : []);
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
    if (this.diskLow && this.diskSample) {
      alerts.push({
        kind: 'disk-space',
        severity: 'warn',
        message: `保存先の空き容量が ${formatBytes(this.diskSample.free)} です (しきい値 ${settings.minFreeSpaceGb} GB)`,
        actionLabel: '保存先を変更',
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
    await this.refreshDiskSpace();
    this.diskTimer = setInterval(() => void this.refreshDiskSpace(), DISK_CHECK_MS);
  }

  /** 最後に確認した保存先の空き容量 (バイト) */
  get diskFreeBytes(): number | undefined {
    return this.diskSample?.free;
  }

  /**
   * 保存先の空き容量を測り直す。しきい値を下回った/回復したときだけログと通知を出し、
   * 録画は止めない (取りこぼしより、少しでも録れている方がよい)
   */
  async refreshDiskSpace(): Promise<void> {
    // interval と設定変更から同時に走るので、最新の呼び出しの結果だけを反映する
    this.diskGeneration += 1;
    const generation = this.diskGeneration;
    const settings = this.settings.get();
    this.diskChecked = { outputDir: settings.outputDir, minFreeSpaceGb: settings.minFreeSpaceGb };
    if (settings.minFreeSpaceGb <= 0) {
      // 0 は確認しない。測定値を捨てれば警告と表示も消える
      this.diskSample = undefined;
      this.evaluateDiskSpace();
      return;
    }
    const free = await this.diskProbe(settings.outputDir).catch(() => undefined);
    if (generation !== this.diskGeneration) {
      return;
    }
    if (free !== undefined) {
      this.diskSample = { dir: settings.outputDir, free };
    } else {
      // 取得できないのは回復ではない。同じ保存先の直前の測定値は使い続け、別の保存先のものなら捨てる
      this.logger.debug(`[rec] could not read the free space of ${settings.outputDir}`);
      if (this.diskSample?.dir !== settings.outputDir) {
        this.diskSample = undefined;
      }
    }
    this.evaluateDiskSpace();
  }

  /** 測定値を今の設定で判定し、しきい値をまたいだときだけログと通知を出す */
  private evaluateDiskSpace(): void {
    const settings = this.settings.get();
    const sample = this.diskSample;
    const low = sample !== undefined && sample.free < settings.minFreeSpaceGb * GIB;
    const lowChanged = low !== this.diskLow;
    this.diskLow = low;
    if (lowChanged && sample) {
      if (low) {
        const message = `保存先の空き容量が少なくなっています (残り ${formatBytes(sample.free)}、しきい値 ${settings.minFreeSpaceGb} GB)`;
        this.logger.warn(`[rec] ${message}: ${sample.dir}`);
        this.notify('保存先の空き容量が少なくなっています', message);
      } else {
        this.logger.info(
          `[rec] 保存先の空き容量が回復しました (残り ${formatBytes(sample.free)}): ${sample.dir}`,
        );
      }
    }
    // 空き容量は他のプロセスの書き込みで常に揺れるので、表示が変わるときだけ画面に知らせる
    const shown = sample === undefined ? undefined : Math.round(sample.free / DISK_SHOWN_UNIT);
    if (lowChanged || shown !== this.diskShown) {
      this.diskShown = shown;
      this.emitChange();
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.detector?.stop();
    this.detector = undefined;
    if (this.diskTimer) {
      clearInterval(this.diskTimer);
      this.diskTimer = undefined;
    }
    // push の stop は進行中の start (ネットワークのタイムアウト待ち) の後ろに並ぶので、長くは待たない
    if (this.push) {
      const push = this.push;
      this.push = undefined;
      await Promise.race([
        push.stop().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, PUSH_STOP_TIMEOUT_MS)),
      ]);
    }
    // 開始処理中 (番組情報の取得など) のものは、active に入るか失敗するまで待ってから止める
    await Promise.allSettled([...this.starting.values()]);
    for (const recording of this.active.values()) {
      recording.controller.abort();
    }
    await Promise.allSettled([...this.active.values()].map((r) => r.done));
  }

  /** ログイン状態や設定の変更を反映して検知を組み直す */
  restartDetection(): Promise<void> {
    if (this.loggingOut) {
      return Promise.resolve();
    }
    if (this.restarting) {
      // 設定は実行の先頭で読むので、途中で来た変更は合流させるだけでは反映されない
      this.restartAgain = true;
      return this.restarting;
    }
    this.restarting = (async () => {
      do {
        this.restartAgain = false;
        await this.doRestartDetection();
      } while (this.restartAgain && !this.stopped);
    })().finally(() => {
      this.restarting = undefined;
    });
    return this.restarting;
  }

  private async doRestartDetection(): Promise<void> {
    if (this.stopped || this.loggingOut) {
      return;
    }
    this.detector?.stop();
    this.detector = undefined;

    const settings = this.settings.get();
    const loggedIn = await this.auth.isLoggedIn();
    // Cookie の読み出し中にログアウトが始まった場合も、検知を再開しない
    if (this.loggingOut) {
      return;
    }
    if (!loggedIn) {
      this.logger.info('detection paused: not logged in');
      await this.stopPush();
      this.emitChange();
      return;
    }
    // 有効な対象が無ければ検知しても録画しないので、ポーリングも push も止めて外部にアクセスしない
    const targetCount = settings.targets.filter((t) => t.enabled).length;
    if (targetCount === 0) {
      this.logger.info('detection paused: no enabled targets');
      await this.stopPush();
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
    } else {
      await this.stopPush();
    }

    // push の停止待ちにログアウトが始まった場合も、検知器を作らない
    if (this.loggingOut) {
      return;
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
    for (const programId of this.manuallyStopped) {
      detector.markSeen(programId);
    }
    detector.on('program', (program) => {
      // 停止前から取得中だった通知は、検知器を止めた後に届いても録画しない
      if (this.detector === detector && !this.loggingOut) {
        void this.handleDetected(program);
      }
    });
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
      `detection started: push=${settings.pushEnabled} poll=${settings.pollIntervalSec}s targets=${targetCount}`,
    );
    this.emitChange();
  }

  private async stopPush(): Promise<void> {
    if (!this.push) {
      return;
    }
    await this.push.stop().catch(() => undefined);
    this.push = undefined;
  }

  /** Cookie を削除する前に、アカウントに紐づく push 購読を破棄する */
  logout(): Promise<void> {
    if (this.loggingOut) {
      return this.loggingOut;
    }
    this.detector?.stop();
    this.detector = undefined;
    this.loggingOut = (async () => {
      try {
        // 進行中の検知再起動が push を操作し終わってから解除する
        await this.restarting;
        // 新しい開始を止めた上で、録画ファイルと履歴の書き込み完了を待つ
        const recordings = [...this.active.values()];
        for (const programId of this.starting.keys()) {
          this.manuallyStopped.add(programId);
        }
        for (const recording of recordings) {
          this.stopRecording(recording.info.programId);
        }
        await Promise.allSettled([
          ...this.starting.values(),
          ...recordings.map((recording) => recording.done),
        ]);
        try {
          this.history.flush();
        } catch (error) {
          this.logger.error('history: flush on logout failed', error);
        }
        const push =
          this.push ??
          new WebPushManager({
            store: this.pushStore,
            cookieHeader: () => this.auth.getCookieHeader(),
            logger: prefixLogger(this.logger, 'push'),
          });
        await push.reset();
      } catch (error) {
        this.logger.warn('push: cleanup on logout failed', error);
      } finally {
        // 解除に失敗しても Cookie の削除と画面への通知は行う
        this.push = undefined;
        await this.auth.logout();
      }
    })().finally(() => {
      this.loggingOut = undefined;
      this.emitChange();
    });
    return this.loggingOut;
  }

  private async handleDetected(program: DetectedProgram): Promise<void> {
    // 停止前から解決中だった古い通知にも、停止の意思を適用する
    if (this.manuallyStopped.has(program.programId)) {
      return;
    }
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
    // それでも駄目なら既知扱いを解除し、次のポーリングや push で拾い直せるようにする。
    // 待っている間に設定が変わったり検知器が作り直されたりしたら、古い判断で続けずに抜ける
    const detector = this.detector;
    for (let attempt = 1; attempt <= DETECT_START_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        if (this.stopped || this.detector !== detector) {
          this.logger.info(
            `[rec] detection changed while waiting, dropping retry of ${program.programId}`,
          );
          return;
        }
        const stillTarget = this.settings
          .get()
          .targets.some((t) => t.enabled && t.userId === program.providerId);
        if (!stillTarget) {
          this.logger.info(`[rec] ${program.programId} is no longer a target, not retrying`);
          return;
        }
      }
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
    detector?.unmarkSeen(program.programId);
  }

  /**
   * 録画を開始する。番組情報を先に取得し、取得できない番組は例外にする
   * (手動録画の入力エラーを呼び出し側で表示するため)
   */
  startRecording(
    programId: string,
    source: RecordingSource,
    meta: { title?: string; providerId?: string; providerName?: string } = {},
  ): Promise<RecordingInfo> {
    // 確認後は、別ウィンドウや遅れて届いた要求から新しい録画を始めない
    if (this.loggingOut) {
      return Promise.reject(new Error('ログアウト処理中のため録画を開始できません'));
    }
    const existing = this.active.get(programId);
    if (existing) {
      return Promise.resolve(existing.info);
    }
    // active に入るまでの非同期区間 (番組情報の取得など) でも二重開始しないよう、最初の await より前に予約する
    const pending = this.starting.get(programId);
    if (pending) {
      return pending;
    }
    if (source === 'manual') {
      this.manuallyStopped.delete(programId);
    }
    const promise = this.doStartRecording(programId, source, meta).finally(() => {
      this.starting.delete(programId);
    });
    this.starting.set(programId, promise);
    return promise;
  }

  private async doStartRecording(
    programId: string,
    source: RecordingSource,
    meta: { title?: string; providerId?: string; providerName?: string },
  ): Promise<RecordingInfo> {
    const settings = this.settings.get();
    const cookies = await this.auth.getCookieRecord();

    let programInfo: NicoLiveProgramInfo;
    try {
      programInfo = await new NicoClient(programId, { cookies }).getProgramInfo();
    } catch (error) {
      throw codedError(ERROR_CODES.programUnavailable, (error as Error).message);
    }
    const mode =
      source === 'manual' && programInfo.status === NicoLiveProgramStatus.ended
        ? 'timeshift'
        : 'live';
    if (mode === 'timeshift' && !programInfo.webSocketUrl) {
      throw codedError(ERROR_CODES.timeshiftUnavailable);
    }
    if (
      (mode === 'live' && programInfo.status === NicoLiveProgramStatus.ended) ||
      !programInfo.webSocketUrl
    ) {
      throw codedError(ERROR_CODES.programUnavailable, programInfo.status);
    }
    this.detector?.markSeen(programId);
    if (this.diskLow) {
      this.logger.warn(`[rec] starting ${programId} although disk space is low`);
    }

    const providerName = meta.providerName ?? programInfo.providerName;
    const providerId = meta.providerId ?? programInfo.providerId;
    // 同名の配信者を区別できるように ID を先頭に付け、名前がなければ ID だけを使う
    const providerDirId = sanitizeDirName(providerId ?? 'unknown');
    const outputDir = path.join(
      settings.outputDir,
      providerName?.trim() ? `${providerDirId}_${sanitizeDirName(providerName)}` : providerDirId,
    );
    // 同じ番組を録り直す場合 (クラッシュ後の再起動など) は、前回のファイルとコメント数を引き継ぐ。
    // 履歴にはファイル生成前の候補パスも残り得るので、実在するものだけを対象にする
    const previous = this.history.get(programId);
    const previousParts = await statFiles(
      previous?.videoPaths ?? (previous?.videoPath ? [previous.videoPath] : []),
    );
    const previousPaths = previousParts.map((p) => p.path);
    const previousBytes = sumSizes(previousParts);
    // 旧 JSONL は変更せず残し、CSV だけを再開先として引き継ぐ
    const previousCommentsPath =
      previous?.commentsPath?.endsWith('.csv') && (await fileExists(previous.commentsPath))
        ? previous.commentsPath
        : undefined;
    const priorCommentPaths =
      mode === 'timeshift'
        ? (
            await statFiles(
              [
                ...new Set([
                  ...(previous?.commentsPaths ?? []),
                  ...(previousCommentsPath ? [previousCommentsPath] : []),
                ]),
              ].filter((name) => name.endsWith('.csv')),
            )
          ).map((entry) => entry.path)
        : previous?.commentsPaths;
    const info: RecordingInfo = {
      programId,
      title: programInfo.title || meta.title || programId,
      providerId,
      providerName,
      source,
      mode,
      state: 'starting',
      startedAt: new Date().toISOString(),
      commentCount: previousCommentsPath ? (previous?.commentCount ?? 0) : 0,
      videoBytes: previousBytes,
      outputDir,
      videoPaths: previousPaths.length > 0 ? previousPaths : undefined,
      commentsPath: previousCommentsPath,
      commentsPaths: priorCommentPaths,
    };
    // 番組情報や既存ファイルの取得中に終了・ログアウトが始まった場合も起動しない
    if (this.stopped || this.loggingOut) {
      throw new Error(
        this.loggingOut ? 'ログアウトのため録画開始を取り消しました' : 'shutting down',
      );
    }
    const controller = new AbortController();
    const recording: ActiveRecording = {
      info,
      controller,
      done: Promise.resolve(),
      finishedPartBytes: previousBytes,
      snapshotAt: Date.now(),
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

        recording.sizeTimer = setInterval(() => void this.pollSize(recording), SIZE_POLL_MS);

        // 映像が異常終了し、番組がまだ放送中なら、連番付きの別ファイルで録画を再開する
        let attempt = 1;
        let delayMs = RETRY_BASE_DELAY_MS;
        let outcome: 'done' | 'failed' = 'done';
        let progressEmittedAt = 0;
        let lastReason = 'no video';
        while (true) {
          // コメント件数はパートをまたいで累計する
          const countBefore = mode === 'timeshift' ? 0 : info.commentCount;
          // パート単位の停止 (出力ファイルの消失など) は録画全体の停止と分けて扱う
          const part: RecordingPart = {
            controller: new AbortController(),
            fileSeen: false,
            lost: false,
          };
          recording.part = part;
          const result = await recordProgram(
            {
              programId,
              outputDir,
              cookies,
              ffmpegPath: this.ffmpegPath,
              logger: prefixLogger(this.logger, programId),
              programInfo,
              mode,
              onTimeshiftProgress: (progress) => {
                const changed =
                  info.timeshift?.phase !== progress.phase ||
                  info.timeshift?.comments !== progress.comments;
                info.timeshift = progress;
                if (info.completion !== 'cancelled') {
                  info.state =
                    progress.phase === 'saving' || progress.phase === 'comments'
                      ? 'finishing'
                      : 'recording';
                }
                if (changed || Date.now() - progressEmittedAt >= 500) {
                  progressEmittedAt = Date.now();
                  this.emitChange();
                }
              },
              attempt,
              // 既存ファイルと重ならない連番を recorder が選ぶので、実際の値をここで受け取る
              onPaths: (paths) => {
                info.attempt = paths.attempt;
                info.videoPath = paths.videoPath;
                if (!info.videoPaths?.includes(paths.videoPath)) {
                  info.videoPaths = [...(info.videoPaths ?? []), paths.videoPath];
                }
                if (mode === 'timeshift') {
                  info.commentCount = 0;
                  info.commentsPath = paths.commentsPath;
                  info.commentsPaths = [
                    ...new Set([...(info.commentsPaths ?? []), paths.commentsPath]),
                  ];
                } else {
                  info.commentsPath ??= paths.commentsPath;
                }
                part.path = paths.videoPath;
                // クラッシュしてもこのパートのファイルが履歴から辿れるように、決まった時点で書く
                this.history.upsert(info);
                recording.snapshotAt = Date.now();
              },
              // コメントは最初のパートのファイルに追記し続ける
              commentsPath: mode === 'live' ? info.commentsPath : undefined,
              // コメントファイルを新しく作るときだけ過去分を取得する (既存ファイルへの追記では重複するため)
              prefetchBackwardComments: !info.commentsPath,
              onComment: (_comment, count) => {
                info.commentCount = countBefore + count;
              },
            },
            AbortSignal.any([controller.signal, part.controller.signal]),
          );
          // パートのファイルを最終確認する。消えたのをサイズ監視が拾う前に録画本体が終わっていたら、
          // ここで消失として扱う。後始末が走っている途中なら、終わるまで待ってから確定する
          // (待たずに確定すると、古い一覧や容量を履歴に書いてしまう)
          await this.refreshSize(recording);
          if (part.cleanup) {
            await part.cleanup;
          }
          // このパートは完了済みの合計に繰り入れる。再開待ちの間のサイズ監視は何も数えない
          recording.part = undefined;
          const outputMissing = part.lost;
          // 消えたパートは後始末で一覧から外してあるので、代表パスは残っている最後のパート
          info.videoPath = info.videoPaths?.at(-1);
          recording.finishedPartBytes = info.videoBytes;
          this.history.upsert(info);
          recording.snapshotAt = Date.now();

          const errorText = result.errors.map((e) => `${e.target}: ${e.message}`).join(' / ');
          lastReason = outputMissing
            ? 'output file disappeared'
            : (result.video?.reason ?? 'no video');
          // 有限取得は再開しない。番組の終了状態だけで成功扱いにするライブの判定へ進めない。
          if (mode === 'timeshift') {
            info.timeshift = result.timeshift?.progress ?? info.timeshift;
            if (controller.signal.aborted) info.completion = 'cancelled';
            else if (outputMissing) info.completion = 'partial';
            else info.completion = result.timeshift?.completion ?? 'partial';
            outcome =
              info.completion === 'cancelled' || (result.video && !outputMissing)
                ? 'done'
                : 'failed';
            info.error =
              info.completion === 'cancelled'
                ? undefined
                : errorText ||
                  (info.completion === 'partial'
                    ? 'タイムシフトの取得が完了しませんでした'
                    : undefined);
            if (info.error) this.logger.warn(`[rec] ${programId}: ${info.error}`);
            break;
          }
          const videoOk = result.video !== undefined;
          const abnormal =
            !controller.signal.aborted &&
            (!videoOk || outputMissing || lastReason === 'idle' || lastReason === 'disconnected');
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
          // 番組情報の取得中に停止された場合も、次の録画パートへ進まない
          if (controller.signal.aborted) {
            outcome = 'done';
            break;
          }
          if (latest?.status === NicoLiveProgramStatus.ended) {
            this.logger.info(`[rec] ${programId} has ended, not resuming`);
            outcome = 'done';
            info.error = undefined;
            break;
          }
          // URL の欠落は放送終了ではなく、今のログイン状態では視聴できない可能性を示す
          if (latest && !latest.webSocketUrl) {
            outcome = 'failed';
            info.error =
              '視聴接続情報を取得できませんでした。ログイン状態と視聴権限を確認してください';
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
        let notification = outcome === 'done' ? '録画が終了しました' : '録画に失敗しました';
        if (info.completion === 'cancelled') notification = '録画を停止しました';
        this.notify(notification, `${providerName ?? ''} ${info.title}`);
      } catch (error) {
        info.state = 'failed';
        info.error =
          mode === 'timeshift'
            ? 'タイムシフトの取得または保存に失敗しました'
            : (error as Error).message;
        if (mode === 'timeshift') {
          info.completion = controller.signal.aborted ? 'cancelled' : 'partial';
          if (controller.signal.aborted) {
            info.state = 'done';
            info.error = undefined;
          }
        }
        if (info.completion === 'cancelled') {
          this.logger.info(`[rec] stopped ${programId}`);
          this.notify('録画を停止しました', info.title);
        } else {
          this.logger.error(`[rec] failed ${programId}`, mode === 'timeshift' ? info.error : error);
          this.notify('録画に失敗しました', `${info.title}: ${info.error}`);
        }
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
    if (recording.info.mode === 'timeshift') recording.info.completion = 'cancelled';
    this.manuallyStopped.add(programId);
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

  /** 1 秒ごとの監視: サイズを更新し、録画中の途中経過を定期的に履歴へ書く (クラッシュしても進捗が残るように) */
  private async pollSize(recording: ActiveRecording): Promise<void> {
    await this.refreshSize(recording);
    if (recording.part && Date.now() - recording.snapshotAt >= HISTORY_SNAPSHOT_MS) {
      this.history.upsert(recording.info);
      recording.snapshotAt = Date.now();
    }
  }

  /**
   * 書き込み中のファイルのサイズに、終わったパートの合計を足して videoBytes にする。
   * 終わったパートは finishedPartBytes に含まれているので、進行中のパート以外は見ない
   */
  private async refreshSize(recording: ActiveRecording): Promise<void> {
    const info = recording.info;
    const part = recording.part;
    const videoPath = part?.path;
    if (!part || !videoPath) {
      return;
    }
    let size: number | undefined;
    try {
      size = (await fs.stat(videoPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return;
      }
    }
    // stat を待つ間にパートが終わっていたら、完了済みの合計に足し込み済みなので何もしない
    if (recording.part !== part) {
      return;
    }
    // 消失を検知した後に、削除前に始まった stat が成功で戻ってきても、消えた分を足し戻さない
    if (size !== undefined && !part.lost) {
      part.fileSeen = true;
      const total = recording.finishedPartBytes + size;
      if (total !== info.videoBytes) {
        info.videoBytes = total;
        this.emitChange();
      }
      return;
    }
    // 一度は見えたファイルが無くなった = 録画中にファイルかフォルダが消された。
    // ffmpeg は消えたファイルに書き続けて内容を失うので、このパートを止めて別ファイルで再開する
    if (!part.fileSeen || part.lost) {
      return;
    }
    this.logger.error(
      `[rec] output file disappeared while recording ${info.programId}: ${videoPath}.${info.mode === 'timeshift' ? ' Stopping timeshift' : ' Restarting as a new part'}`,
    );
    part.lost = true;
    // 先に書き込みを止め、残ったファイルの数え直しは録画ループが待ち合わせる
    part.controller.abort();
    part.cleanup = this.discardLostPart(recording, videoPath);
    await part.cleanup;
  }

  /** 消えたパートを一覧と容量から外し、残っているパートだけで数え直す */
  private async discardLostPart(recording: ActiveRecording, lostPath: string): Promise<void> {
    const info = recording.info;
    // フォルダごと消された場合は以前のパートも無いので、残っているものだけを数え直す
    const survivors = await statFiles((info.videoPaths ?? []).filter((p) => p !== lostPath));
    info.videoPaths = survivors.length > 0 ? survivors.map((p) => p.path) : undefined;
    recording.finishedPartBytes = sumSizes(survivors);
    info.videoBytes = recording.finishedPartBytes;
    // コメントファイルも一緒に消えていれば、次のパートで作り直して過去分を取り直す
    if (info.commentsPath && !(await fileExists(info.commentsPath))) {
      this.logger.warn(`[rec] comment file disappeared too: ${info.commentsPath}`);
      info.commentsPath = undefined;
      info.commentCount = 0;
    }
    this.emitChange();
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

/**
 * ディレクトリのあるボリュームの空き容量 (バイト)。まだ無いディレクトリなら存在する親で調べる
 */
async function freeSpaceOf(dir: string): Promise<number | undefined> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const stat = await fs.statfs(current);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface FileSize {
  path: string;
  size: number;
}

/** 重複を除き、実在するファイルだけをサイズ付きで順序を保って返す (消されたファイルは数えない) */
async function statFiles(paths: string[]): Promise<FileSize[]> {
  const results = await Promise.all(
    [...new Set(paths)].map(async (filePath) => {
      try {
        return { path: filePath, size: (await fs.stat(filePath)).size };
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((r) => r !== undefined);
}

function sumSizes(files: FileSize[]): number {
  return files.reduce((total, f) => total + f.size, 0);
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

/** 対象の並び順や表示名を除き、検知を組み直す必要がある設定だけを比較する */
function detectionKey(settings: AppSettings): string {
  return JSON.stringify([
    settings.pushEnabled,
    settings.pollIntervalSec,
    settings.recordOngoingOnStart,
    settings.targets
      .filter((target) => target.enabled)
      .map((target) => target.userId)
      .sort(),
  ]);
}
