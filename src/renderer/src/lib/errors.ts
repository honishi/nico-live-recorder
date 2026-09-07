import { ERROR_CODES, parseErrorCode } from '@shared/types';

/** main が投げた失敗を、入力欄の直下に出す文言にする */
export function describeError(
  error: unknown,
  fallback: string,
  invalidInputMessage = 'ユーザー ID か https://www.nicovideo.jp/user/… の形式で入力してください',
): string {
  const message = error instanceof Error ? error.message : String(error);
  switch (parseErrorCode(message)) {
    case ERROR_CODES.invalidInput:
      return invalidInputMessage;
    case ERROR_CODES.userNotFound:
      return 'このユーザー ID は見つかりませんでした';
    case ERROR_CODES.invalidProgram:
      return 'lv から始まる ID か視聴ページの URL を入力してください';
    case ERROR_CODES.programUnavailable:
      return 'この放送は取得できませんでした (終了済みか非公開の可能性があります)';
    case ERROR_CODES.network:
      return 'ニコニコに接続できませんでした。しばらくしてからやり直してください';
    default:
      return fallback;
  }
}
