import { useState, type FormEvent, type ReactElement } from 'react';
import type { RecordingInfo } from '@shared/types';
import { EmptyState } from '../components/Shell';
import { describeError } from '../lib/errors';
import { formatBytes, formatCount, formatDuration, isToday } from '../lib/format';

interface Props {
  recordings: RecordingInfo[];
  loggedIn: boolean;
  loginPending: boolean;
  now: number;
  onLogin: () => void;
  onChooseOutputDir: () => void;
  onStop: (recording: RecordingInfo) => void;
  onShowFile: (path: string) => void;
  onShowHistory: () => void;
  onShowLog: (programId: string) => void;
}

const ACTIVE_STATES = new Set<RecordingInfo['state']>(['starting', 'recording', 'finishing']);

export function RecordingsTab(props: Props): ReactElement {
  if (!props.loggedIn) {
    return <Onboarding {...props} />;
  }
  const active = props.recordings.filter((r) => ACTIVE_STATES.has(r.state));
  const recent = props.recordings.filter(
    (r) => !ACTIVE_STATES.has(r.state) && r.endedAt && isToday(r.endedAt, props.now),
  );
  return (
    <>
      <section className="section">
        <div className="section-head">
          <span className="title">
            録画中<span className="count">{active.length} 件</span>
          </span>
        </div>
        {active.length === 0 ? (
          <EmptyState
            title="録画中の放送はありません"
            description="対象の配信者が放送を始めると、ここに録画中のカードが出ます。"
          />
        ) : (
          <div className="rec-cards">
            {active.map((r) => (
              <RecordingCard key={r.programId} recording={r} {...props} />
            ))}
          </div>
        )}
      </section>

      <section className="section grow">
        <div className="section-head">
          <span className="title">
            直近の録画<span className="count">今日 {recent.length} 件</span>
          </span>
          <button className="link" onClick={props.onShowHistory}>
            すべての履歴
          </button>
        </div>
        <div className="table grow">
          <div className="table-row head cols-recent">
            <span>状態</span>
            <span>配信者</span>
            <span>タイトル</span>
            <span className="num">時間</span>
            <span className="num col-size">サイズ</span>
            <span className="num col-comments">コメント</span>
          </div>
          <div className="table-scroll">
            {recent.length === 0 ? (
              <div className="table-row">
                <span className="muted">今日の録画はまだありません</span>
              </div>
            ) : (
              recent.map((r) => (
                <div
                  key={r.programId}
                  className={`table-row cols-recent ${r.videoExists === false ? 'dim' : ''}`}
                  onDoubleClick={() => r.videoPath && props.onShowFile(r.videoPath)}
                >
                  <span>
                    <StateBadge recording={r} />
                  </span>
                  <span className="ellipsis">{r.providerName ?? r.providerId ?? '—'}</span>
                  <span className="cell-title">
                    <span className="ellipsis">{r.state === 'failed' ? r.error : r.title}</span>
                    {r.state === 'failed' && (
                      <button className="link" onClick={() => props.onShowLog(r.programId)}>
                        詳細
                      </button>
                    )}
                  </span>
                  <span className="num">{formatDuration(r.startedAt, r.endedAt, props.now)}</span>
                  <span className="num col-size">
                    {r.videoExists === false ? '—' : formatBytes(r.videoBytes)}
                  </span>
                  <span className="num col-comments">{formatCount(r.commentCount)}</span>
                </div>
              ))
            )}
          </div>
        </div>
        <ManualRecordForm />
      </section>
    </>
  );
}

export function StateBadge({ recording }: { recording: RecordingInfo }): ReactElement {
  if (recording.state === 'failed') {
    return <span className="badge badge-warn">中断</span>;
  }
  if (recording.videoExists === false) {
    return <span className="badge badge-neutral">削除済</span>;
  }
  return <span className="badge badge-ok">完了</span>;
}

function RecordingCard({
  recording,
  now,
  onStop,
  onShowFile,
}: Props & { recording: RecordingInfo }): ReactElement {
  const r = recording;
  const stopping = r.state === 'finishing';
  return (
    <div className="rec-card">
      <div className="body">
        <div className="head">
          <span className="badge badge-rec">
            {r.state === 'starting' ? '開始中' : stopping ? '停止中' : '録画中'}
          </span>
          <span className="name ellipsis">{r.providerName ?? r.providerId ?? '—'}</span>
          <span className="id">{r.programId}</span>
        </div>
        <div className="ellipsis">{r.title}</div>
        <div className="stats">
          <span>{formatDuration(r.startedAt, undefined, now)}</span>
          <span>{formatBytes(r.videoBytes)}</span>
          <span>コメント {formatCount(r.commentCount)}</span>
        </div>
      </div>
      <div className="actions">
        <button className="btn btn-danger sm" disabled={stopping} onClick={() => onStop(r)}>
          {stopping ? '停止中…' : '停止'}
        </button>
        <button
          className="btn btn-secondary sm"
          disabled={!r.videoPath}
          onClick={() => r.videoPath && onShowFile(r.videoPath)}
        >
          表示
        </button>
      </div>
    </div>
  );
}

function ManualRecordForm(): ReactElement {
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!input.trim() || pending) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await window.api.startRecording(input.trim());
      setInput('');
    } catch (e) {
      setError(describeError(e, '録画を開始できませんでした'));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="field" onSubmit={(e) => void submit(e)}>
      <div className="field-row">
        <input
          className={`input ${error ? 'invalid' : ''}`}
          placeholder="手動録画: lv123456789 または視聴ページの URL"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(undefined);
          }}
          disabled={pending}
        />
        <button className="btn btn-primary" disabled={pending || !input.trim()}>
          {pending ? '開始中…' : '録画開始'}
        </button>
      </div>
      {error && <span className="field-error">{error}</span>}
    </form>
  );
}

function Onboarding({ loginPending, onLogin, onChooseOutputDir }: Props): ReactElement {
  return (
    <>
      <div className="card onboarding">
        <span className="mark" />
        <h2>ログインすると自動録画がはじまります</h2>
        <p>
          push
          通知はログイン中のアカウントがフォローしている配信者にだけ届きます。まずログインしてください。
        </p>
        <div className="actions">
          <button className="btn btn-primary" disabled={loginPending} onClick={onLogin}>
            {loginPending ? 'ログイン中…' : 'ニコニコにログイン'}
          </button>
          <button className="btn btn-secondary" onClick={onChooseOutputDir}>
            保存先を先に決める
          </button>
        </div>
        {loginPending && (
          <span className="muted" style={{ fontSize: 'var(--fs-sub)' }}>
            ログインウィンドウで操作を完了してください
          </span>
        )}
      </div>
      <div className="steps">
        {[
          ['STEP 1', 'ニコニコにログイン'],
          ['STEP 2', '録画したい配信者をフォロー'],
          ['STEP 3', '対象に追加して待つだけ'],
        ].map(([label, text]) => (
          <div key={label} className="step">
            <span className="label">{label}</span>
            <span className="text">{text}</span>
          </div>
        ))}
      </div>
    </>
  );
}
