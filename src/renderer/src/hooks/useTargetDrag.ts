import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react';

/** ドラッグは移動先の表示だけを行い、ドロップ時に一度だけ順序を保存する */
export function useTargetDrag(
  rootRef: RefObject<HTMLDivElement | null>,
  onMove: (userId: string, beforeUserId: string | null) => Promise<void>,
): {
  draggedId: string | undefined;
  beforeId: string | null | undefined;
  start: (event: DragEvent<HTMLElement>, userId: string) => void;
  over: (event: DragEvent<HTMLDivElement>) => void;
  leave: (event: DragEvent<HTMLDivElement>) => void;
  drop: (event: DragEvent<HTMLDivElement>) => void;
  end: () => void;
} {
  const [draggedId, setDraggedId] = useState<string>();
  const [beforeId, setBeforeId] = useState<string | null>();
  const source = useRef<string | undefined>(undefined);
  const pointerY = useRef<number | undefined>(undefined);
  const frame = useRef(0);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // 行の中央より上ならその直前、最終行より下なら末尾を挿入先にする
  const destination = (clientY: number): string | null => {
    const rows = rootRef.current?.querySelectorAll<HTMLElement>('[data-target-id]') ?? [];
    for (const row of rows) {
      if (row.dataset.targetId === source.current) {
        continue;
      }
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return row.dataset.targetId!;
      }
    }
    return null;
  };

  // 上下端に保持している間はスクロールを続け、画面外の行へも移動できる
  const scroll = (): void => {
    const root = rootRef.current;
    const y = pointerY.current;
    if (root && y !== undefined) {
      const rect = root.getBoundingClientRect();
      const edge = 40;
      let speed = 0;
      if (y < rect.top + edge) {
        speed = -Math.min(10, (rect.top + edge - y) / 4);
      } else if (y > rect.bottom - edge) {
        speed = Math.min(10, (y - rect.bottom + edge) / 4);
      }
      root.scrollTop += speed;
      setBeforeId(destination(y));
    }
    frame.current = requestAnimationFrame(scroll);
  };

  const end = (): void => {
    cancelAnimationFrame(frame.current);
    source.current = undefined;
    pointerY.current = undefined;
    setDraggedId(undefined);
    setBeforeId(undefined);
  };

  return {
    draggedId,
    beforeId,
    start: (event, userId) => {
      source.current = userId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', userId);
      const row = event.currentTarget.closest<HTMLElement>('[data-target-id]');
      if (row) {
        const rect = row.getBoundingClientRect();
        event.dataTransfer.setDragImage(row, event.clientX - rect.left, event.clientY - rect.top);
      }
      setDraggedId(userId);
      frame.current = requestAnimationFrame(scroll);
    },
    over: (event) => {
      // アプリ外からのファイルや文字列のドラッグは並び替えとして扱わない
      if (source.current === undefined) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      pointerY.current = event.clientY;
      setBeforeId(destination(event.clientY));
    },
    leave: (event) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      ) {
        pointerY.current = undefined;
        setBeforeId(undefined);
      }
    },
    drop: (event) => {
      const userId = source.current;
      if (userId === undefined) {
        return;
      }
      event.preventDefault();
      const beforeUserId = destination(event.clientY);
      end();
      void onMove(userId, beforeUserId);
    },
    end,
  };
}
