import { useState } from 'react';
import type { AppStatus, RecordingInfo } from '@shared/types';

interface Props {
  status: AppStatus;
  run: (task: () => Promise<unknown>) => Promise<void>;
}

const STATE_LABELS: Record<RecordingInfo['state'], string> = {
  starting: '開始中',
  recording: '録画中',
  finishing: '停止中',
  done: '完了',
  failed: '失敗',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(start: string, end?: string): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function RecordingsPanel({ status, run }: Props): JSX.Element {
  const [manual, setManual] = useState('');
  return (
    <>
      <h2>録画</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (manual.trim()) {
            void run(() => window.api.startRecording(manual)).then(() => setManual(''));
          }
        }}
      >
        <input
          type="text"
          placeholder="手動録画: lv123456789 または視聴ページの URL"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <button type="submit" disabled={!manual.trim()}>
          録画開始
        </button>
      </form>
      {status.recordings.length === 0 ? (
        <p className="hint">録画はまだありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>状態</th>
              <th>配信者</th>
              <th>タイトル</th>
              <th>時間</th>
              <th>サイズ</th>
              <th>コメント</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {status.recordings.map((r) => (
              <tr key={r.programId} className={r.state}>
                <td>
                  <span
                    className={`badge ${r.state === 'recording' ? 'rec' : r.state === 'failed' ? 'warn' : ''}`}
                  >
                    {STATE_LABELS[r.state]}
                  </span>
                </td>
                <td>{r.providerName ?? r.providerId ?? '-'}</td>
                <td>
                  <a
                    href={`https://live.nicovideo.jp/watch/${r.programId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.title}
                  </a>
                  {r.error && <div className="hint error-text">{r.error}</div>}
                </td>
                <td>{formatDuration(r.startedAt, r.endedAt)}</td>
                <td>{formatBytes(r.videoBytes)}</td>
                <td>{r.commentCount}</td>
                <td className="row">
                  {(r.state === 'recording' || r.state === 'starting') && (
                    <button
                      className="link danger"
                      onClick={() => void run(() => window.api.stopRecording(r.programId))}
                    >
                      停止
                    </button>
                  )}
                  {r.videoPath && (
                    <button
                      className="link"
                      onClick={() => void run(() => window.api.openPath(r.videoPath!))}
                    >
                      表示
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
