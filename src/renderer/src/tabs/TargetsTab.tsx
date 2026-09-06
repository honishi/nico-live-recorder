import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { FollowCheckResult, FollowStatus, TargetUser } from '@shared/types';
import { FollowRequests, type FollowView } from '@shared/follow-requests';
import { EmptyState } from '../components/Shell';
import { describeError } from '../lib/errors';

interface Props {
  targets: TargetUser[];
  loggedIn: boolean;
  now: number;
  onRemoved: (target: TargetUser) => void;
}

const FOLLOW_LABELS: Record<FollowCheckResult, string> = {
  following: 'フォロー中',
  'not-following': '未フォロー',
  unknown: '不明',
};

export function TargetsTab({ targets, loggedIn, now, onRemoved }: Props): ReactElement {
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const [view, setView] = useState<FollowView>({ entries: {} });
  const requests = useRef<FollowRequests | undefined>(undefined);
  const scrollRoot = useRef<HTMLDivElement>(null);
  // 録画・ログの更新で settings が再取得されても、同じ対象の表示監視は張り直さない
  const followTargetsKey = targets
    .filter((target) => target.enabled)
    .map((target) => target.userId)
    .join(',');

  // 問い合わせの管理はタブの寿命に合わせ、離れたら未送信の処理をすべて止める
  useEffect(() => {
    const controller = new FollowRequests(
      (userId, manual) => window.api.checkFollow(userId, manual),
      setView,
    );
    requests.current = controller;
    const visibilityChanged = (): void => controller.setActive(!document.hidden);
    visibilityChanged();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      controller.dispose();
      requests.current = undefined;
    };
  }, []);

  // 表示された有効行だけを候補にする。先読みの余白を付けず、画面外は取得しない
  useEffect(() => {
    const root = scrollRoot.current;
    const controller = requests.current;
    if (!loggedIn || !root || !controller) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const userId = (entry.target as HTMLElement).dataset.followUserId;
          if (userId) {
            controller.setVisible(userId, entry.isIntersecting && entry.intersectionRatio > 0);
          }
        }
      },
      { root, rootMargin: '0px', threshold: [0, 0.01] },
    );
    const rows = root.querySelectorAll<HTMLElement>('[data-follow-user-id]');
    for (const row of rows) {
      observer.observe(row);
    }
    return () => {
      observer.disconnect();
      for (const row of rows) {
        controller.setVisible(row.dataset.followUserId!, false);
      }
    };
  }, [followTargetsKey, loggedIn]);

  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const value = input.trim();
    if (!value || pending) {
      return;
    }
    setPending(value);
    setError(undefined);
    try {
      const result = await window.api.addTarget(value);
      requests.current?.accept(result.target.userId, result.follow);
      if (result.alreadyExists) {
        setError('すでに録画対象です');
        setFlash(result.target.userId);
        setTimeout(() => setFlash(undefined), 1000);
      } else {
        setInput('');
      }
    } catch (e) {
      setError(describeError(e, '追加できませんでした'));
    } finally {
      setPending(undefined);
    }
  };

  const remove = async (target: TargetUser): Promise<void> => {
    await window.api.removeTarget(target.userId);
    requests.current?.setVisible(target.userId, false);
    onRemoved(target);
  };

  const notFollowing = targets.some(
    (t) =>
      t.enabled &&
      view.entries[t.userId]?.result === 'not-following' &&
      !view.entries[t.userId]?.stale &&
      view.entries[t.userId].retryAt > now,
  );
  const failed = targets.some((t) => t.enabled && view.entries[t.userId]?.state === 'stopped');
  const paused = view.service?.state === 'paused';
  const stopped = view.service?.state === 'stopped';

  return (
    <>
      <form className="field" onSubmit={(e) => void add(e)}>
        <div className="field-row">
          <input
            className={`input ${error ? 'invalid' : ''}`}
            placeholder="ユーザー ID または https://www.nicovideo.jp/user/12345"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(undefined);
            }}
            disabled={pending !== undefined}
          />
          <button className="btn btn-primary" disabled={pending !== undefined || !input.trim()}>
            {pending ? '追加中…' : '追加'}
          </button>
        </div>
        {error && <span className="field-error">{error}</span>}
      </form>

      {targets.length === 0 && !pending ? (
        <EmptyState
          title="録画対象がまだありません"
          description="ニコニコでフォローしている配信者の ID を上の欄に入れて追加します。"
        />
      ) : (
        <div className="table grow">
          <div className="table-row head cols-targets">
            <span>有効</span>
            <span>名前</span>
            <span>ユーザー ID</span>
            <span>フォロー状態</span>
            <span />
          </div>
          <div className="table-scroll" ref={scrollRoot}>
            {pending && (
              <div className="table-row cols-targets dim">
                <span>
                  <input type="checkbox" className="checkbox" checked disabled />
                </span>
                <span>解決中…</span>
                <span className="mono" style={{ fontSize: 'var(--fs-sub)' }}>
                  {pending}
                </span>
                <span>—</span>
                <span />
              </div>
            )}
            {targets.map((target) => (
              <div
                key={target.userId}
                data-follow-user-id={target.enabled ? target.userId : undefined}
                className={`table-row cols-targets ${target.enabled ? '' : 'dim'} ${flash === target.userId ? 'flash' : ''}`}
              >
                <span>
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={target.enabled}
                    onChange={() =>
                      void window.api.setTargetEnabled(target.userId, !target.enabled)
                    }
                  />
                </span>
                <span className="ellipsis">{target.name}</span>
                <span
                  className="mono"
                  style={{ fontSize: 'var(--fs-sub)', color: 'var(--text-2)' }}
                >
                  {target.userId}
                </span>
                <span>
                  <FollowBadge
                    enabled={target.enabled}
                    status={view.entries[target.userId]}
                    checking={view.checking === target.userId}
                    now={now}
                    retry={() => requests.current?.retry(target.userId)}
                    retryDisabled={
                      !loggedIn ||
                      now <
                        Math.max(
                          view.entries[target.userId]?.retryAt ?? 0,
                          view.service?.retryAt ?? 0,
                        )
                    }
                  />
                </span>
                <span>
                  <button className="link quiet hover-only" onClick={() => void remove(target)}>
                    削除
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {notFollowing && (
        <p className="note" style={{ margin: 0 }}>
          未フォローの配信者は自動検知されません。ニコニコでフォローするか、手動録画を使ってください。
        </p>
      )}
      {(paused || stopped || failed) && (
        <p className="note" style={{ margin: 0 }}>
          {paused
            ? 'フォロー状態の確認を一時停止しています。自動で再確認します。'
            : 'フォロー状態を確認できませんでした。録画の対象からは外れません。'}
          {stopped && (
            <button
              className="link"
              style={{ marginLeft: 12 }}
              disabled={!loggedIn || now < (view.service?.retryAt ?? 0)}
              onClick={() => requests.current?.retryVisible()}
            >
              再確認
            </button>
          )}
        </p>
      )}
    </>
  );
}

function FollowBadge({
  enabled,
  status,
  checking,
  now,
  retry,
  retryDisabled,
}: {
  enabled: boolean;
  status?: FollowStatus;
  checking: boolean;
  now: number;
  retry: () => void;
  retryDisabled: boolean;
}): ReactElement {
  if (!enabled) {
    return <span className="badge badge-neutral">無効</span>;
  }
  const result = status?.result;
  const stale = status?.stale || (status?.state === 'done' && status.retryAt <= now);
  let label = '未確認';
  let className = 'badge-neutral';
  if (result && result !== 'unknown') {
    label = `${stale ? '前回：' : ''}${FOLLOW_LABELS[result]}`;
    if (!stale) {
      className = result === 'following' ? 'badge-ok' : 'badge-warn';
    }
  } else if (checking) {
    label = '確認中';
  } else if (status?.state === 'paused') {
    label = '再確認待ち';
  } else if (result === 'unknown') {
    label = '不明';
  }
  return (
    <>
      <span
        className={`badge ${className}`}
        title={stale ? '前回確認できた結果です。現在の状態は再確認が必要です。' : undefined}
      >
        {label}
      </span>
      {status?.state === 'stopped' && !status.servicePaused && (
        <button
          className="link"
          style={{ marginLeft: 8 }}
          disabled={retryDisabled || checking}
          onClick={retry}
        >
          再確認
        </button>
      )}
    </>
  );
}
