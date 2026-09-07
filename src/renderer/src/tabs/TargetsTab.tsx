import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type {
  AppSettings,
  FollowCheckResult,
  FollowStatus,
  TargetRemovalResult,
  TargetUser,
} from '@shared/types';
import { FollowRequests, type FollowView } from '@shared/follow-requests';
import { EmptyState } from '../components/Shell';
import { describeError } from '../lib/errors';
import { SelectionToolbar } from '../components/SelectionToolbar';
import { useTargetSelection } from '../hooks/useTargetSelection';
import { useTargetDrag } from '../hooks/useTargetDrag';

interface Props {
  targets: TargetUser[];
  loggedIn: boolean;
  now: number;
  onRemoved: (result: TargetRemovalResult) => void;
  onReordered: (settings: AppSettings) => void;
}

const FOLLOW_LABELS: Record<FollowCheckResult, string> = {
  following: 'フォロー中',
  'not-following': '未フォロー',
  unknown: '不明',
};

export function TargetsTab({
  targets,
  loggedIn,
  now,
  onRemoved,
  onReordered,
}: Props): ReactElement {
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string>();
  const removingRef = useRef(false);
  const [reordering, setReordering] = useState(false);
  const [reorderError, setReorderError] = useState<string>();
  const reorderingRef = useRef(false);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selection = useTargetSelection(targets.map((target) => target.userId));
  const busy = pending !== undefined || removing || reordering;
  const [view, setView] = useState<FollowView>({ entries: {} });
  const requests = useRef<FollowRequests | undefined>(undefined);
  const scrollRoot = useRef<HTMLDivElement>(null);

  // 保存中は別の順序変更を開始せず、失敗したら元の一覧と選択をそのまま残す
  const move = async (userId: string, beforeUserId: string | null): Promise<void> => {
    if (pending || removingRef.current || reorderingRef.current) {
      return;
    }
    reorderingRef.current = true;
    setReordering(true);
    setReorderError(undefined);
    try {
      onReordered(await window.api.moveTarget(userId, beforeUserId));
    } catch (e) {
      setReorderError(describeError(e, '並び順を保存できませんでした。もう一度お試しください。'));
    } finally {
      reorderingRef.current = false;
      setReordering(false);
    }
  };
  const drag = useTargetDrag(scrollRoot, move);
  // 全選択の中間状態は DOM のプロパティで設定する
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selection.selectedIds.size > 0 && selection.selectedIds.size < targets.length;
    }
  }, [selection.selectedIds.size, targets.length]);
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
    if (!value || pending || removingRef.current || reorderingRef.current) {
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

  const remove = async (userIds: string[], confirm = true): Promise<void> => {
    if (userIds.length === 0 || pending || removingRef.current || reorderingRef.current) {
      return;
    }
    removingRef.current = true;
    setRemoving(true);
    setRemoveError(undefined);
    try {
      const result = await window.api.removeTargets(userIds, confirm);
      if (result) {
        for (const target of result.removed) {
          requests.current?.setVisible(target.userId, false);
        }
        onRemoved(result);
      }
    } catch (e) {
      setRemoveError(describeError(e, '削除できませんでした。もう一度お試しください。'));
    } finally {
      removingRef.current = false;
      setRemoving(false);
    }
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
            disabled={busy}
          />
          <button className="btn btn-primary" disabled={busy || !input.trim()}>
            {pending ? '追加中…' : '追加'}
          </button>
        </div>
        {error && <span className="field-error">{error}</span>}
      </form>

      {targets.length > 0 && (
        <SelectionToolbar
          count={selection.selectedIds.size}
          disabled={busy}
          onClear={selection.clear}
        >
          <button
            className="btn"
            disabled={busy || selection.selectedIds.size === 0}
            onClick={() => void remove([...selection.selectedIds])}
          >
            {removing ? '削除中…' : '削除'}
          </button>
        </SelectionToolbar>
      )}
      {removeError && (
        <p className="field-error" role="alert">
          {removeError}
        </p>
      )}
      {reorderError && (
        <p className="field-error" role="alert">
          {reorderError}
        </p>
      )}

      {targets.length === 0 && !pending ? (
        <EmptyState
          title="録画対象がまだありません"
          description="ニコニコでフォローしている配信者の ID を上の欄に入れて追加します。"
        />
      ) : (
        <div className="table grow">
          <div className="table-row head cols-targets">
            <span aria-hidden="true" />
            <span>
              <input
                ref={selectAllRef}
                type="checkbox"
                className="checkbox"
                aria-label="すべての配信者を選択"
                checked={targets.length > 0 && selection.selectedIds.size === targets.length}
                disabled={busy || targets.length === 0}
                onChange={selection.toggleAll}
              />
            </span>
            <span>名前</span>
            <span>ユーザー ID</span>
            <span>有効</span>
            <span>フォロー状態</span>
            <span />
          </div>
          <div
            className="table-scroll"
            ref={scrollRoot}
            onDragOver={drag.over}
            onDragLeave={drag.leave}
            onDrop={drag.drop}
          >
            {pending && (
              <div className="table-row cols-targets dim">
                <span />
                <span />
                <span>解決中…</span>
                <span className="mono" style={{ fontSize: 'var(--fs-sub)' }}>
                  {pending}
                </span>
                <span>
                  <input
                    type="checkbox"
                    className="checkbox"
                    aria-label="追加する配信者の自動録画"
                    checked
                    disabled
                  />
                </span>
                <span>—</span>
                <span />
              </div>
            )}
            {targets.map((target, index) => (
              <div
                key={target.userId}
                data-target-id={target.userId}
                data-follow-user-id={target.enabled ? target.userId : undefined}
                className={`table-row cols-targets ${target.enabled ? '' : 'dim'} ${selection.selectedIds.has(target.userId) ? 'selected' : ''} ${flash === target.userId ? 'flash' : ''} ${drag.draggedId === target.userId ? 'dragging' : ''} ${drag.beforeId === target.userId ? 'drop-before' : ''} ${drag.beforeId === null && index === targets.length - 1 ? 'drop-after' : ''}`}
              >
                <span>
                  <button
                    type="button"
                    className="drag-handle"
                    draggable={!busy}
                    disabled={busy || targets.length < 2}
                    aria-label={`${target.name} (${target.userId}) を並び替え`}
                    title="ドラッグして並び替え（Alt + ↑ / ↓ でも移動できます）"
                    onDragStart={(event) => drag.start(event, target.userId)}
                    onDragEnd={drag.end}
                    onKeyDown={(event) => {
                      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown'))
                        return;
                      event.preventDefault();
                      if (event.key === 'ArrowUp' && index > 0)
                        void move(target.userId, targets[index - 1].userId);
                      if (event.key === 'ArrowDown' && index < targets.length - 1)
                        void move(target.userId, targets[index + 2]?.userId ?? null);
                    }}
                  >
                    <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
                      <path
                        d="M3 3h0m6 0h0M3 8h0m6 0h0M3 13h0m6 0h0"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </span>
                <span>
                  <input
                    type="checkbox"
                    className="checkbox"
                    aria-label={`${target.name} (${target.userId}) を選択`}
                    checked={selection.selectedIds.has(target.userId)}
                    disabled={busy}
                    onChange={() => selection.toggle(target.userId)}
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
                  <input
                    type="checkbox"
                    className="checkbox"
                    aria-label={`${target.name} (${target.userId}) の自動録画を有効にする`}
                    checked={target.enabled}
                    disabled={busy}
                    onChange={() =>
                      void window.api.setTargetEnabled(target.userId, !target.enabled)
                    }
                  />
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
                  <button
                    className="link quiet hover-only"
                    disabled={busy}
                    onClick={() => void remove([target.userId], false)}
                  >
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
