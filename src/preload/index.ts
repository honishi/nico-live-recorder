import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppSettings,
  type AppStatus,
  type LogEntry,
  type FollowStatus,
  type HistoryPage,
  type HistoryQuery,
  type RecordingInfo,
  type RecordingPreview,
  type TargetAddResult,
  type TargetRemovalResult,
  type TargetUser,
  type UiState,
  type UpdateStatus,
  type UpdateInstallResult,
} from '../shared/types';

const api = {
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.getStatus),
  getLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke(IPC.getLogs),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.checkForUpdates),
  installUpdate: (): Promise<UpdateInstallResult> => ipcRenderer.invoke(IPC.installUpdate),
  openReleasePage: (): Promise<void> => ipcRenderer.invoke(IPC.openReleasePage),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.updateSettings, patch),
  updateUi: (patch: Partial<UiState>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.updateUi, patch),
  chooseOutputDir: (): Promise<AppSettings | undefined> => ipcRenderer.invoke(IPC.chooseOutputDir),
  openOutputDir: (): Promise<void> => ipcRenderer.invoke(IPC.openOutputDir),
  openPath: (target: string): Promise<void> => ipcRenderer.invoke(IPC.openPath, target),
  openLogFile: (): Promise<void> => ipcRenderer.invoke(IPC.openLogFile),
  openFfmpegLicenses: (): Promise<void> => ipcRenderer.invoke(IPC.openFfmpegLicenses),
  reconnectPush: (): Promise<void> => ipcRenderer.invoke(IPC.reconnectPush),
  addTarget: (input: string): Promise<TargetAddResult> => ipcRenderer.invoke(IPC.addTarget, input),
  restoreTargets: (targets: TargetUser[], previousOrder: string[] = []): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.restoreTargets, targets, previousOrder),
  moveTarget: (userId: string, beforeUserId: string | null): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.moveTarget, userId, beforeUserId),
  removeTargets: (userIds: string[], confirm = true): Promise<TargetRemovalResult | undefined> =>
    ipcRenderer.invoke(IPC.removeTargets, userIds, confirm),
  setTargetsEnabled: (userIds: string[], enabled: boolean): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.setTargetsEnabled, userIds, enabled),
  checkFollow: (userId: string, manual = false): Promise<FollowStatus> =>
    ipcRenderer.invoke(IPC.checkFollow, userId, manual),
  login: (): Promise<boolean> => ipcRenderer.invoke(IPC.login),
  logout: (): Promise<void> => ipcRenderer.invoke(IPC.logout),
  startRecording: (input: string): Promise<RecordingInfo> =>
    ipcRenderer.invoke(IPC.startRecording, input),
  stopRecording: (programId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.stopRecording, programId),
  getRecordingPreview: (
    programId: string,
    visible: boolean,
    after?: number,
  ): Promise<RecordingPreview | undefined> =>
    ipcRenderer.invoke(IPC.getRecordingPreview, programId, visible, after),
  listHistory: (query: HistoryQuery): Promise<HistoryPage> =>
    ipcRenderer.invoke(IPC.listHistory, query),
  removeHistory: (programId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.removeHistory, programId),
  historyContextMenu: (
    programId: string,
    videoPath?: string,
    commentsPath?: string,
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.historyContextMenu, programId, videoPath, commentsPath),
  onLogsChanged: (listener: (logs: LogEntry[]) => void): (() => void) => {
    const handler = (_event: unknown, logs: LogEntry[]): void => listener(logs);
    ipcRenderer.on(IPC.logsChanged, handler);
    return () => ipcRenderer.off(IPC.logsChanged, handler);
  },
  onSettingsChanged: (listener: () => void): (() => void) => {
    ipcRenderer.on(IPC.settingsChanged, listener);
    return () => ipcRenderer.off(IPC.settingsChanged, listener);
  },
  onStatusChanged: (listener: (status: AppStatus) => void): (() => void) => {
    const handler = (_event: unknown, status: AppStatus): void => listener(status);
    ipcRenderer.on(IPC.statusChanged, handler);
    return () => ipcRenderer.off(IPC.statusChanged, handler);
  },
};

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
