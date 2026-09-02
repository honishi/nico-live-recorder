import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import {
  IPC,
  type AppSettings,
  type AppStatus,
  type FollowCheckResult,
  type TargetAddResult,
  type TargetUser,
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

export async function buildStatus(ctx: IpcContext): Promise<AppStatus> {
  return {
    version: ctx.version,
    auth: { loggedIn: await ctx.auth.isLoggedIn() },
    push: ctx.manager.getPushStatus(),
    detectorRunning: ctx.manager.detectorRunning,
    recordings: ctx.manager.getRecordings(),
    logs: ctx.logger.recent().slice(-200),
  };
}

export function registerIpcHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC.getStatus, () => buildStatus(ctx));
  ipcMain.handle(IPC.getSettings, () => ctx.settings.get());
  ipcMain.handle(IPC.updateSettings, (_event, patch: Partial<AppSettings>) => {
    const allowed: Partial<AppSettings> = {};
    if (typeof patch.outputDir === 'string' && patch.outputDir.trim()) {
      allowed.outputDir = patch.outputDir.trim();
    }
    if (typeof patch.pollIntervalSec === 'number' && Number.isFinite(patch.pollIntervalSec)) {
      allowed.pollIntervalSec = Math.min(600, Math.max(10, Math.round(patch.pollIntervalSec)));
    }
    for (const key of ['recordOngoingOnStart', 'pushEnabled', 'notificationsEnabled'] as const) {
      if (typeof patch[key] === 'boolean') {
        allowed[key] = patch[key];
      }
    }
    return ctx.settings.update(allowed);
  });

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
  ipcMain.handle(IPC.openPath, async (_event, target: string) => {
    if (typeof target === 'string' && target.length > 0) {
      shell.showItemInFolder(target);
    }
  });

  ipcMain.handle(IPC.addTarget, async (_event, input: string): Promise<TargetAddResult> => {
    const userId = parseUserIdInput(String(input ?? ''));
    if (!userId) {
      throw new Error('ユーザー ID (数字) またはユーザーページの URL を入力してください');
    }
    const name = await resolveUserNickname(userId);
    const target: TargetUser = {
      userId,
      name,
      enabled: true,
      addedAt: new Date().toISOString(),
    };
    ctx.settings.upsertTarget(target);
    const cookie = await ctx.auth.getCookieHeader();
    const follow: FollowCheckResult = cookie ? await checkFollowing(userId, cookie) : 'unknown';
    ctx.logger.info(`target added: ${name} (${userId}) follow=${follow}`);
    return { target, follow };
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

  ipcMain.handle(IPC.login, async () => ctx.auth.login(ctx.getMainWindow()));
  ipcMain.handle(IPC.logout, async () => ctx.auth.logout());

  ipcMain.handle(IPC.startRecording, async (_event, input: string) => {
    const match = String(input ?? '').match(/(lv\d+)/);
    if (!match) {
      throw new Error('番組 ID (lv...) または視聴ページの URL を入力してください');
    }
    return ctx.manager.startRecording(match[1], 'manual');
  });
  ipcMain.handle(IPC.stopRecording, (_event, programId: string) =>
    ctx.manager.stopRecording(String(programId)),
  );
}
