import { EventEmitter } from 'node:events';
import type { AppUpdater, CancellationToken, ProgressInfo, UpdateInfo } from 'electron-updater';
import type { UpdateStatus, UpdateInstallResult } from '../../shared/types';
import type { Logger } from '../core/logger';

const RELEASES_URL = 'https://github.com/honishi/nico-live-recorder/releases';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_COOLDOWN_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;

/** 数字だけの一致は避け、ドライバーのコードと HTTP 応答の形式で分類する。 */
function classifyUpdateError(error: unknown): 'error' | 'rate-limited' | 'unavailable' {
  if (typeof error !== 'object' || error === null) return 'error';
  const { code, statusCode, message } = error as {
    code?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  let httpStatus = typeof statusCode === 'number' ? statusCode : undefined;
  if (httpStatus === undefined && typeof code === 'string' && /^HTTP_ERROR_\d{3}$/.test(code)) {
    httpStatus = Number(code.slice('HTTP_ERROR_'.length));
  }
  // GitHubProvider は cause を保持せず、元の HttpError.stack をメッセージに埋め込む。
  // この既知のラッパーだけを扱い、スタックの行番号や URL 中の数字を拾わない。
  if (httpStatus === undefined && typeof message === 'string') {
    let match: RegExpMatchArray | null = null;
    if (
      code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
      code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
      code === 'ERR_UPDATER_INVALID_RELEASE_FEED'
    ) {
      match = message.match(/(?:^|: )HttpError: (403|404|429)(?:\s|$)/);
    } else if (code === undefined) {
      // HttpExecutor.download の失敗は code を持たない Error として返る。
      match = message.match(/^Cannot download "[^"\r\n]+", status (403|404|429):/);
    }
    if (match) httpStatus = Number(match[1]);
  }
  if (httpStatus === 403 || httpStatus === 429) return 'rate-limited';
  if (
    httpStatus === 404 ||
    code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
    code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
    code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'
  ) {
    return 'unavailable';
  }
  return 'error';
}

/** Electron の実体は起動側で渡し、通信と更新イベントはテストで差し替える。 */
export type UpdateDriver = Pick<
  AppUpdater,
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'autoRunAppAfterInstall'
  | 'allowPrerelease'
  | 'allowDowngrade'
  | 'logger'
  | 'on'
  | 'checkForUpdates'
  | 'quitAndInstall'
>;

export interface UpdateInstallation {
  hasRecordings(): boolean;
  /** 録画の有無の再確認と、新規受付の停止を同期的に行う。 */
  prepare(): boolean;
  /** インストーラーがプロセスを終了させる前に、履歴・ログを書き出す。 */
  flush(): Promise<void>;
  /** 適用失敗時も録画受付を閉じたまま通常の再起動へ進む。 */
  recover(): void;
}

/** 更新の失敗を録画から切り離し、ユーザーが操作したときだけ適用する。 */
export class UpdateChecker extends EventEmitter {
  private status: UpdateStatus = {
    checking: false,
    result: 'unchecked',
    nextCheckAt: 0,
    installBlocked: false,
  };
  private inFlight?: Promise<UpdateStatus>;
  private interval?: NodeJS.Timeout;
  private installTimer?: NodeJS.Timeout;
  private downloadToken?: CancellationToken;
  private stopped = false;
  private recovering = false;

  constructor(
    private readonly updater: UpdateDriver | undefined,
    private readonly logger: Logger,
    private readonly installation: UpdateInstallation,
  ) {
    super();
    if (!updater) {
      this.status.result = 'disabled';
      return;
    }
    // 通常終了時には適用しない。macOS でも明示操作までは Squirrel へ渡さない。
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = {
      debug: (message) => logger.debug('[update]', message),
      info: (message: unknown) => logger.debug('[update]', message),
      warn: (message: unknown) => logger.debug('[update]', message),
      error: (message: unknown) => logger.debug('[update]', message),
    };
    updater.on('download-progress', (progress: ProgressInfo) => {
      if (this.status.result === 'installing') return;
      this.publish({ result: 'downloading', progress: Math.floor(progress.percent) });
    });
    updater.on('update-downloaded', (info: UpdateInfo) => {
      if (this.stopped || this.status.result === 'installing') return;
      this.downloadToken = undefined;
      this.logger.info(`v${info.version} の更新をダウンロードしました`);
      this.publish({ result: 'downloaded', release: this.release(info.version), progress: 100 });
    });
    // EventEmitter の error は常に受ける。確認・DL の失敗は Promise 側で一度だけ通知する。
    updater.on('error', (error: Error) => {
      if (this.status.result === 'installing') this.installFailed(error);
      else this.logger.debug('[update]', error);
    });
  }

  getStatus(): UpdateStatus {
    return structuredClone({
      ...this.status,
      installBlocked: this.installation.hasRecordings(),
    });
  }

  start(): void {
    if (!this.updater || this.interval || this.stopped) return;
    void this.check();
    this.interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.interval.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.interval);
    clearTimeout(this.installTimer);
    this.downloadToken?.cancel();
  }

  check(): Promise<UpdateStatus> {
    if (this.inFlight) return this.inFlight;
    // DL 完了後の別バージョンへの切替や、適用中の二重操作を防ぐ。
    if (
      !this.updater ||
      this.stopped ||
      Date.now() < this.status.nextCheckAt ||
      ['downloading', 'downloaded', 'installing'].includes(this.status.result)
    ) {
      return Promise.resolve(this.getStatus());
    }
    this.inFlight = this.checkRelease().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async checkRelease(): Promise<UpdateStatus> {
    this.publish({ checking: true, progress: undefined });
    try {
      const result = await this.updater!.checkForUpdates();
      if (this.stopped) {
        result?.cancellationToken?.cancel();
        // 終了中に返った自動 DL の reject も未処理にしない。
        void result?.downloadPromise?.catch(() => undefined);
        return this.getStatus();
      }
      if (!result) {
        this.publish({ result: 'unavailable' });
      } else if (!result.isUpdateAvailable) {
        this.publish({ result: 'current', release: undefined });
      } else {
        this.logger.info(`新しいバージョン v${result.updateInfo.version} があります`);
        this.downloadToken = result.cancellationToken;
        // キャッシュからの完了イベントが先に来ても、DL 中に巻き戻さない。
        if (this.status.result !== 'downloaded') {
          this.publish({ result: 'downloading', release: this.release(result.updateInfo.version) });
        }
        void result.downloadPromise?.catch((error: unknown) => this.failed(error));
      }
    } catch (error) {
      this.failed(error);
    } finally {
      this.publish({
        checking: false,
        checkedAt: new Date().toISOString(),
        nextCheckAt: Math.max(this.status.nextCheckAt, Date.now() + CHECK_COOLDOWN_MS),
      });
    }
    return this.getStatus();
  }

  install(): UpdateInstallResult {
    if (this.status.result === 'installing') return 'started';
    if (!this.updater || this.stopped || this.status.result !== 'downloaded') return 'not-ready';
    if (!this.installation.prepare()) return 'busy';
    this.publish({ result: 'installing' });
    this.logger.info('再起動して更新を適用します');
    // ネイティブ更新機構が応答しない場合も、受付を閉じた状態で放置しない。
    this.installTimer = setTimeout(
      () => this.installFailed(new Error('update install timed out')),
      INSTALL_TIMEOUT_MS,
    );
    this.installTimer.unref();
    void this.installAfterFlush();
    return 'started';
  }

  private async installAfterFlush(): Promise<void> {
    try {
      await this.installation.flush();
      // 保存待ちに通常終了・復旧へ移った場合、遅れてインストーラーを起動しない。
      if (this.stopped || this.recovering) return;
      // NSIS は起動後にアプリを強制終了し得るため、保存完了後にだけ引き渡す。
      this.updater!.quitAndInstall(true, true);
    } catch (error) {
      this.installFailed(error);
    }
  }

  private installFailed(error: unknown): void {
    if (this.stopped || this.recovering) return;
    this.recovering = true;
    clearTimeout(this.installTimer);
    this.logger.error('更新を適用できませんでした。現在のバージョンで再起動します', error);
    // macOS の遅延した更新イベントと録画開始が競合しないよう、同じプロセスでは受付を再開しない。
    this.installation.recover();
  }

  private failed(error: unknown): void {
    if (this.stopped) return;
    if (this.status.result === 'installing') {
      this.installFailed(error);
      return;
    }
    const result = classifyUpdateError(error);
    const delay = result === 'rate-limited' ? 60 * 60 * 1000 : CHECK_COOLDOWN_MS;
    this.logger.warn('更新を取得できませんでした。録画・監視は継続します', error);
    this.publish({ result, progress: undefined, nextCheckAt: Date.now() + delay });
  }

  private release(version: string): NonNullable<UpdateStatus['release']> {
    return { version, url: `${RELEASES_URL}/tag/v${encodeURIComponent(version)}` };
  }

  private publish(patch: Partial<UpdateStatus>): void {
    if (this.stopped) return;
    this.status = { ...this.status, ...patch };
    this.emit('change');
  }
}
