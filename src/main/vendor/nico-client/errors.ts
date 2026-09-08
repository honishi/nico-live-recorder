import type { HttpError } from './internal/httpClient';

export class CommentViewStalledError extends Error {
  public readonly code = 'COMMENT_VIEW_STALLED' as const;

  constructor() {
    super(
      'コメントの取得位置が10分以上回復せず、10回以上停滞したため、コメント取得を停止しました。',
    );
    this.name = 'CommentViewStalledError';
  }
}

export class ViewUriNotReceivedError extends Error {
  public readonly code = 'VIEW_URI_NOT_RECEIVED' as const;

  constructor(message = 'WebSocket が viewUri を受信する前に切断されました。') {
    super(message);
    this.name = 'ViewUriNotReceivedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ViewUriTimeoutError extends Error {
  public readonly code = 'VIEW_URI_TIMEOUT' as const;

  constructor(timeoutMs: number) {
    super(`WebSocket 接続後 ${timeoutMs}ms 以内に messageServer を受信できませんでした。`);
    this.name = 'ViewUriTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UserNotFoundError extends Error {
  public readonly code = 'USER_NOT_FOUND' as const;
  // isRetryableNicoError が非リトライ対象と判定できるよう statusCode を持つ
  public readonly statusCode = 404;

  constructor(
    public readonly userId: string,
    public readonly url: string,
    public readonly originalError?: HttpError,
  ) {
    super(`ユーザー ${userId} の情報 (${url}) が見つかりませんでした。`);
    this.name = 'UserNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidUserApiResponseError extends Error {
  public readonly code = 'INVALID_USER_API_RESPONSE' as const;

  constructor(
    public readonly userId: string,
    public readonly url: string,
    detail: string,
  ) {
    super(`ユーザー ${userId} の情報 (${url}) の応答を解析できませんでした: ${detail}`);
    this.name = 'InvalidUserApiResponseError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
