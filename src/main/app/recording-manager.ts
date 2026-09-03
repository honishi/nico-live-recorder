import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Notification } from 'electron';
import { ProgramDetector, type DetectedProgram } from '../core/detector/program-detector';
import { prefixLogger, type Logger } from '../core/logger';
import { recordProgram } from '../core/recorder/program-recorder';
import { NicoClient } from '../nico-client/NicoClient';
import { setPushLogger } from '../push/push-diagnostics';
import { WebPushManager, type PushStateStore } from '../push/web-push-manager';
import type { PushStatusInfo, RecordingInfo, RecordingSource } from '../../shared/types';
import type { NicoAuth } from './auth';
import type { SettingsStore } from './settings-store';

interface ActiveRecording {
  info: RecordingInfo;
  controller: AbortController;
  done: Promise<void>;
  sizeTimer?: NodeJS.Timeout;
}

export interface RecordingManagerOptions {
  settings: SettingsStore;
  auth: NicoAuth;
  pushStore: PushStateStore;
  logger: Logger;
  ffmpegPath?: string;
}

const HISTORY_LIMIT = 50;
const SIZE_POLL_MS = 5_000;

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
  private readonly history: RecordingInfo[] = [];
  private restarting?: Promise<void>;
  private stopped = false;

  constructor(options: RecordingManagerOptions) {
    super();
    this.settings = options.settings;
    this.auth = options.auth;
    this.pushStore = options.pushStore;
    this.logger = options.logger;
    this.ffmpegPath = options.ffmpegPath;

    const pushLogger = prefixLogger(this.logger, 'autopush');
    setPushLogger({
      debug: (...args) => pushLogger.debug(...args),
      warn: (...args) => pushLogger.warn(...args),
      error: (...args) => pushLogger.error(...args),
    });

    this.auth.on('change', () => void this.restartDetection());
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

  getRecordings(): RecordingInfo[] {
    return [...[...this.active.values()].map((a) => a.info), ...this.history];
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
        `detected ${program.programId} by ${program.providerName ?? program.providerId ?? '?'} (not a target)`,
      );
      return;
    }
    if (program.alreadyOnAir && !settings.recordOngoingOnStart) {
      this.logger.info(`skip ongoing program ${program.programId} (${target.name})`);
      return;
    }
    this.logger.info(
      `target program detected via ${program.source}: ${program.programId} "${program.title}" by ${target.name}`,
    );
    await this.startRecording(program.programId, program.source, {
      title: program.title,
      providerId: program.providerId,
      providerName: target.name,
    });
  }

  async startRecording(
    programId: string,
    source: RecordingSource,
    meta: { title?: string; providerId?: string; providerName?: string } = {},
  ): Promise<RecordingInfo> {
    const existing = this.active.get(programId);
    if (existing) {
      return existing.info;
    }
    this.detector?.markSeen(programId);

    const settings = this.settings.get();
    const cookies = await this.auth.getCookieRecord();
    const info: RecordingInfo = {
      programId,
      title: meta.title ?? programId,
      providerId: meta.providerId,
      providerName: meta.providerName,
      source,
      state: 'starting',
      startedAt: new Date().toISOString(),
      commentCount: 0,
      videoBytes: 0,
      outputDir: settings.outputDir,
    };
    const controller = new AbortController();
    const recording: ActiveRecording = { info, controller, done: Promise.resolve() };
    this.active.set(programId, recording);
    this.emitChange();

    recording.done = (async () => {
      try {
        const programInfo = await new NicoClient(programId, { cookies }).getProgramInfo();
        info.title = programInfo.title;
        info.providerId ??= programInfo.providerId;
        info.providerName ??= programInfo.providerName;
        const providerDir = sanitizeDirName(info.providerName ?? info.providerId ?? 'unknown');
        const outputDir = path.join(settings.outputDir, providerDir);
        info.outputDir = outputDir;
        info.state = 'recording';
        this.emitChange();
        this.notify('録画を開始しました', `${info.providerName ?? ''} ${info.title}`);

        recording.sizeTimer = setInterval(() => void this.refreshSize(recording), SIZE_POLL_MS);

        const result = await recordProgram(
          {
            programId,
            outputDir,
            cookies,
            ffmpegPath: this.ffmpegPath,
            logger: prefixLogger(this.logger, programId),
            programInfo,
            onComment: (_comment, count) => {
              info.commentCount = count;
            },
          },
          controller.signal,
        );
        info.videoPath = result.videoPath;
        await this.refreshSize(recording);
        if (result.errors.length > 0 && !result.video) {
          info.state = 'failed';
          info.error = result.errors.map((e) => `${e.target}: ${e.message}`).join(' / ');
        } else {
          info.state = 'done';
          if (result.errors.length > 0) {
            info.error = result.errors.map((e) => `${e.target}: ${e.message}`).join(' / ');
          }
        }
        this.notify(
          info.state === 'done' ? '録画が終了しました' : '録画に失敗しました',
          `${info.providerName ?? ''} ${info.title}`,
        );
      } catch (error) {
        info.state = 'failed';
        info.error = (error as Error).message;
        this.logger.error(`recording ${programId} failed`, error);
        this.notify('録画に失敗しました', `${info.title}: ${info.error}`);
      } finally {
        if (recording.sizeTimer) {
          clearInterval(recording.sizeTimer);
        }
        info.endedAt = new Date().toISOString();
        this.active.delete(programId);
        this.history.unshift(info);
        this.history.splice(HISTORY_LIMIT);
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
    this.emitChange();
    return true;
  }

  private async refreshSize(recording: ActiveRecording): Promise<void> {
    const videoPath = recording.info.videoPath ?? (await this.findVideoPath(recording.info));
    if (!videoPath) {
      return;
    }
    try {
      const stat = await fs.stat(videoPath);
      if (stat.size !== recording.info.videoBytes) {
        recording.info.videoBytes = stat.size;
        recording.info.videoPath = videoPath;
        this.emitChange();
      }
    } catch {
      // まだファイルが無い
    }
  }

  private async findVideoPath(info: RecordingInfo): Promise<string | undefined> {
    try {
      const entries = await fs.readdir(info.outputDir);
      const name = entries.find((e) => e.includes(`_${info.programId}_`) && e.endsWith('.ts'));
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

function sanitizeDirName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'unknown';
}
