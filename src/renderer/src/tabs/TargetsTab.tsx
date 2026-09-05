import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { FollowCheckResult, TargetUser } from '@shared/types';
import { EmptyState } from '../components/Shell';
import { describeError } from '../lib/errors';

interface Props {
  targets: TargetUser[];
  loggedIn: boolean;
  onRemoved: (target: TargetUser) => void;
}

const FOLLOW_LABELS: Record<FollowCheckResult, string> = {
  following: 'フォロー中',
  'not-following': '未フォロー',
  unknown: '不明',
};

export function TargetsTab({ targets, loggedIn, onRemoved }: Props): ReactElement {
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const [follow, setFollow] = useState<Record<string, FollowCheckResult>>({});
  const checked = useRef(new Set<string>());

  // 表示のたびに、まだ確認していない対象のフォロー状態を 1 回だけ取りに行く
  useEffect(() => {
    if (!loggedIn) {
      return;
    }
    for (const target of targets) {
      if (checked.current.has(target.userId)) {
        continue;
      }
      checked.current.add(target.userId);
      void window.api
        .checkFollow(target.userId)
        .then((result) => setFollow((prev) => ({ ...prev, [target.userId]: result })));
    }
  }, [targets, loggedIn]);

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
      checked.current.add(result.target.userId);
      setFollow((prev) => ({ ...prev, [result.target.userId]: result.follow }));
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
    checked.current.delete(target.userId);
    onRemoved(target);
  };

  const unknownCount = targets.filter((t) => follow[t.userId] === 'unknown').length;
  const notFollowing = targets.some((t) => follow[t.userId] === 'not-following');

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
            <span>フォロー</span>
            <span />
          </div>
          <div className="table-scroll">
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
                  <FollowBadge enabled={target.enabled} result={follow[target.userId]} />
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
      {unknownCount > 0 && (
        <p className="note" style={{ margin: 0 }}>
          一部の配信者はフォロー状態を確認できませんでした。録画の対象からは外れません。
        </p>
      )}
    </>
  );
}

function FollowBadge({
  enabled,
  result,
}: {
  enabled: boolean;
  result?: FollowCheckResult;
}): ReactElement {
  if (!enabled) {
    return <span className="badge badge-neutral">無効</span>;
  }
  if (!result) {
    return <span className="muted">…</span>;
  }
  const className =
    result === 'following'
      ? 'badge-ok'
      : result === 'not-following'
        ? 'badge-warn'
        : 'badge-neutral';
  return (
    <span
      className={`badge ${className}`}
      title={result === 'unknown' ? 'フォロー状態を確認できませんでした' : undefined}
    >
      {FOLLOW_LABELS[result]}
    </span>
  );
}
