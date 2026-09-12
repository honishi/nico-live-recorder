/** main / preload / renderer で共有する型と IPC チャネル名 */

export interface TargetUser {
  /** ニコニコのユーザー ID (数字) */
  userId: string;
  name: string;
  enabled: boolean;
  addedAt: string;
}

/** 実際に削除できた対象だけを取り消しに使う */
export interface TargetRemovalResult {
  settings: AppSettings;
  removed: TargetUser[];
  previousOrder: string[];
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
  /** 保存先の空き容量がこの GB を下回ったら警告する。0 なら確認しない */
  minFreeSpaceGb: number;
  ui: UiState;
  window?: WindowBounds;
}

export type RecordingState = 'starting' | 'recording' | 'finishing' | 'done' | 'failed';

export type RecordingSource = 'push' | 'poll' | 'manual';

export type RecordingMode = 'live' | 'timeshift';
export type RecordingCompletion = 'complete' | 'partial' | 'cancelled';
export interface TimeshiftProgress {
  phase: 'connecting' | 'downloading' | 'saving' | 'comments';
  savedSegments: number;
  totalSegments: number;
  /** 映像・音声の取得完了までの推定秒数。コメント取得・保存処理は含まない */
  estimatedRemainingSeconds?: number;
  comments: 'pending' | 'complete' | 'partial';
}

/** 画面だけで使う一時画像。設定・録画履歴・メタデータには保存しない。 */
export interface RecordingPreview {
  dataUrl: string;
  capturedAt: number;
}

export interface RecordingInfo {
  /** 未指定の旧履歴はライブ録画として扱う */
  mode?: RecordingMode;
  completion?: RecordingCompletion;
  timeshift?: TimeshiftProgress;
  /** タイムシフトの録り直しを含むコメントファイル */
  commentsPaths?: string[];
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
  /** 最新の録画ファイル。再開すると連番付きの別ファイルになる */
  videoPath?: string;
  /** これまでの録画ファイルすべて (再開分を含む) */
  videoPaths?: string[];
  commentsPath?: string;
  /** 何回目の録画か (2 以上は失敗後の再開) */
  attempt?: number;
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
  revision: number;
}

export interface PushStatusInfo {
  state: string;
  niconicoRegistered: boolean;
  lastReceivedAt?: string;
  lastError?: string;
}

export type AlertKind = 'output-dir' | 'auth-expired' | 'push-unavailable' | 'disk-space';

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
  state?: '' | 'done' | 'failed' | 'cancelled';
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

/** 更新の取得・適用状況。録画中は再起動を保留する。 */
export interface UpdateStatus {
  checking: boolean;
  result:
    | 'unchecked'
    | 'current'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'disabled'
    | 'unavailable'
    | 'error'
    | 'rate-limited';
  progress?: number;
  installBlocked: boolean;
  release?: { version: string; url: string };
  checkedAt?: string;
  nextCheckAt: number;
}

export type UpdateInstallResult = 'started' | 'busy' | 'not-ready';

export interface AppStatus {
  version: string;
  update: UpdateStatus;
  auth: AuthStatus;
  push: PushStatusInfo;
  detectorRunning: boolean;
  /** 録画中のものと、当日に終わったもの。それ以前は履歴 API で取る */
  recordings: RecordingInfo[];
  /** 履歴が更新されるたびに増える (履歴タブの再取得のきっかけ) */
  historyVersion: number;
  alerts: AppAlert[];
  logFilePath: string;
  /** 保存先の空き容量 (バイト)。取得できないときは undefined */
  diskFreeBytes?: number;
}

export type FollowCheckResult = 'following' | 'not-following' | 'unknown';

/** フォロー確認の結果と、次に問い合わせてよい時刻。時刻は epoch ミリ秒 */
export interface FollowStatus {
  result?: FollowCheckResult;
  stale: boolean;
  state: 'done' | 'waiting' | 'paused' | 'stopped';
  retryAt: number;
  /** 特定のユーザーだけでなく、確認 API 全体の休止 */
  servicePaused?: boolean;
}

export interface TargetAddResult {
  target: TargetUser;
  follow: FollowStatus;
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
  timeshiftUnavailable: 'E_TIMESHIFT_UNAVAILABLE',
  network: 'E_NETWORK',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export function codedError(code: ErrorCode, detail?: string): Error {
  return new Error(detail ? `${code}: ${detail}` : code);
}

/**
 * ipcRenderer.invoke の reject は "Error invoking remote method 'x': Error: E_XXX: ..." の形で
 * 届くため、先頭ではなく文中から既知のコードを探す
 */
export function parseErrorCode(message: string): ErrorCode | undefined {
  return Object.values(ERROR_CODES).find((code) => new RegExp(`\\b${code}\\b`).test(message));
}

export const IPC = {
  getStatus: 'app:getStatus',
  getLogs: 'app:getLogs',
  getSettings: 'app:getSettings',
  updateSettings: 'app:updateSettings',
  updateUi: 'app:updateUi',
  chooseOutputDir: 'app:chooseOutputDir',
  openOutputDir: 'app:openOutputDir',
  openPath: 'app:openPath',
  openLogFile: 'app:openLogFile',
  openFfmpegLicenses: 'app:openFfmpegLicenses',
  checkForUpdates: 'app:checkForUpdates',
  installUpdate: 'app:installUpdate',
  openReleasePage: 'app:openReleasePage',
  reconnectPush: 'app:reconnectPush',
  addTarget: 'targets:add',
  restoreTargets: 'targets:restoreMany',
  removeTargets: 'targets:removeMany',
  moveTarget: 'targets:move',
  setTargetsEnabled: 'targets:setManyEnabled',
  checkFollow: 'targets:checkFollow',
  login: 'auth:login',
  logout: 'auth:logout',
  startRecording: 'recording:start',
  stopRecording: 'recording:stop',
  getRecordingPreview: 'recording:preview',
  listHistory: 'history:list',
  removeHistory: 'history:remove',
  historyContextMenu: 'history:contextMenu',
  statusChanged: 'app:statusChanged',
  logsChanged: 'app:logsChanged',
  settingsChanged: 'app:settingsChanged',
} as const;
