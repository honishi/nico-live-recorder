import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { LogEntry, UiState } from '@shared/types';
import { formatClock } from '../lib/format';

interface Props {
  logs: LogEntry[];
  ui: UiState;
  filter?: string;
  onClearFilter: () => void;
  onUpdateUi: (patch: Partial<UiState>) => void;
  onCopied: () => void;
}

const LEVEL_LABELS: Record<LogEntry['level'], string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

function levelLabel(entry: LogEntry): string {
  return entry.category === 'rec' && entry.level === 'info' ? 'REC' : LEVEL_LABELS[entry.level];
}

function lineClass(entry: LogEntry): string {
  const classes = ['log-line', entry.level];
  if (entry.category === 'rec' && entry.level === 'info') {
    classes.push('rec');
  }
  if (entry.category === 'push' && entry.level === 'info' && entry.message.includes('received')) {
    classes.push('push-received');
  }
  return classes.join(' ');
}

export function LogTab({
  logs,
  ui,
  filter,
  onClearFilter,
  onUpdateUi,
  onCopied,
}: Props): ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [showLatest, setShowLatest] = useState(false);

  const visible = logs.filter((entry) => {
    if (!ui.showDebug && entry.level === 'debug') {
      return false;
    }
    return !filter || entry.message.includes(filter);
  });
  const hiddenByDebug =
    filter !== undefined &&
    visible.length === 0 &&
    !ui.showDebug &&
    logs.some((entry) => entry.level === 'debug' && entry.message.includes(filter));

  // 自動スクロールが有効なら末尾に追従する
  useEffect(() => {
    if (ui.autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [visible.length, ui.autoScroll]);

  const onScroll = (): void => {
    const el = bodyRef.current;
    if (!el) {
      return;
    }
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    if (!atBottom && ui.autoScroll) {
      // 手で上へスクロールしたら自動追従を止め、「最新へ」を出す
      onUpdateUi({ autoScroll: false });
      setShowLatest(true);
    } else if (atBottom) {
      setShowLatest(false);
    }
  };

  const jumpToLatest = (): void => {
    onUpdateUi({ autoScroll: true });
    setShowLatest(false);
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  };

  const copy = async (): Promise<void> => {
    const text = visible.map((e) => `${e.ts} ${levelLabel(e).padEnd(5)} ${e.message}`).join('\n');
    await navigator.clipboard.writeText(text);
    onCopied();
  };

  return (
    <>
      <div className="log-controls">
        <div className="checks">
          <label>
            <input
              type="checkbox"
              className="checkbox"
              checked={ui.showDebug}
              onChange={(e) => onUpdateUi({ showDebug: e.target.checked })}
            />
            debug を表示
          </label>
          <label>
            <input
              type="checkbox"
              className="checkbox"
              checked={ui.autoScroll}
              onChange={(e) => {
                onUpdateUi({ autoScroll: e.target.checked });
                if (e.target.checked) {
                  setShowLatest(false);
                }
              }}
            />
            自動スクロール
          </label>
        </div>
        <div className="buttons">
          <button className="btn btn-secondary sm" onClick={() => void window.api.openLogFile()}>
            ファイルを開く
          </button>
          <button className="btn btn-secondary sm" onClick={() => void copy()}>
            コピー
          </button>
        </div>
      </div>
      {filter && (
        <span className="chip">
          {filter} で絞り込み中
          <button onClick={onClearFilter} title="絞り込みを解除">
            ×
          </button>
        </span>
      )}
      <div className="log-wrap">
        <div className="log-body" ref={bodyRef} onScroll={onScroll}>
          {visible.length === 0 ? (
            <div className="log-empty">
              {hiddenByDebug ? (
                <>
                  この放送のログは debug 表示に含まれています
                  <button className="link" onClick={() => onUpdateUi({ showDebug: true })}>
                    debug を表示
                  </button>
                </>
              ) : (
                'ログはまだありません'
              )}
            </div>
          ) : (
            visible.map((entry, index) => (
              <div key={`${entry.ts}-${index}`} className={lineClass(entry)}>
                <span className="time">{formatClock(entry.ts)}</span>
                <span className="level">{levelLabel(entry)}</span>
                <span className="message">{entry.message}</span>
              </div>
            ))
          )}
        </div>
        {showLatest && !ui.autoScroll && (
          <button className="btn btn-secondary sm log-latest" onClick={jumpToLatest}>
            最新へ
          </button>
        )}
      </div>
    </>
  );
}
