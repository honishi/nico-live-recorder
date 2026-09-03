/** main / preload / renderer で共有する型と IPC チャネル名 */

export interface TargetUser {
  /** ニコニコのユーザー ID (数字) */
  userId: string;
  name: string;
  enabled: boolean;
  addedAt: string;
}

export type TabId = 'recordings' | 'targets' | 'history' | 'log' | 'settings';

/** ウィンドウを閉じても保持する UI の状態 */
export interface UiState {
  tab: TabId;
  showDebug: boolean;
  autoScroll: boolean;
  /** 最後にログタブを開いた時刻 (ISO)。未読 WARN / ERROR の起点 */
  logSeenAt?: string;
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface AppSettings {
  outputDir: string;
  targets: TargetUser[];
  pollIntervalSec: number;
  /** 起動時に既に放送中だった対象を録画するか */
  recordOngoingOnStart: boolean;
  pushEnabled: boolean;
  notificationsEnabled: boolean;
  ui: UiState;
  window?: WindowBounds;
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
  commentsPath?: string;
  /** 録画ファイルが保存先に残っているか (終了後に確認する) */
  videoExists?: boolean;
  error?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** ログの出所。表示上の色分けに使う (rec は録画の開始・終了) */
export type LogCategory = 'app' | 'push' | 'rec' | 'poll' | 'comments';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  category: LogCategory;
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

export type AlertKind = 'output-dir' | 'auth-expired' | 'push-unavailable';

/** ヘッダ直下のバナーに出す、解消するまで続く問題 */
export interface AppAlert {
  kind: AlertKind;
  severity: 'warn' | 'error';
  message: string;
  actionLabel: string;
}

export interface HistoryQuery {
  query?: string;
  provider?: string;
  state?: '' | 'done' | 'failed';
  offset?: number;
  limit?: number;
}

export interface HistoryPage {
  items: RecordingInfo[];
  total: number;
  totalBytes: number;
  /** 絞り込み用の配信者名の一覧 */
  providers: string[];
}

export interface AppStatus {
  version: string;
  auth: AuthStatus;
  push: PushStatusInfo;
  detectorRunning: boolean;
  /** 録画中のものと、当日に終わったもの。それ以前は履歴 API で取る */
  recordings: RecordingInfo[];
  /** 履歴が更新されるたびに増える (履歴タブの再取得のきっかけ) */
  historyVersion: number;
  logs: LogEntry[];
  alerts: AppAlert[];
  logFilePath: string;
}

export type FollowCheckResult = 'following' | 'not-following' | 'unknown';

export interface TargetAddResult {
  target: TargetUser;
  follow: FollowCheckResult;
  /** 既に登録済みだった (追加はしていない) */
  alreadyExists: boolean;
}

/**
 * IPC の失敗理由。Error の message の先頭に `E_XXX:` として載せる
 * (IPC では Error のプロパティが落ちるため)
 */
export const ERROR_CODES = {
  invalidInput: 'E_INVALID_INPUT',
  userNotFound: 'E_USER_NOT_FOUND',
  invalidProgram: 'E_INVALID_PROGRAM',
  programUnavailable: 'E_PROGRAM_UNAVAILABLE',
  network: 'E_NETWORK',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export function codedError(code: ErrorCode, detail?: string): Error {
  return new Error(detail ? `${code}: ${detail}` : code);
}

export function parseErrorCode(message: string): ErrorCode | undefined {
  const match = message.match(/^(E_[A-Z_]+)/);
  return match ? (match[1] as ErrorCode) : undefined;
}

export const IPC = {
  getStatus: 'app:getStatus',
  getSettings: 'app:getSettings',
  updateSettings: 'app:updateSettings',
  updateUi: 'app:updateUi',
  chooseOutputDir: 'app:chooseOutputDir',
  openOutputDir: 'app:openOutputDir',
  openPath: 'app:openPath',
  openLogFile: 'app:openLogFile',
  reconnectPush: 'app:reconnectPush',
  addTarget: 'targets:add',
  restoreTarget: 'targets:restore',
  removeTarget: 'targets:remove',
  setTargetEnabled: 'targets:setEnabled',
  checkFollow: 'targets:checkFollow',
  login: 'auth:login',
  logout: 'auth:logout',
  startRecording: 'recording:start',
  stopRecording: 'recording:stop',
  listHistory: 'history:list',
  removeHistory: 'history:remove',
  historyContextMenu: 'history:contextMenu',
  statusChanged: 'app:statusChanged',
} as const;
