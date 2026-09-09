import type { RecordingMode, RecordingCompletion, TimeshiftProgress } from '../../../shared/types';
import type { NicoLiveProgramInfo, NicoComment } from '../../vendor/nico-client/types';
import type { Logger } from '../logger';
import type { TrackResult } from '../nico/hls';
import type { TimeshiftPlaylistDiagnostic } from '../nico/timeshift-playlist';
import type { VideoSampleListener } from '../nico/video-sample';

export interface ProgramRecorderOptions {
  mode?: RecordingMode;
  /** 復号済み映像の任意の観測先。録画を待たせず受付だけ行う。 */
  onVideoSample?: VideoSampleListener;
  onTimeshiftProgress?: (progress: TimeshiftProgress) => void;
  programId: string;
  /** 録画ファイルを置くディレクトリ (存在しなければ作成する) */
  outputDir: string;
  cookies?: Record<string, string>;
  userAgent?: string;
  ffmpegPath?: string;
  logger?: Logger;
  programInfo?: NicoLiveProgramInfo;
  onComment?: (comment: NicoComment, count: number) => void;
  /** 何回目の録画か。2 以上はファイル名に連番を付ける。同名ファイルがあれば次の空き番号に進める */
  attempt?: number;
  /** 接続前の過去コメントも取得するか (再開時は false) */
  prefetchBackwardComments?: boolean;
  /** コメントの出力先を固定する (再開時に最初のパートのファイルへ追記するため) */
  commentsPath?: string;
  /** 出力先が決まった時点で呼ばれる (録画中のサイズ表示などに使う) */
  onPaths?: (paths: { attempt: number; videoPath: string; commentsPath: string }) => void;
}

export interface ProgramRecordResult {
  timeshift?: {
    completion: RecordingCompletion;
    progress: TimeshiftProgress;
    commentReason?: string;
    video?: TimeshiftVideoReport;
    comments?: Pick<
      TimeshiftCommentResult,
      | 'status'
      | 'reason'
      | 'count'
      | 'sorted'
      | 'duplicates'
      | 'invalidCount'
      | 'viewRequests'
      | 'startedAt'
      | 'endedAt'
    >;
  };
  programId: string;
  programInfo: NicoLiveProgramInfo;
  /** 実際に使った連番 (既存ファイルを避けて進むことがある) */
  attempt: number;
  baseName: string;
  videoPath: string;
  commentsPath: string;
  metadataPath: string;
  video?: VideoRecordResult;
  comments?: CommentRecordResult;
  /** 映像・コメントのどちらかが失敗した場合のエラー */
  errors: { target: 'video' | 'comments'; message: string }[];
}

export type VideoStopReason = 'program-ended' | 'endlist' | 'aborted' | 'idle' | 'disconnected';

export interface VideoRecordResult {
  outputPath: string;
  startedAt: Date;
  endedAt: Date;
  reason: VideoStopReason;
  video: TrackResult;
  audio?: TrackResult;
  ffmpegExitCode: number | null;
}

export interface CommentRecordResult {
  outputPath: string;
  count: number;
  startedAt: Date;
  endedAt: Date;
  aborted: boolean;
}

export interface TimeshiftVideoReport {
  startedAt: string;
  endedAt?: string;
  ffmpegExitCode?: number | null;
  playlists?: { label: 'video' | 'audio'; diagnostic?: TimeshiftPlaylistDiagnostic }[];
  tracks: { expected: number; saved: number; missing: number; httpErrors: number[] }[];
}

export interface TimeshiftCommentResult extends CommentRecordResult {
  status: 'complete' | 'partial';
  reason: string;
  sorted: boolean;
  duplicates: number;
  invalidCount: number;
  viewRequests?: { durationMs: number; entries: number }[];
}
