import { EventEmitter } from 'node:events';
import type { CancellationToken, UpdateCheckResult } from 'electron-updater';
import {
  UpdateChecker,
  flushUpdateState,
  type UpdateDriver,
} from '../../src/main/app/update-checker';
import { silentLogger } from '../../src/main/core/logger';

// Electron とネットワークに依存せず、イベントの順序と失敗を再現する。
class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  allowDowngrade = true;
  checkForUpdates = vi.fn<() => Promise<UpdateCheckResult | null>>();
  quitAndInstall = vi.fn();
}

function release(available = true, downloadPromise?: Promise<string[]>): UpdateCheckResult {
  const info = {
    version: '0.5.0',
    files: [],
    path: 'update.zip',
    sha512: 'checksum',
    releaseDate: '2026-09-12',
  };
  return { isUpdateAvailable: available, updateInfo: info, versionInfo: info, downloadPromise };
}

describe('UpdateChecker', () => {
  let updater: FakeUpdater;
  let checker: UpdateChecker;
  let busy: boolean;
  let prepare: ReturnType<typeof vi.fn<() => boolean>>;
  let flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let flushHistory: ReturnType<typeof vi.fn<() => void>>;
  let flushLog: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let warn: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  let recover: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    busy = false;
    updater = new FakeUpdater();
    prepare = vi.fn(() => !busy);
    flushHistory = vi.fn();
    flushLog = vi.fn(async () => {});
    warn = vi.fn();
    flush = vi.fn(() => flushUpdateState({ flush: flushHistory }, { flush: flushLog, warn }));
    recover = vi.fn();
    checker = new UpdateChecker(updater as unknown as UpdateDriver, silentLogger, {
      hasRecordings: () => busy,
      prepare,
      flush,
      recover,
    });
    updater.checkForUpdates.mockResolvedValue(release(false));
  });

  afterEach(() => {
    checker.stop();
    vi.useRealTimers();
  });

  test('正式版だけ自動取得し、通常終了時は適用しない', () => {
    expect(updater).toMatchObject({
      autoDownload: true,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      allowPrerelease: false,
      allowDowngrade: false,
    });
  });

  test('起動時と6時間ごとに確認し、手動確認の連打は合流する', async () => {
    const pending = checker.check();
    expect(checker.check()).toBe(pending);
    await pending;
    checker.start();
    checker.start();
    await checker.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    checker.stop();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  test('更新の取得・進捗・完了を通知し、ダウンロードだけでは再起動しない', async () => {
    updater.checkForUpdates.mockResolvedValue(release(true, Promise.resolve([])));
    expect(await checker.check()).toMatchObject({
      result: 'downloading',
      release: { version: '0.5.0' },
    });
    updater.emit('download-progress', { percent: 42.9 });
    expect(checker.getStatus().progress).toBe(42);
    updater.emit('update-downloaded', { version: '0.5.0' });
    expect(checker.getStatus()).toMatchObject({ result: 'downloaded', progress: 100 });
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    await checker.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  test('キャッシュの完了イベントが確認結果より先に届いても完了状態を保つ', async () => {
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-downloaded', { version: '0.5.0' });
      return release();
    });
    expect((await checker.check()).result).toBe('downloaded');
  });

  test('ダウンロード失敗は既知の更新を残して再試行できる', async () => {
    let fail!: (error: Error) => void;
    const download = new Promise<string[]>((_resolve, reject) => {
      fail = reject;
    });
    updater.checkForUpdates.mockResolvedValue(release(true, download));
    await checker.check();
    fail(new Error('checksum mismatch'));
    await download.catch(() => undefined);
    expect(checker.getStatus()).toMatchObject({ result: 'error', release: { version: '0.5.0' } });
    expect(checker.install()).toBe('not-ready');
    await vi.advanceTimersByTimeAsync(60_000);
    updater.checkForUpdates.mockResolvedValue(release());
    expect((await checker.check()).result).toBe('downloading');
  });

  test.each([
    [
      Object.assign(new Error('404 Not Found'), { statusCode: 404, code: 'HTTP_ERROR_404' }),
      'unavailable',
      60_000,
    ],
    [
      Object.assign(new Error('403 Forbidden'), { statusCode: 403, code: 'HTTP_ERROR_403' }),
      'rate-limited',
      3_600_000,
    ],
    [
      Object.assign(new Error('429 Too Many Requests'), {
        statusCode: 429,
        code: 'HTTP_ERROR_429',
      }),
      'rate-limited',
      3_600_000,
    ],
    [
      Object.assign(new Error('HTTP failure'), { code: 'HTTP_ERROR_429' }),
      'rate-limited',
      3_600_000,
    ],
    [
      Object.assign(new Error('No published versions on GitHub'), {
        code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
      }),
      'unavailable',
      60_000,
    ],
    [
      Object.assign(new Error('Cannot find latest.yml'), {
        code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
      }),
      'unavailable',
      60_000,
    ],
    [
      Object.assign(
        new Error('Unable to find latest version: HttpError: 429 Too Many Requests\nHeaders: {}'),
        { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' },
      ),
      'rate-limited',
      3_600_000,
    ],
    [
      Object.assign(
        new Error('Cannot parse releases feed: HttpError: 403 Forbidden\nHeaders: {}'),
        { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' },
      ),
      'rate-limited',
      3_600_000,
    ],
    [
      Object.assign(
        new Error(
          'Unable to find latest version: Error: connection reset\n    at request (/app/provider.js:429:403)',
        ),
        { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' },
      ),
      'unavailable',
      60_000,
    ],
    [
      Object.assign(
        new Error(
          'Cannot parse releases feed: Error: bad XML\n    at parse (/app/provider.js:404:429)',
        ),
        { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' },
      ),
      'error',
      60_000,
    ],
    [
      new Error('Cannot download "https://example.invalid/update.exe", status 403: Forbidden'),
      'rate-limited',
      3_600_000,
    ],
    [
      new Error(
        'Cannot download "https://example.invalid/429/update.exe", status 500: Internal Server Error',
      ),
      'error',
      60_000,
    ],
    [new Error('connection reset\n    at request (/app/provider.js:429:403)'), 'error', 60_000],
    [new Error('offline'), 'error', 60_000],
    ['429', 'error', 60_000],
  ])('%s の失敗で録画を停止せず再確認を待つ', async (error, result, delay) => {
    updater.checkForUpdates.mockRejectedValue(error);
    const now = Date.now();
    await expect(checker.check()).resolves.toMatchObject({ result, nextCheckAt: now + delay });
    expect(prepare).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    await checker.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test('録画が開始した場合は main 側で再確認し、完了後の操作で一度だけ適用する', async () => {
    updater.emit('update-downloaded', { version: '0.5.0' });
    expect(checker.getStatus().installBlocked).toBe(false);
    busy = true;
    expect(checker.install()).toBe('busy');
    expect(checker.getStatus().installBlocked).toBe(true);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    busy = false;
    expect(checker.install()).toBe('started');
    expect(checker.install()).toBe('started');
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
  });

  test('録画受付を止めて保存を完了するまで、インストーラーを起動しない', async () => {
    let saved!: () => void;
    flushLog.mockImplementation(
      () =>
        new Promise((resolve) => {
          saved = resolve;
        }),
    );
    updater.emit('update-downloaded', { version: '0.5.0' });
    expect(checker.install()).toBe('started');
    expect(prepare).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(flushHistory).toHaveBeenCalledOnce();
    expect(flushLog).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(checker.install()).toBe('started');
    expect(flush).toHaveBeenCalledOnce();
    saved();
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
  });

  test('履歴の保存失敗は適用せず、旧版の再起動へ進む', async () => {
    flushHistory.mockImplementation(() => {
      throw new Error('history save failed');
    });
    updater.emit('update-downloaded', { version: '0.5.0' });
    checker.install();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledOnce();
    expect(flushLog).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(['throw', 'reject'])('ログ保存失敗 (%s) は警告して更新を続行する', async (mode) => {
    const error = new Error('log save failed');
    flushLog.mockImplementation(() => {
      if (mode === 'throw') throw error;
      return Promise.reject(error);
    });
    updater.emit('update-downloaded', { version: '0.5.0' });
    expect(checker.install()).toBe('started');
    expect(checker.install()).toBe('started');
    await vi.advanceTimersByTimeAsync(0);
    expect(flushHistory).toHaveBeenCalledOnce();
    expect(flushLog).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '更新前のログを保存できませんでした。更新は続行します',
      error,
    );
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
    expect(recover).not.toHaveBeenCalled();
  });

  test.each(['stop', 'timeout', 'error'])(
    '保存待ちに %s へ移ったら、遅れて適用しない',
    async (mode) => {
      let saved!: () => void;
      flush.mockImplementation(
        () =>
          new Promise((resolve) => {
            saved = resolve;
          }),
      );
      updater.emit('update-downloaded', { version: '0.5.0' });
      checker.install();
      if (mode === 'stop') checker.stop();
      else if (mode === 'error') updater.emit('error', new Error('failed'));
      else await vi.advanceTimersByTimeAsync(120_000);
      saved();
      await vi.advanceTimersByTimeAsync(0);
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
      expect(recover).toHaveBeenCalledTimes(mode === 'stop' ? 0 : 1);
    },
  );

  test.each(['throw', 'event', 'timeout'])(
    '適用失敗 (%s) は録画受付を再開せず通常再起動へ進む',
    async (mode) => {
      updater.emit('update-downloaded', { version: '0.5.0' });
      updater.quitAndInstall.mockImplementation(() => {
        if (mode === 'throw') throw new Error('install failed');
        if (mode === 'event') updater.emit('error', new Error('signature failed'));
      });
      checker.install();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledTimes(1);
    },
  );

  test('終了中に完了した確認は自動DLを中断し、以後のイベントを配信しない', async () => {
    let resolve!: (value: UpdateCheckResult) => void;
    updater.checkForUpdates.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const changed = vi.fn();
    checker.on('change', changed);
    const pending = checker.check();
    checker.stop();
    const cancel = vi.fn();
    resolve({
      ...release(true, Promise.reject(new Error('aborted'))),
      cancellationToken: { cancel } as unknown as CancellationToken,
    });
    await pending;
    updater.emit('update-downloaded', { version: '0.5.0' });
    updater.emit('download-progress', { percent: 99 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(checker.install()).toBe('not-ready');
  });

  test('開発時は手動操作でも通信・適用しない', async () => {
    checker.stop();
    checker = new UpdateChecker(undefined, silentLogger, {
      hasRecordings: () => false,
      prepare,
      flush,
      recover,
    });
    checker.start();
    expect((await checker.check()).result).toBe('disabled');
    expect(checker.install()).toBe('not-ready');
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});
