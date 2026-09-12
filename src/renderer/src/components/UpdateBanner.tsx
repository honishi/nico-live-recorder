import { useState, type ReactElement } from 'react';
import type { UpdateStatus } from '@shared/types';
import { updateMessage } from '../lib/update-status';

interface Props {
  update: UpdateStatus;
  showToast: (message: string) => void;
}

export function UpdateBanner({ update, showToast }: Props): ReactElement | null {
  const [pending, setPending] = useState(false);
  if (!update.release) return null;

  // 表示後に録画が始まった場合は main 側の判定結果を案内する。
  const install = async (): Promise<void> => {
    setPending(true);
    try {
      const result = await window.api.installUpdate();
      if (result === 'busy') showToast('録画・取得の完了後に再起動してください');
      if (result === 'not-ready') showToast('更新の準備ができていません');
    } catch {
      showToast('更新を適用できませんでした');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="update-banner" role="status">
      <span>{updateMessage(update)}</span>
      {/* 更新操作は右側にまとめ、再起動ボタンをリリースページの左隣に置く。 */}
      <div className="update-banner-actions">
        {update.result === 'downloaded' && (
          <button
            className="btn btn-primary sm"
            disabled={pending || update.installBlocked}
            onClick={() => void install()}
          >
            再起動して更新
          </button>
        )}
        <button
          className="btn btn-secondary sm"
          onClick={() => {
            void window.api
              .openReleasePage()
              .catch(() => showToast('リリースページを開けませんでした'));
          }}
        >
          リリースページを開く
        </button>
      </div>
    </div>
  );
}
