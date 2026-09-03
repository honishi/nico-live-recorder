import type { ReactElement } from 'react';
import type { AppStatus } from '@shared/types';

interface Props {
  status: AppStatus;
  run: (task: () => Promise<unknown>) => Promise<void>;
}

const PUSH_LABELS: Record<string, string> = {
  stopped: '停止',
  starting: '接続中',
  connected: '接続済み',
  disconnected: '切断 (再接続中)',
  'repair-required': '再登録中',
  error: 'エラー',
};

export function AuthPanel({ status, run }: Props): ReactElement {
  const { auth, push } = status;
  return (
    <>
      <h2>アカウント・検知</h2>
      <dl className="kv">
        <dt>ログイン</dt>
        <dd>
          {auth.loggedIn ? (
            <>
              <span className="badge ok">ログイン済み</span>
              <button className="link" onClick={() => void run(() => window.api.logout())}>
                ログアウト
              </button>
            </>
          ) : (
            <>
              <span className="badge warn">未ログイン</span>
              <button onClick={() => void run(() => window.api.login())}>ログイン</button>
            </>
          )}
        </dd>
        <dt>push 通知</dt>
        <dd>
          <span className={`badge ${push.state === 'connected' ? 'ok' : 'warn'}`}>
            {PUSH_LABELS[push.state] ?? push.state}
          </span>
          {push.state === 'connected' && !push.niconicoRegistered && (
            <span className="hint">ニコニコ側の登録が未完了</span>
          )}
          {push.lastError && <div className="hint error-text">{push.lastError}</div>}
          {push.lastReceivedAt && (
            <div className="hint">最終受信: {new Date(push.lastReceivedAt).toLocaleString()}</div>
          )}
        </dd>
        <dt>ポーリング</dt>
        <dd>
          <span className={`badge ${status.detectorRunning ? 'ok' : 'warn'}`}>
            {status.detectorRunning ? '監視中' : '停止'}
          </span>
        </dd>
      </dl>
      <p className="hint">
        push 通知はログイン中のアカウントがフォローしている配信者の放送開始にだけ届きます。
        録画したい配信者は事前にニコニコでフォローしてください。
      </p>
    </>
  );
}
