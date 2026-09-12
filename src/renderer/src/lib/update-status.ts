import type { UpdateStatus } from '@shared/types';

/** 設定画面とバナーで、更新の取得状況を同じ言葉で案内する。 */
export function updateMessage(update: UpdateStatus): string {
  if (update.checking) return '更新を確認中…';
  switch (update.result) {
    case 'unchecked':
      return '更新はまだ確認していません';
    case 'current':
      return '新しいバージョンはありません';
    case 'downloading':
      return `v${update.release?.version ?? ''} をダウンロード中${update.progress === undefined ? '…' : ` (${update.progress}%)`}`;
    case 'downloaded':
      return update.installBlocked
        ? `v${update.release?.version ?? ''} の更新を準備しました。録画・取得の完了後に再起動できます`
        : `v${update.release?.version ?? ''} の更新を準備しました`;
    case 'installing':
      return '再起動して更新を適用しています…';
    case 'disabled':
      return '自動更新は macOS・Windows の配布版で利用できます';
    case 'unavailable':
      return '公開された更新情報を取得できません';
    case 'rate-limited':
      return '更新の取得が一時的に制限されています';
    case 'error':
      return '更新を取得できませんでした。時間をおいて再確認してください';
  }
}
