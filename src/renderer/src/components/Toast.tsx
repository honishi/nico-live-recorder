import { useEffect, useRef, type ReactElement } from 'react';

export interface ToastMessage {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface Props {
  toast?: ToastMessage;
  onDismiss: (id: number) => void;
}

const TOAST_MS = 5000;

/** 右下に 1 件だけ出す通知。5 秒で消え、ホバー中は消さない */
export function Toast({ toast, onDismiss }: Props): ReactElement | null {
  // ホバー中かどうかはイベントハンドラだけが更新する (再描画は不要)
  const hoveringRef = useRef(false);

  useEffect(() => {
    if (!toast) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      timer = setTimeout(() => {
        if (hoveringRef.current) {
          arm();
        } else {
          onDismiss(toast.id);
        }
      }, TOAST_MS);
    };
    arm();
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [toast, onDismiss]);

  if (!toast) {
    return null;
  }
  return (
    <div
      className="toast"
      onMouseEnter={() => {
        hoveringRef.current = true;
      }}
      onMouseLeave={() => {
        hoveringRef.current = false;
      }}
    >
      <span className="message ellipsis">{toast.text}</span>
      {toast.actionLabel && (
        <button
          className="link"
          onClick={() => {
            toast.onAction?.();
            onDismiss(toast.id);
          }}
        >
          {toast.actionLabel}
        </button>
      )}
    </div>
  );
}
