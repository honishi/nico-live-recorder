import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppSettings,
  type AppStatus,
  type FollowCheckResult,
  type HistoryPage,
  type HistoryQuery,
  type RecordingInfo,
  type TargetAddResult,
  type TargetUser,
  type UiState,
} from '../shared/types';

const api = {
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.getStatus),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.updateSettings, patch),
  updateUi: (patch: Partial<UiState>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.updateUi, patch),
  chooseOutputDir: (): Promise<AppSettings | undefined> => ipcRenderer.invoke(IPC.chooseOutputDir),
  openOutputDir: (): Promise<void> => ipcRenderer.invoke(IPC.openOutputDir),
  openPath: (target: string): Promise<void> => ipcRenderer.invoke(IPC.openPath, target),
  openLogFile: (): Promise<void> => ipcRenderer.invoke(IPC.openLogFile),
  reconnectPush: (): Promise<void> => ipcRenderer.invoke(IPC.reconnectPush),
  addTarget: (input: string): Promise<TargetAddResult> => ipcRenderer.invoke(IPC.addTarget, input),
  restoreTarget: (target: TargetUser): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.restoreTarget, target),
  removeTarget: (userId: string): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.removeTarget, userId),
  setTargetEnabled: (userId: string, enabled: boolean): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.setTargetEnabled, userId, enabled),
  checkFollow: (userId: string): Promise<FollowCheckResult> =>
    ipcRenderer.invoke(IPC.checkFollow, userId),
  login: (): Promise<boolean> => ipcRenderer.invoke(IPC.login),
  logout: (): Promise<void> => ipcRenderer.invoke(IPC.logout),
  startRecording: (input: string): Promise<RecordingInfo> =>
    ipcRenderer.invoke(IPC.startRecording, input),
  stopRecording: (programId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.stopRecording, programId),
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
  onStatusChanged: (listener: (status: AppStatus) => void): (() => void) => {
    const handler = (_event: unknown, status: AppStatus): void => listener(status);
    ipcRenderer.on(IPC.statusChanged, handler);
    return () => ipcRenderer.off(IPC.statusChanged, handler);
  },
};

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
