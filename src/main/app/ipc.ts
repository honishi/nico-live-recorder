import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import {
  codedError,
  ERROR_CODES,
  IPC,
  type AppSettings,
  type AppStatus,
  type FollowStatus,
  type HistoryQuery,
  type TargetAddResult,
  type TargetRemovalResult,
  type TargetUser,
  type UiState,
} from '../../shared/types';
import type { AppLogger } from './app-logger';
import type { NicoAuth } from './auth';
import { FollowStatusCache } from './follow-status';
import { checkFollowing, parseUserIdInput, resolveUserNickname } from './nico-user';
import type { RecordingManager } from './recording-manager';
import type { SettingsStore } from './settings-store';
import type { UpdateChecker } from './update-checker';
import { MIN_FREE_SPACE_GB, POLL_INTERVAL_SEC, type NumberRange } from '../../shared/limits';

export interface IpcContext {
  version: string;
  updates: UpdateChecker;
  settings: SettingsStore;
  auth: NicoAuth;
  manager: RecordingManager;
  logger: AppLogger;
  getMainWindow: () => BrowserWindow | undefined;
}

const LOG_ENTRIES_FOR_UI = 1000;

export async function buildStatus(ctx: IpcContext): Promise<AppStatus> {
  const loggedIn = await ctx.auth.isLoggedIn();
  return {
    version: ctx.version,
    update: ctx.updates.getStatus(),
    auth: { loggedIn, revision: ctx.auth.revision },
    push: ctx.manager.getPushStatus(),
    detectorRunning: ctx.manager.detectorRunning,
    recordings: await ctx.manager.getRecordings(),
    historyVersion: ctx.manager.historyVersion,
    // debug は「debug を表示」のときだけ渡す (量が多いので、毎回の status に載せない)
    logs: ctx.logger.recent(LOG_ENTRIES_FOR_UI, ctx.settings.get().ui.showDebug),
    alerts: await ctx.manager.getAlerts(loggedIn),
    logFilePath: ctx.logger.logFilePath,
    diskFreeBytes: ctx.manager.diskFreeBytes,
  };
}

function pickSettingsPatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  const allowed: Partial<AppSettings> = {};
  if (typeof patch.outputDir === 'string' && patch.outputDir.trim()) {
    allowed.outputDir = patch.outputDir.trim();
  }
  if (typeof patch.pollIntervalSec === 'number' && Number.isFinite(patch.pollIntervalSec)) {
    allowed.pollIntervalSec = clampInt(patch.pollIntervalSec, POLL_INTERVAL_SEC);
  }
  if (typeof patch.minFreeSpaceGb === 'number' && Number.isFinite(patch.minFreeSpaceGb)) {
    allowed.minFreeSpaceGb = clampInt(patch.minFreeSpaceGb, MIN_FREE_SPACE_GB);
  }
  for (const key of ['recordOngoingOnStart', 'pushEnabled', 'notificationsEnabled'] as const) {
    if (typeof patch[key] === 'boolean') {
      allowed[key] = patch[key];
    }
  }
  return allowed;
}

function pickUiPatch(patch: Partial<UiState>): Partial<UiState> {
  const allowed: Partial<UiState> = {};
  const tabs: UiState['tab'][] = ['recordings', 'targets', 'history', 'log', 'settings'];
  if (patch.tab && tabs.includes(patch.tab)) {
    allowed.tab = patch.tab;
  }
  for (const key of ['showDebug', 'autoScroll'] as const) {
    if (typeof patch[key] === 'boolean') {
      allowed[key] = patch[key];
    }
  }
  if (typeof patch.logSeenAt === 'string' && !Number.isNaN(Date.parse(patch.logSeenAt))) {
    allowed.logSeenAt = patch.logSeenAt;
  }
  return allowed;
}

