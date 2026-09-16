import type { ReactElement } from 'react';
import type { RecordingInfo } from '@shared/types';
import { ShowRecordingButton } from './ShowRecordingButton';
import { formatBytes, formatCount, formatDateTime, formatDuration } from '../lib/format';

interface Props {
  items: RecordingInfo[];
  now: number;
  emptyMessage: string;
  onShowFile: (path: string) => void;
  onShowLog: (programId: string) => void;
  onContextMenu?: (recording: RecordingInfo) => void;
}

/** 録画タブと履歴タブで列・日時・状態の表示を揃える。 */
export function RecordingHistoryTable({
  items,
  now,
  emptyMessage,
  onShowFile,
  onShowLog,
  onContextMenu,
}: Props): ReactElement {
  return (
    <div className="table grow">
      <div className="table-row head cols-history">
        <span>日時</span>
        <span>状態</span>
        <span>配信者</span>
        <span>タイトル</span>
        <span className="num">時間</span>
        <span className="num col-size">サイズ</span>
        <span className="num col-comments">コメント</span>
        <span aria-hidden="true" />
      </div>
      <div className="table-scroll">
        {items.length === 0 && (
          <div className="table-row">
            <span className="muted">{emptyMessage}</span>
          </div>
        )}
        {items.map((r) => (
          <div
            key={r.programId}
            className={`table-row cols-history ${r.videoExists === false ? 'dim' : ''}`}
            onDoubleClick={() => r.videoPath && onShowFile(r.videoPath)}
            onContextMenu={
              onContextMenu
                ? (e) => {
                    e.preventDefault();
                    onContextMenu(r);
                  }
                : undefined
            }
          >
            <span style={{ fontSize: 'var(--fs-sub)', color: 'var(--text-2)' }}>
              {formatDateTime(r.endedAt ?? r.startedAt, now)}
            </span>
            <span>
              <StateBadge recording={r} />
            </span>
            <span className="ellipsis">{r.providerName ?? r.providerId ?? '—'}</span>
            <span className="cell-title">
              <span className="ellipsis" title={r.title}>
                {r.mode === 'timeshift' ? '[タイムシフト] ' : ''}
                {r.error ?? r.title}
              </span>
              {(r.state === 'failed' || r.error) && (
                <button className="link" onClick={() => onShowLog(r.programId)}>
                  詳細
                </button>
              )}
            </span>
            <span className="num">{formatDuration(r.startedAt, r.endedAt, now)}</span>
            <span className="num col-size">
              {r.videoExists === false ? '—' : formatBytes(r.videoBytes)}
            </span>
            <span className="num col-comments">{formatCount(r.commentCount)}</span>
            <ShowRecordingButton recording={r} onShowFile={onShowFile} />
          </div>
        ))}
      </div>
    </div>
  );
}

function StateBadge({ recording }: { recording: RecordingInfo }): ReactElement {
  if (recording.completion === 'cancelled')
    return <span className="badge badge-neutral">停止</span>;
  if (recording.state === 'failed') {
    return <span className="badge badge-warn">中断</span>;
  }
  if (recording.error || recording.completion === 'partial') {
    return <span className="badge badge-warn">一部失敗</span>;
  }
  if (recording.videoExists === false) {
    return <span className="badge badge-neutral">削除済</span>;
  }
  return <span className="badge badge-ok">完了</span>;
}
