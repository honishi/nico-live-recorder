import type { AppStatus, LogEntry } from '../../shared/types';
import type { IpcContext } from './ipc';

const LOG_ENTRIES_FOR_UI = 1000;

export async function buildStatus(ctx: IpcContext): Promise<AppStatus> {
  const loggedIn = await ctx.auth.isLoggedIn();
  return {
    version: ctx.version,
    update: ctx.updates.getStatus(),
    auth: { loggedIn, revision: ctx.auth.revision },
    push: ctx.manager.getPushStatus(),
    detectorRunning: ctx.manager.detectorRunning,
    // 配信待ちの間に録画中のオブジェクトが変更されても、この結果には混ぜない。
    recordings: structuredClone(await ctx.manager.getRecordings()),
    historyVersion: ctx.manager.historyVersion,
    alerts: await ctx.manager.getAlerts(loggedIn),
    logFilePath: ctx.logger.logFilePath,
    diskFreeBytes: ctx.manager.diskFreeBytes,
  };
}

/** 表示対象のログだけを取り出す。状態取得やファイル確認は行わない。 */
export function buildLogs(ctx: IpcContext): LogEntry[] {
  return ctx.logger.recent(LOG_ENTRIES_FOR_UI, ctx.settings.get().ui.showDebug);
}