export function registerIpcHandlers(ctx: IpcContext): void {
  // フォロー状態は数分キャッシュし、ログイン状態が変わったら捨てる
  const followStatus = new FollowStatusCache({
    check: (userId, cookie) => checkFollowing(userId, cookie, ctx.logger),
    logger: ctx.logger,
  });
  ctx.auth.on('change', () => followStatus.clear());

  // Cookie を待っている間の再ログインも検出し、旧アカウントの問い合わせを始めない
  async function getFollow(userId: string, manual = false): Promise<FollowStatus> {
    const revision = ctx.auth.revision;
    const cookie = await ctx.auth.getCookieHeader();
    if (revision !== ctx.auth.revision) {
      return { state: 'waiting', stale: false, retryAt: Date.now() + 1000 };
    }
    return cookie ? followStatus.get(userId, cookie, manual) : unavailableFollow();
  }

  ipcMain.handle(IPC.getStatus, () => buildStatus(ctx));
  ipcMain.handle(IPC.checkForUpdates, () => ctx.updates.check());
  ipcMain.handle(IPC.openReleasePage, async () => {
    const release = ctx.updates.getStatus().release;
    if (release) {
      await shell.openExternal(release.url);
    }
  });
  ipcMain.handle(IPC.getSettings, () => ctx.settings.get());
  ipcMain.handle(IPC.updateSettings, (_event, patch: Partial<AppSettings>) =>
    ctx.settings.update(pickSettingsPatch(patch ?? {})),
  );
  ipcMain.handle(IPC.updateUi, (_event, patch: Partial<UiState>) =>
    ctx.settings.updateUi(pickUiPatch(patch ?? {})),
  );

  ipcMain.handle(IPC.chooseOutputDir, async () => {
    const window = ctx.getMainWindow();
    const result = await dialog.showOpenDialog(window ?? new BrowserWindow({ show: false }), {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: ctx.settings.get().outputDir,
    });
    if (result.canceled || result.filePaths.length === 0) {
      return undefined;
    }
    return ctx.settings.update({ outputDir: result.filePaths[0] });
  });
  ipcMain.handle(IPC.openOutputDir, async () => {
    await shell.openPath(ctx.settings.get().outputDir);
  });
  ipcMain.handle(IPC.openPath, (_event, target: string) => {
    if (typeof target === 'string' && target.length > 0) {
      shell.showItemInFolder(target);
    }
  });
  ipcMain.handle(IPC.openLogFile, () => {
    shell.showItemInFolder(ctx.logger.logFilePath);
  });
  // 利用者指定の FFmpeg ではなく、アプリと一緒に配布した資料を開く。
  ipcMain.handle(IPC.openFfmpegLicenses, () => {
    const directory = app.isPackaged
      ? path.join(process.resourcesPath, 'ffmpeg')
      : path.join(app.getAppPath(), 'resources', 'ffmpeg', `${process.platform}-${process.arch}`);
    shell.showItemInFolder(path.join(directory, 'NOTICE.txt'));
  });
  ipcMain.handle(IPC.reconnectPush, () => ctx.manager.restartDetection());

  ipcMain.handle(IPC.addTarget, async (_event, input: string): Promise<TargetAddResult> => {
    const userId = parseUserIdInput(String(input ?? ''));
    if (!userId) {
      throw codedError(ERROR_CODES.invalidInput);
    }
    const existing = ctx.settings.get().targets.find((t) => t.userId === userId);
    if (existing) {
      return {
        target: existing,
        follow: await getFollow(userId),
        alreadyExists: true,
      };
    }
    const name = await resolveUserNickname(userId);
    const target: TargetUser = {
      userId,
      name,
      enabled: true,
      addedAt: new Date().toISOString(),
    };
    ctx.settings.upsertTarget(target);
    const follow = await getFollow(userId);
    ctx.logger.info(`target added: ${name} (${userId}) follow=${follow.result ?? 'unchecked'}`);
    return { target, follow, alreadyExists: false };
  });
  // 取り消しの入力は全件検証してから保存し、不正な項目だけを部分的に復元しない
  ipcMain.handle(IPC.restoreTargets, (_event, targets: unknown, previousOrder: unknown = []) => {
    if (
      !Array.isArray(targets) ||
      !Array.isArray(previousOrder) ||
      !previousOrder.every(isStoredTargetId)
    ) {
      throw codedError(ERROR_CODES.invalidInput);
    }
    const restored = targets.map(normalizeRestoredTarget);
    if (!restored.every((target) => target !== undefined)) {
      throw codedError(ERROR_CODES.invalidInput);
    }
    return ctx.settings.restoreTargets(restored, previousOrder);
  });
  ipcMain.handle(IPC.moveTarget, (_event, userId: unknown, beforeUserId: unknown) => {
    if (!isStoredTargetId(userId) || (beforeUserId !== null && !isStoredTargetId(beforeUserId))) {
      throw codedError(ERROR_CODES.invalidInput);
    }
    return ctx.settings.moveTarget(userId, beforeUserId);
  });

  // 確認中は重複要求を拒否する。単体削除も同じ保存処理を確認なしで利用する
  let removingTargets = false;
  ipcMain.handle(
    IPC.removeTargets,
    async (
      _event,
      userIds: unknown,
      confirm: unknown = true,
    ): Promise<TargetRemovalResult | undefined> => {
      if (
        !Array.isArray(userIds) ||
        !userIds.every(isStoredTargetId) ||
        typeof confirm !== 'boolean'
      ) {
        throw codedError(ERROR_CODES.invalidInput);
      }
      if (removingTargets) {
        throw new Error('録画対象の削除処理中です');
      }
      removingTargets = true;
      try {
        const ids = new Set(userIds);
        const targets = ctx.settings.get().targets.filter((target) => ids.has(target.userId));
        if (confirm && targets.length > 0) {
          const options: Electron.MessageBoxOptions = {
            type: 'question',
            title: '録画対象から削除',
            message: `${targets.length} 件の配信者を録画対象から削除しますか？`,
            detail:
              '今後の自動録画対象から外します。進行中の録画は継続し、録画ファイルと履歴は残ります。',
            buttons: ['キャンセル', '削除'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          };
          const window = ctx.getMainWindow();
          const result = await (window
            ? dialog.showMessageBox(window, options)
            : dialog.showMessageBox(options));
          if (result.response !== 1) {
            return undefined;
          }
        }
        // 確認後に最新の設定から削除し、確認対象以外の追加・変更を保つ
        const previousOrder = ctx.settings.get().targets.map((target) => target.userId);
        const removed = ctx.settings.removeTargets(targets.map((target) => target.userId));
        return { settings: ctx.settings.get(), removed, previousOrder };
      } finally {
        removingTargets = false;
      }
    },
  );
  // 全件を検証してから一度だけ保存し、検知の再起動を対象の数だけ繰り返さない
  ipcMain.handle(IPC.setTargetsEnabled, (_event, userIds: unknown, enabled: unknown) => {
    if (
      !Array.isArray(userIds) ||
      !userIds.every(isStoredTargetId) ||
      typeof enabled !== 'boolean' ||
      (enabled && !userIds.every(isUserId))
    ) {
      throw codedError(ERROR_CODES.invalidInput);
    }
    return ctx.settings.setTargetsEnabled(userIds, enabled);
  });
  ipcMain.handle(
    IPC.checkFollow,
    async (_event, userId: string, manual?: boolean): Promise<FollowStatus> => {
      return getFollow(String(userId), manual === true);
    },
  );

  ipcMain.handle(IPC.login, () => ctx.auth.login(ctx.getMainWindow()));
  // 確認中・解除中の重複要求をまとめ、キャンセルなら購読や Cookie に触れない
  let pendingLogout: Promise<void> | undefined;
  ipcMain.handle(IPC.logout, () => {
    pendingLogout ??= (async () => {
      const recordingCount = ctx.manager.getActiveRecordingCount();
      const options: Electron.MessageBoxOptions = {
        type: 'question',
        title: 'ログアウト',
        message: 'ニコニコからログアウトしますか？',
        detail:
          recordingCount > 0
            ? `録画中・開始処理中の ${recordingCount} 件を終了し、放送開始の監視を停止します。録画済みのファイルは保存されます。`
            : '放送開始の監視を停止します。確認中に録画が始まった場合も終了します。録画済みのファイルは保存されます。',
        buttons: ['キャンセル', 'ログアウト'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const window = ctx.getMainWindow();
      const result = await (window
        ? dialog.showMessageBox(window, options)
        : dialog.showMessageBox(options));
      if (result.response === 1) {
        await ctx.manager.logout();
      }
    })().finally(() => {
      pendingLogout = undefined;
    });
    return pendingLogout;
  });

  ipcMain.handle(IPC.startRecording, async (_event, input: string) => {
    const match = String(input ?? '').match(/(lv\d+)/);
    if (!match) {
      throw codedError(ERROR_CODES.invalidProgram);
    }
    return ctx.manager.startRecording(match[1], 'manual');
  });
  ipcMain.handle(IPC.stopRecording, (_event, programId: string) =>
    ctx.manager.stopRecording(String(programId)),
  );

  ipcMain.handle(IPC.listHistory, (_event, query: HistoryQuery) =>
    ctx.manager.getHistoryPage({
      query: typeof query?.query === 'string' ? query.query : undefined,
      provider: typeof query?.provider === 'string' ? query.provider : undefined,
      state:
        query?.state === 'done' || query?.state === 'failed' || query?.state === 'cancelled'
          ? query.state
          : undefined,
      offset: typeof query?.offset === 'number' ? query.offset : 0,
      limit: typeof query?.limit === 'number' ? Math.min(200, query.limit) : undefined,
    }),
  );
  ipcMain.handle(IPC.removeHistory, (_event, programId: string) =>
    ctx.manager.removeHistory(String(programId)),
  );
  // 履歴行の右クリックメニュー。ファイル操作は main 側で行う
  ipcMain.handle(
    IPC.historyContextMenu,
    async (event, programId: string, videoPath?: string, commentsPath?: string) => {
      const commentFiles = await ctx.manager.getCommentPaths(programId);
      return new Promise<void>((resolve) => {
        const menu = Menu.buildFromTemplate([
          {
            label: 'フォルダで表示',
            enabled: typeof videoPath === 'string' && videoPath.length > 0,
            click: () => shell.showItemInFolder(videoPath ?? ''),
          },
          {
            label: 'コメントを開く',
            enabled: typeof commentsPath === 'string' && commentsPath.length > 0,
            click: () => void shell.openPath(commentsPath ?? ''),
          },
          ...commentFiles
            .filter((file) => file !== commentsPath)
            .map((file, index) => ({
              label: `以前のコメントを開く (${index + 1})`,
              click: () => void shell.openPath(file),
            })),
          { type: 'separator' },
          { label: '履歴から削除', click: () => void ctx.manager.removeHistory(String(programId)) },
        ]);
        const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        menu.popup({ window, callback: () => resolve() });
      });
    },
  );
}

function clampInt(value: number, range: NumberRange): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** IPC で受け付ける配信者 ID は数字の文字列だけにする */
function isUserId(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

/** ローカルの既存項目は ID が不正でも削除・無効化・移動できるようにする */
function isStoredTargetId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 復元する属性を限定し、不正な日時は補正、不正な ID は無効状態で戻す */
function normalizeRestoredTarget(value: unknown): TargetUser | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const target = value as Partial<TargetUser>;
  if (
    !isStoredTargetId(target.userId) ||
    typeof target.name !== 'string' ||
    typeof target.enabled !== 'boolean'
  ) {
    return undefined;
  }
  return {
    userId: target.userId,
    name: target.name,
    enabled: isUserId(target.userId) && target.enabled,
    addedAt:
      typeof target.addedAt === 'string' && Number.isFinite(Date.parse(target.addedAt))
        ? target.addedAt
        : new Date().toISOString(),
  };
}

/** 未ログインでは通信も自動再試行も行わない */
function unavailableFollow(): FollowStatus {
  return { result: 'unknown', stale: false, state: 'stopped', retryAt: 0 };
}
