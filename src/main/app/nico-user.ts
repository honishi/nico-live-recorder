import { DEFAULT_USER_AGENT } from '../vendor/nico-client/internal/userAgent';
import type { FollowCheckResult } from '../../shared/types';

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
  if (!response.ok) {
    throw new Error(`ユーザー情報の取得に失敗しました (HTTP ${response.status})`);
  }
  const json = (await response.json()) as { data?: { nickname?: string } };
  const nickname = json.data?.nickname;
  if (!nickname) {
    throw new Error('ユーザーが見つかりませんでした');
  }
  return nickname;
}

/**
 * ログイン中のアカウントがそのユーザーをフォローしているか。
 * 非公開 API なので失敗したら unknown を返す
 */
export async function checkFollowing(
  userId: string,
  cookieHeader: string,
): Promise<FollowCheckResult> {
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
      await response.text().catch(() => '');
      return 'unknown';
    }
    const json = (await response.json()) as { data?: { following?: boolean } };
    if (typeof json.data?.following === 'boolean') {
      return json.data.following ? 'following' : 'not-following';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
