/** main / preload / renderer で共有する型と IPC チャネル名 */

export interface TargetUser {
  /** ニコニコのユーザー ID (数字) */
  userId: string;
  name: string;
  enabled: boolean;
  addedAt: string;
}

export interface AppSettings {
  outputDir: string;
  targets: TargetUser[];
  pollIntervalSec: number;
  /** 起動時に既に放送中だった対象を録画するか */
  recordOngoingOnStart: boolean;
  pushEnabled: boolean;
  notificationsEnabled: boolean;
}

export type RecordingState = 'starting' | 'recording' | 'finishing' | 'done' | 'failed';

export type RecordingSource = 'push' | 'poll' | 'manual';

export interface RecordingInfo {
  programId: string;
  title: string;
  providerId?: string;
  providerName?: string;
  source: RecordingSource;
  state: RecordingState;
  startedAt: string;
  endedAt?: string;
  commentCount: number;
  videoBytes: number;
  outputDir: string;
  videoPath?: string;
  error?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
}

export interface AuthStatus {
  loggedIn: boolean;
}

export interface PushStatusInfo {
  state: string;
  niconicoRegistered: boolean;
  lastReceivedAt?: string;
  lastError?: string;
}

export interface AppStatus {
  version: string;
  auth: AuthStatus;
  push: PushStatusInfo;
  detectorRunning: boolean;
  recordings: RecordingInfo[];
  logs: LogEntry[];
}

export type FollowCheckResult = 'following' | 'not-following' | 'unknown';

export interface TargetAddResult {
  target: TargetUser;
  follow: FollowCheckResult;
}

export const IPC = {
  getStatus: 'app:getStatus',
  getSettings: 'app:getSettings',
  updateSettings: 'app:updateSettings',
  chooseOutputDir: 'app:chooseOutputDir',
  openOutputDir: 'app:openOutputDir',
  openPath: 'app:openPath',
  addTarget: 'targets:add',
  removeTarget: 'targets:remove',
  setTargetEnabled: 'targets:setEnabled',
  checkFollow: 'targets:checkFollow',
  login: 'auth:login',
  logout: 'auth:logout',
  startRecording: 'recording:start',
  stopRecording: 'recording:stop',
  statusChanged: 'app:statusChanged',
} as const;
