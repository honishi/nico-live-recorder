import { useState, type ReactElement } from 'react';
import type { AppSettings, FollowCheckResult } from '@shared/types';

interface Props {
  settings: AppSettings;
  loggedIn: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}

const FOLLOW_LABELS: Record<FollowCheckResult, string> = {
  following: 'フォロー済み',
  'not-following': '未フォロー',
  unknown: '不明',
};

export function TargetsPanel({ settings, loggedIn, run }: Props): ReactElement {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [followStates, setFollowStates] = useState<Record<string, FollowCheckResult>>({});

  const add = async (): Promise<void> => {
    if (!input.trim()) {
      return;
    }
    setBusy(true);
    try {
      await run(async () => {
        const result = await window.api.addTarget(input);
        setFollowStates((prev) => ({ ...prev, [result.target.userId]: result.follow }));
        setInput('');
      });
    } finally {
      setBusy(false);
    }
  };

  const check = (userId: string): void => {
    void run(async () => {
      const follow = await window.api.checkFollow(userId);
      setFollowStates((prev) => ({ ...prev, [userId]: follow }));
    });
  };

  return (
    <>
      <h2>録画対象の配信者</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          type="text"
          placeholder="ユーザー ID または https://www.nicovideo.jp/user/12345"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          追加
        </button>
      </form>
      {settings.targets.length === 0 ? (
        <p className="hint">まだ登録がありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>有効</th>
              <th>名前</th>
              <th>ユーザー ID</th>
              <th>フォロー</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {settings.targets.map((target) => {
              const follow = followStates[target.userId];
              return (
                <tr key={target.userId} className={target.enabled ? '' : 'disabled'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={target.enabled}
                      onChange={() =>
                        void run(() => window.api.setTargetEnabled(target.userId, !target.enabled))
                      }
                    />
                  </td>
                  <td>{target.name}</td>
                  <td>
                    <a
                      href={`https://www.nicovideo.jp/user/${target.userId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {target.userId}
                    </a>
                  </td>
                  <td>
                    {follow ? (
                      <span
                        className={`badge ${follow === 'following' ? 'ok' : follow === 'not-following' ? 'warn' : ''}`}
                      >
                        {FOLLOW_LABELS[follow]}
                      </span>
                    ) : (
                      <button
                        className="link"
                        disabled={!loggedIn}
                        onClick={() => check(target.userId)}
                      >
                        確認
                      </button>
                    )}
                  </td>
                  <td>
                    <button
                      className="link danger"
                      onClick={() => void run(() => window.api.removeTarget(target.userId))}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
