import { DEFAULT_USER_AGENT } from '../../vendor/nico-client/internal/userAgent';
import { asString } from '../util';

/** フォロー中の放送一覧 API (要ログイン) から得られる放送 */
export interface FollowingProgram {
  id: string;
  title: string;
  watchPageUrl: string;
  providerId?: string;
  providerName?: string;
  providerIcon?: string;
  socialGroupId?: string;
  socialGroupName?: string;
  beginAt?: Date;
  isFollowerOnly: boolean;
}

const FOLLOW_ONAIR_URL =
  'https://live.nicovideo.jp/front/api/pages/follow/v1/programs?status=onair&offset=0';

export class NotAuthenticatedError extends Error {
  constructor(status: number) {
    super(`フォロー中番組 API が認証エラーを返しました (HTTP ${status})`);
    this.name = 'NotAuthenticatedError';
  }
}

/**
 * chrome-nico-alert の NiconamaApi.getFollowingPrograms と同じ API を叩く。
 * push が届かなかった場合の取りこぼし防止 (30 秒ポーリング) に使う
 */
export async function fetchFollowingOnAirPrograms(
  cookieHeader: string,
  options: { userAgent?: string; signal?: AbortSignal } = {},
): Promise<FollowingProgram[]> {
  const response = await fetch(FOLLOW_ONAIR_URL, {
    headers: {
      accept: 'application/json',
      'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
      cookie: cookieHeader,
    },
    signal: options.signal ?? AbortSignal.timeout(20_000),
    redirect: 'manual',
  });
  if (response.status === 401 || response.status === 403 || response.status >= 300) {
    await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403 || response.status === 302) {
      throw new NotAuthenticatedError(response.status);
    }
    throw new Error(`フォロー中番組 API の取得に失敗しました (HTTP ${response.status})`);
  }
  const json = (await response.json()) as { data?: { programs?: unknown[] } };
  const programs = Array.isArray(json.data?.programs) ? json.data.programs : [];
  return programs.map(toFollowingProgram).filter((p): p is FollowingProgram => p !== undefined);
}

function toFollowingProgram(raw: unknown): FollowingProgram | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const program = raw as Record<string, unknown>;
  const id = typeof program['id'] === 'string' ? program['id'] : undefined;
  if (!id) {
    return undefined;
  }
  const provider = (program['programProvider'] ?? {}) as Record<string, unknown>;
  const socialGroup = (program['socialGroup'] ?? {}) as Record<string, unknown>;
  const beginAtRaw = program['beginAt'];
  const beginAt =
    typeof beginAtRaw === 'number'
      ? new Date(beginAtRaw)
      : typeof beginAtRaw === 'string'
        ? new Date(beginAtRaw)
        : undefined;
  return {
    id,
    title: asString(program['title']),
    watchPageUrl:
      typeof program['watchPageUrl'] === 'string'
        ? program['watchPageUrl']
        : `https://live.nicovideo.jp/watch/${id}`,
    providerId: asString(provider['id']) || undefined,
    providerName: typeof provider['name'] === 'string' ? provider['name'] : undefined,
    providerIcon: typeof provider['icon'] === 'string' ? provider['icon'] : undefined,
    socialGroupId: asString(socialGroup['id']) || undefined,
    socialGroupName: typeof socialGroup['name'] === 'string' ? socialGroup['name'] : undefined,
    beginAt: beginAt && !Number.isNaN(beginAt.getTime()) ? beginAt : undefined,
    isFollowerOnly: program['isFollowerOnly'] === true,
  };
}
