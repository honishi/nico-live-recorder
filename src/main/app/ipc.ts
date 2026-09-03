import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import {
  codedError,
  ERROR_CODES,
  IPC,
  type AppSettings,
  type AppStatus,
  type FollowCheckResult,
  type TargetAddResult,
  type TargetUser,
  type UiState,
} from '../../shared/types';
import type { AppLogger } from './app-logger';
import type { NicoAuth } from './auth';
import { checkFollowing, parseUserIdInput, resolveUserNickname } from './nico-user';
import type { RecordingManager } from './recording-manager';
import type { SettingsStore } from './settings-store';

export interface IpcContext {
  version: string;
  settings: SettingsStore;
  auth: NicoAuth;
  manager: RecordingManager;
  logger: AppLogger;
  getMainWindow: () => BrowserWindow | undefined;
}

const LOG_ENTRIES_FOR_UI = 1000;

export async function buildStatus(ctx: IpcContext): Promise<AppStatus> {
  const loggedIn = await ctx.auth.isLoggedIn();
  await ctx.manager.refreshVideoExistence();
  return {
    version: ctx.version,
    auth: { loggedIn },
    push: ctx.manager.getPushStatus(),
    detectorRunning: ctx.manager.detectorRunning,
    recordings: ctx.manager.getRecordings(),
    logs: ctx.logger.recent(LOG_ENTRIES_FOR_UI),
    alerts: await ctx.manager.getAlerts(loggedIn),
    logFilePath: ctx.logger.logFilePath,
  };
}

function pickSettingsPatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  const allowed: Partial<AppSettings> = {};
  if (typeof patch.outputDir === 'string' && patch.outputDir.trim()) {
    allowed.outputDir = patch.outputDir.trim();
  }
  if (typeof patch.pollIntervalSec === 'number' && Number.isFinite(patch.pollIntervalSec)) {
    allowed.pollIntervalSec = Math.min(300, Math.max(15, Math.round(patch.pollIntervalSec)));
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
  ipcMain.handle(IPC.getStatus, () => buildStatus(ctx));
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
  ipcMain.handle(IPC.reconnectPush, () => ctx.manager.restartDetection());

  ipcMain.handle(IPC.addTarget, async (_event, input: string): Promise<TargetAddResult> => {
    const userId = parseUserIdInput(String(input ?? ''));
    if (!userId) {
      throw codedError(ERROR_CODES.invalidInput);
    }
    const cookie = await ctx.auth.getCookieHeader();
    const existing = ctx.settings.get().targets.find((t) => t.userId === userId);
    if (existing) {
      return {
        target: existing,
        follow: cookie ? await checkFollowing(userId, cookie) : 'unknown',
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
    const follow: FollowCheckResult = cookie ? await checkFollowing(userId, cookie) : 'unknown';
    ctx.logger.info(`target added: ${name} (${userId}) follow=${follow}`);
    return { target, follow, alreadyExists: false };
  });
  ipcMain.handle(IPC.restoreTarget, (_event, target: TargetUser) => {
    if (!target || typeof target.userId !== 'string' || typeof target.name !== 'string') {
      throw codedError(ERROR_CODES.invalidInput);
    }
    return ctx.settings.upsertTarget({
      userId: target.userId,
      name: target.name,
      enabled: target.enabled !== false,
      addedAt: typeof target.addedAt === 'string' ? target.addedAt : new Date().toISOString(),
    });
  });
  ipcMain.handle(IPC.removeTarget, (_event, userId: string) =>
    ctx.settings.removeTarget(String(userId)),
  );
  ipcMain.handle(IPC.setTargetEnabled, (_event, userId: string, enabled: boolean) =>
    ctx.settings.setTargetEnabled(String(userId), Boolean(enabled)),
  );
  ipcMain.handle(IPC.checkFollow, async (_event, userId: string): Promise<FollowCheckResult> => {
    const cookie = await ctx.auth.getCookieHeader();
    return cookie ? checkFollowing(String(userId), cookie) : 'unknown';
  });

  ipcMain.handle(IPC.login, () => ctx.auth.login(ctx.getMainWindow()));
  ipcMain.handle(IPC.logout, () => ctx.auth.logout());

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
}
