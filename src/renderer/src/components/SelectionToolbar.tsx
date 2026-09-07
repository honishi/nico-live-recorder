import type { ReactElement, ReactNode } from 'react';

interface Props {
  count: number;
  disabled: boolean;
  onClear: () => void;
  children: ReactNode;
}

/** 選択状態の表示と解除を共通化し、操作ボタンは呼び出し元で組み立てる */
export function SelectionToolbar({ count, disabled, onClear, children }: Props): ReactElement {
  return (
    <div className="selection-toolbar" role="group" aria-label="選択した配信者への操作">
      <span role="status">{count} 件選択中</span>
      <button className="link" disabled={disabled || count === 0} onClick={onClear}>
        選択を解除
      </button>
      <div className="selection-actions">{children}</div>
    </div>
  );
}
