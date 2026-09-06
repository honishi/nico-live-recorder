import { inspect } from 'node:util';
import { DEFAULT_USER_AGENT } from '../vendor/nico-client/internal/userAgent';
import { silentLogger, type Logger } from '../core/logger';
import { codedError, ERROR_CODES, type FollowCheckResult } from '../../shared/types';

const NICKNAME_API = 'https://api.live2.nicovideo.jp/api/v1/user/nickname';
const FOLLOW_STATUS_API = 'https://user-follow-api.nicovideo.jp/v1/user/followees/niconico-users';

/**
 * ユーザー ID の入力を正規化する。数字だけ、user/123 形式の URL、
 * co/ch から始まるものは対象外 (ユーザー配信のみ扱う)
 */
export function parseUserIdInput(input: string): string | undefined {
  const text = input.trim();
  if (/^\d+$/.test(text)) {
    return text;
  }
  const match = text.match(/nicovideo\.jp\/user\/(\d+)/) ?? text.match(/^user\/(\d+)$/);
  return match?.[1];
}

export async function resolveUserNickname(userId: string): Promise<string> {
  const response = await fetch(`${NICKNAME_API}?userId=${encodeURIComponent(userId)}`, {
    headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    await response.text().catch(() => '');
    throw codedError(ERROR_CODES.userNotFound);
  }
  if (!response.ok) {
    await response.text().catch(() => '');
    throw codedError(ERROR_CODES.network, `HTTP ${response.status}`);
  }
  const json = (await response.json()) as { data?: { nickname?: string } };
  const nickname = json.data?.nickname;
  if (!nickname) {
    throw codedError(ERROR_CODES.userNotFound);
  }
  return nickname;
}

/** 通信結果の詳細はメイン側だけで扱い、休止と再試行の判断に使う */
export interface FollowingResponse {
  result: FollowCheckResult;
  retryable?: boolean;
  retryAt?: number;
}

/** Retry-After の秒数・HTTP 日付を絶対時刻に変換する。不正な値は使わない */
export function parseFollowRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const text = value.trim();
  const seconds = /^\d+$/.test(text);
  if (!seconds && !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    return undefined;
  }
  const at = seconds ? now + Number(text) * 1000 : Date.parse(text);
  return Number.isSafeInteger(at) && at <= 8_640_000_000_000_000 && at > now ? at : undefined;
}

/**
 * ログイン中のアカウントがそのユーザーをフォローしているか。
 * 非公開 API なので失敗したら unknown を返す
 */
export async function checkFollowing(
  userId: string,
  cookieHeader: string,
  logger: Logger = silentLogger,
): Promise<FollowingResponse> {
  try {
    const response = await fetch(`${FOLLOW_STATUS_API}/${encodeURIComponent(userId)}.json`, {
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        accept: 'application/json',
        'x-frontend-id': '6',
        'x-frontend-version': '0',
        origin: 'https://www.nicovideo.jp',
        referer: 'https://www.nicovideo.jp/',
        cookie: cookieHeader,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // 本文や Cookie は記録せず、HTTP ステータスと再試行の目安だけを残す
      logger.debug(
        `[follow] user ${userId}: HTTP ${response.status}, retry-after=${response.headers.get('retry-after') ?? 'none'}`,
      );
      const retryAt = parseFollowRetryAfter(response.headers.get('retry-after'));
      await response.body?.cancel().catch(() => undefined);
      return {
        result: 'unknown',
        retryable: response.status === 429 || response.status >= 500,
        retryAt,
      };
    }

    // JSON の構文エラーには本文の断片が含まれるため、例外そのものはログに出さない
    let json: { data?: { following?: boolean } } | null;
    try {
      json = (await response.json()) as typeof json;
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      logger.debug(`[follow] user ${userId}: invalid JSON response`);
      return { result: 'unknown' };
    }
    if (typeof json?.data?.following === 'boolean') {
      return { result: json.data.following ? 'following' : 'not-following' };
    }
    logger.debug(`[follow] user ${userId}: invalid response (data.following is not boolean)`);
    return { result: 'unknown' };
  } catch (error) {
    // fetch failed の内側の cause (接続エラーなど) も残し、画面では従来どおり不明として扱う
    logger.debug(`[follow] user ${userId}: request failed`, inspect(error, { depth: 3 }));
    return { result: 'unknown', retryable: true };
  }
}
