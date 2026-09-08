import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { HistoryPage, RecordingInfo } from '@shared/types';
import { EmptyState } from '../components/Shell';
import { ShowRecordingButton } from '../components/ShowRecordingButton';
import { formatBytes, formatCount, formatDateTime, formatDuration } from '../lib/format';
import { StateBadge } from './RecordingsTab';

interface Props {
  /** main の履歴が変わるたびに増える。再取得のきっかけ */
  historyVersion: number;
  now: number;
  onShowFile: (path: string) => void;
  onShowLog: (programId: string) => void;
}

const PAGE_SIZE = 50;

/**
 * 永続化された録画履歴。新しい順固定で、検索・配信者・状態で絞り込み、50 件ずつ読み足す
 */
export function HistoryTab({ historyVersion, now, onShowFile, onShowLog }: Props): ReactElement {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [state, setState] = useState<'' | 'done' | 'failed' | 'cancelled'>('');
  const [page, setPage] = useState<HistoryPage>();
  const [items, setItems] = useState<RecordingInfo[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestId = useRef(0);

  // 条件が変わったら先頭から取り直す。古い応答は捨てる
  const reload = useCallback(async () => {
    requestId.current += 1;
    const id = requestId.current;
    const next = await window.api.listHistory({
      query,
      provider,
      state,
      offset: 0,
      limit: PAGE_SIZE,
    });
    if (id === requestId.current) {
      setPage(next);
      setItems(next.items);
    }
  }, [query, provider, state]);

  useEffect(() => {
    void reload();
  }, [reload, historyVersion]);

  const loadMore = async (): Promise<void> => {
    setLoadingMore(true);
    try {
      const next = await window.api.listHistory({
        query,
        provider,
        state,
        offset: items.length,
        limit: PAGE_SIZE,
      });
      setPage(next);
      setItems((prev) => [...prev, ...next.items]);
    } finally {
      setLoadingMore(false);
    }
  };

  const contextMenu = (r: RecordingInfo): void => {
    void window.api.historyContextMenu(r.programId, r.videoPath, r.commentsPath);
  };

  const hasAny = page !== undefined && (page.total > 0 || query || provider || state);

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
          {(page?.providers ?? []).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={state}
          onChange={(e) => setState(e.target.value as '' | 'done' | 'failed' | 'cancelled')}
        >
          <option value="">すべての状態</option>
          <option value="done">完了</option>
          <option value="cancelled">停止</option>
          <option value="failed">中断</option>
        </select>
      </div>

      {!page ? null : !hasAny ? (
        <EmptyState
          title="録画履歴はまだありません"
          description="録画が終わるとここに残ります。ファイルは保存先フォルダにそのまま置かれます。"
        />
      ) : (
        <>
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
                  <span className="muted">条件に合う録画はありません</span>
                </div>
              )}
              {items.map((r) => (
                <div
                  key={r.programId}
                  className={`table-row cols-history ${r.videoExists === false ? 'dim' : ''}`}
                  onDoubleClick={() => r.videoPath && onShowFile(r.videoPath)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    contextMenu(r);
                  }}
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
          <div className="table-foot">
            <span>
              {items.length} / {page.total} 件 · 合計 {formatBytes(page.totalBytes)}
            </span>
            <button
              className="btn btn-secondary sm"
              disabled={loadingMore || items.length >= page.total}
              onClick={() => void loadMore()}
            >
              {loadingMore ? '読み込み中…' : 'さらに読み込む'}
            </button>
          </div>
        </>
      )}
    </>
  );
}
