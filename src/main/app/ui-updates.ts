import type { AppStatus, LogEntry, UiState } from '../../shared/types';
import { buildLogs, buildStatus } from './app-status';
import type { IpcContext } from './ipc';

/** 連続する更新をまとめ、取得中に新しい変更があれば古い結果を送らず取り直す。 */
export class LatestPublisher<T> {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private revision = 0;

  constructor(
    private readonly read: () => T | Promise<T>,
    private readonly send: (value: T) => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  schedule = (): void => {
    if (this.stopped) return;
    this.revision += 1;
    this.arm();
  };

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private arm(): void {
    if (this.stopped || this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.publish();
    }, 200);
  }

  private async publish(): Promise<void> {
    this.running = true;
    const revision = this.revision;
    try {
      const value = await this.read();
      if (!this.stopped && revision === this.revision) this.send(value);
    } catch (error) {
      if (!this.stopped) this.onError(error);
    } finally {
      this.running = false;
      if (revision !== this.revision) this.arm();
    }
  }
}

interface UiDestination {
  status: (status: AppStatus) => void;
  logs: (logs: LogEntry[]) => void;
  settings: () => void;
}

/** 状態・ログ・設定の変更を、それぞれの配信経路へ結び付ける。 */
export class UiUpdates {
  private readonly status: LatestPublisher<AppStatus>;
  private readonly logs: LatestPublisher<LogEntry[]>;
  private readonly settings: LatestPublisher<void>;
  private showDebug: boolean;

  constructor(
    private readonly ctx: IpcContext,
    destination: UiDestination,
  ) {
    const onError = (error: unknown): void => ctx.logger.error('UI update failed', error);
    this.status = new LatestPublisher(() => buildStatus(ctx), destination.status, onError);
    // ログ配信自身の失敗をログへ戻すと無限に配信するため、標準エラーだけに出す。
    this.logs = new LatestPublisher(
      () => buildLogs(ctx),
      destination.logs,
      (error) => {
        process.stderr.write(`UI log update failed: ${String(error)}\n`);
      },
    );
    this.settings = new LatestPublisher<void>(() => undefined, destination.settings, onError);
    this.showDebug = ctx.settings.get().ui.showDebug;
    ctx.manager.on('change', this.status.schedule);
    ctx.auth.on('change', this.status.schedule);
    ctx.updates.on('change', this.status.schedule);
    ctx.settings.on('change', this.onSettings);
    ctx.settings.on('ui', this.onUi);
    ctx.logger.on('entry', this.onLog);
  }

  /** 外部でのファイル変更は、画面表示時と表示中の定期確認で読み直す。 */
  refreshStatus = (): void => this.status.schedule();

  stop(): void {
    this.ctx.manager.off('change', this.status.schedule);
    this.ctx.auth.off('change', this.status.schedule);
    this.ctx.updates.off('change', this.status.schedule);
    this.ctx.settings.off('change', this.onSettings);
    this.ctx.settings.off('ui', this.onUi);
    this.ctx.logger.off('entry', this.onLog);
    this.status.stop();
    this.logs.stop();
    this.settings.stop();
  }

  private onSettings = (): void => {
    this.status.schedule();
    this.settings.schedule();
  };

  private onUi = (ui: UiState): void => {
    this.settings.schedule();
    if (ui.showDebug !== this.showDebug) {
      this.showDebug = ui.showDebug;
      this.logs.schedule();
    }
  };

  private onLog = (entry: LogEntry): void => {
    if (entry.level !== 'debug' || this.showDebug) this.logs.schedule();
  };
}
