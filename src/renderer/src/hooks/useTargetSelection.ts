import { useState } from 'react';

/** 選択はタブ内だけで保持し、設定の再取得では維持、対象の削除では解除する */
export function useTargetSelection(userIds: string[]): {
  selectedIds: Set<string>;
  toggle: (userId: string) => void;
  toggleAll: () => void;
  clear: () => void;
} {
  const idsKey = JSON.stringify(userIds);
  const [previousIdsKey, setPreviousIdsKey] = useState(idsKey);
  const [selectedIds, setSelectedIds] = useState(new Set<string>());

  // 対象が消えた直後に選択も取り除き、取り消しで戻っても再選択しない
  if (previousIdsKey !== idsKey) {
    setPreviousIdsKey(idsKey);
    const available = new Set(userIds);
    setSelectedIds(new Set([...selectedIds].filter((id) => available.has(id))));
  }

  const toggle = (userId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  return {
    selectedIds,
    toggle,
    toggleAll: () =>
      setSelectedIds(selectedIds.size === userIds.length ? new Set() : new Set(userIds)),
    clear: () => setSelectedIds(new Set()),
  };
}
