import { useMemo, useState, type ReactElement } from 'react';
import type { RecordingInfo } from '@shared/types';
import { EmptyState } from '../components/Shell';
import { formatBytes, formatCount, formatDateTime, formatDuration } from '../lib/format';
import { StateBadge } from './RecordingsTab';

interface Props {
  recordings: RecordingInfo[];
  now: number;
  onShowFile: (path: string) => void;
  onShowLog: (programId: string) => void;
}

const FINISHED = new Set<RecordingInfo['state']>(['done', 'failed']);

/**
 * 録画履歴。永続化 (#9) までは、このセッションで終了した録画だけを表示する
 */
export function HistoryTab({ recordings, now, onShowFile, onShowLog }: Props): ReactElement {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [state, setState] = useState('');

  const finished = useMemo(() => recordings.filter((r) => FINISHED.has(r.state)), [recordings]);
  const providers = useMemo(
    () => [...new Set(finished.map((r) => r.providerName ?? r.providerId ?? ''))].filter(Boolean),
    [finished],
  );
  const rows = finished.filter((r) => {
    const name = r.providerName ?? r.providerId ?? '';
    if (provider && name !== provider) {
      return false;
    }
    if (state === 'done' && r.state !== 'done') {
      return false;
    }
    if (state === 'failed' && r.state !== 'failed') {
      return false;
    }
    if (query) {
      const q = query.toLowerCase();
      return r.title.toLowerCase().includes(q) || name.toLowerCase().includes(q);
    }
    return true;
  });
  const totalBytes = rows.reduce((sum, r) => sum + (r.videoExists === false ? 0 : r.videoBytes), 0);

  return (
    <>
      <div className="filters">
        <input
          className="input"
          placeholder="タイトル・配信者で検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="select" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">すべての配信者</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select className="select" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">すべての状態</option>
          <option value="done">完了</option>
          <option value="failed">中断</option>
        </select>
      </div>

      {finished.length === 0 ? (
        <EmptyState
          title="録画履歴はまだありません"
          description="録画が終わるとここに残ります。ファイルは保存先フォルダにそのまま置かれます。"
        />
      ) : (
        <div className="table grow">
          <div className="table-row head cols-history">
            <span>日時</span>
            <span>状態</span>
            <span>配信者</span>
            <span>タイトル</span>
            <span className="num">時間</span>
            <span className="num col-size">サイズ</span>
            <span className="num col-comments">コメント</span>
          </div>
          <div className="table-scroll">
            {rows.map((r) => (
              <div
                key={r.programId}
                className={`table-row cols-history ${r.videoExists === false ? 'dim' : ''}`}
                onDoubleClick={() => r.videoPath && onShowFile(r.videoPath)}
              >
                <span style={{ fontSize: 'var(--fs-sub)', color: 'var(--text-2)' }}>
                  {formatDateTime(r.endedAt ?? r.startedAt, now)}
                </span>
                <span>
                  <StateBadge recording={r} />
                </span>
                <span className="ellipsis">{r.providerName ?? r.providerId ?? '—'}</span>
                <span className="cell-title">
                  <span className="ellipsis">{r.state === 'failed' ? r.error : r.title}</span>
                  {r.state === 'failed' && (
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
              </div>
            ))}
          </div>
        </div>
      )}

      {finished.length > 0 && (
        <div className="table-foot">
          <span>
            {rows.length} / {finished.length} 件 · 合計 {formatBytes(totalBytes)}
          </span>
          <span>このセッションの録画のみ (履歴の保存は今後対応)</span>
        </div>
      )}
    </>
  );
}
