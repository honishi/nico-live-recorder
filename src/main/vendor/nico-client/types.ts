export type AccountStatus = 'Standard' | 'Premium';

export type CommentPosition = 'naka' | 'shita' | 'ue';

export type CommentSize = 'medium' | 'small' | 'big';

export type CommentFont = 'defont' | 'mincho' | 'gothic';

export type CommentOpacity = 'Normal' | 'Translucent';

export type CommentColorName =
  | 'white'
  | 'red'
  | 'pink'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'purple'
  | 'black'
  | 'white2'
  | 'red2'
  | 'pink2'
  | 'orange2'
  | 'yellow2'
  | 'green2'
  | 'cyan2'
  | 'blue2'
  | 'purple2'
  | 'black2';

export interface CommentFullColor {
  r: number;
  g: number;
  b: number;
}

export type CommentColor = CommentColorName | CommentFullColor;

export enum NicoLiveProgramStatus {
  onAir = 'onAir',
  ended = 'ended',
  released = 'released',
  unknown = 'unknown',
}

export interface NicoComment {
  id: string;
  at: Date;
  liveId: number;
  rawUserId: number;
  hashedUserId: string;
  accountStatus: AccountStatus;
  no: number;
  vpos: number;
  position: CommentPosition;
  size: CommentSize;
  color: CommentColor;
  font: CommentFont;
  opacity: CommentOpacity;
  content: string;
}

export interface NicoLiveProgramInfo {
  nicoliveProgramId: string;
  title: string;
  description: string;
  providerId?: string;
  providerName?: string;
  providerLevel?: number;
  status: NicoLiveProgramStatus;
  openTime: number;
  beginTime: number;
  vposBaseTime: number;
  endTime: number;
  scheduledEndTime: number;
  webSocketUrl?: string;
  thumbnailUrl?: string;
  openGraphImageUrl?: string;
  largeScreenshotUrl?: string;
  middleScreenshotUrl?: string;
  smallScreenshotUrl?: string;
  microScreenshotUrl?: string;
  hasTimeshift: boolean;
  supplierIntroduction: string;
  commentCount: number;
  watchCount: number;
}

export interface NicoUserInfo {
  userId: string;
  nickname: string;
  followerCount: number;
  followeeCount: number;
  isPremium: boolean;
}

export interface NicoUserApiClientOptions {
  /** 独自の User-Agent を指定する場合 */
  userAgent?: string;
}

export interface NicoClientOptions {
  /** 独自の User-Agent を指定する場合 */
  userAgent?: string;
  /** 事前に付与する Cookie (例: ログイン済みの user_session)。フォロワー限定番組などに必要 */
  cookies?: Record<string, string>;
  /** ログ出力を制御したい場合のロガー */
  logger?: Partial<
    Record<'verbose' | 'debug' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>
  >;
  /** WebSocket 接続開始から messageServer 受信までのタイムアウト (ms)。既定 15000 */
  viewUriTimeoutMs?: number;
}

export interface StreamOptions {
  /** AbortSignal を渡すと中断できます */
  signal?: AbortSignal;
  /** 初回の ChunkedEntry に対して ?at=now を付与するかどうか */
  startPosition?: 'now' | 'lastKnown';
  /**
   * ChunkedEntry.backward が提供された際に過去コメントを先読みするかどうか。
   * true でも walk は viewUri 取得ごとに 1 回のみ実行される (#132)
   */
  prefetchBackward?: boolean;
  /**
   * 計測用: ストリーム内部の診断イベントを受け取るコールバック。
   * 未指定なら一切のオーバーヘッドなし。backward fetch の頻度・規模の実測 (#135) と
   * その後の回帰確認に使う
   */
  diagnostics?: NicoStreamDiagnosticsListener;
}

/** streamComments の内部挙動を観測するための診断イベント */
export type NicoStreamDiagnosticsEvent =
  | {
      /** view API へのポーリング接続を 1 回開始した */
      type: 'poll_request';
      viewUri: string;
      at?: string;
      reconnectCount: number;
    }
  | {
      /** ChunkedEntry を 1 件受信した */
      type: 'chunked_entry';
      /** 現在のポーリング接続内での通し番号 (1 始まり) */
      entryIndex: number;
      hasSegment: boolean;
      hasPrevious: boolean;
      backwardUri?: string;
      /** backwardUri が processedBackwardUris で既処理扱いになるか */
      backwardAlreadyProcessed?: boolean;
      /** prefetchBackward 有効時、walk 実行済みのためスキップされるか (#132) */
      backwardPrefetchSkipped?: boolean;
      nextAt?: string;
    }
  | {
      /** backward URI を起点とした過去履歴の walk を 1 回終えた */
      type: 'backward_walk';
      startUri: string;
      /** 辿った PackedSegment 数 */
      packedSegments: number;
      /** walk 中に出現したコメント総数 (emit + drop) */
      comments: number;
      emitted: number;
      /** seenMessageIds による重複破棄数 */
      dropped: number;
      /** ダウンロードした生バイト数 */
      bytes: number;
      durationMs: number;
      /** walk 中に観測したコメント番号の最小値・最大値 (辿った範囲の推定用) */
      minNo?: number;
      maxNo?: number;
    }
  | {
      /** forward セグメント 1 本の読み取りを終えた */
      type: 'segment';
      uri: string;
      emitted: number;
      /** seenMessageIds による重複破棄数 */
      dropped: number;
    }
  | {
      /** コメント 1 件を emit または重複破棄した */
      type: 'comment';
      route: 'forward' | 'backward';
      emitted: boolean;
      id: string;
      no: number;
      at: string;
      content: string;
    };

export type NicoStreamDiagnosticsListener = (event: NicoStreamDiagnosticsEvent) => void;
