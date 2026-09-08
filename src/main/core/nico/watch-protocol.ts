import { asString } from '../util';

/** 視聴セッションが配る HLS 用 cookie。パス単位で同名の cookie が複数配られる */
export interface StreamCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  expires?: string;
}

/** WebSocket の `stream` メッセージで得られる HLS 配信情報 */
export interface HlsStreamInfo {
  uri: string;
  syncUri?: string;
  quality: string;
  availableQualities: string[];
  cookies: StreamCookie[];
  receivedAt: Date;
}

/** HLS応答を変換する。補完・不正値の扱いは既存の各セッションの方針を保つ。 */
export function parseStreamMessage(
  data: Record<string, unknown>,
  policy: 'live' | 'timeshift',
): HlsStreamInfo | undefined {
  if (data.protocol !== 'hls' || typeof data.uri !== 'string') return undefined;
  const cookies: StreamCookie[] = [];
  for (const raw of Array.isArray(data.cookies) ? data.cookies : []) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== 'string') continue;
    if (policy === 'timeshift') {
      // タイムシフトは4項目が文字列のCookieだけ採用し、省略値を補完しない。
      if (
        typeof item.value !== 'string' ||
        typeof item.path !== 'string' ||
        typeof item.domain !== 'string'
      )
        continue;
      cookies.push({ name: item.name, value: item.value, path: item.path, domain: item.domain });
    } else {
      // ライブは従来どおり既定のdomain/pathと文字列変換を用いる。
      cookies.push({
        name: item.name,
        value: asString(item.value),
        domain: asString(item.domain, 'nicovideo.jp'),
        path: asString(item.path, '/'),
        secure: item.secure === true,
        expires: typeof item.expires === 'string' ? item.expires : undefined,
      });
    }
  }
  const info: HlsStreamInfo = {
    uri: data.uri,
    cookies,
    quality: typeof data.quality === 'string' ? data.quality : '',
    availableQualities: [],
    receivedAt: new Date(),
  };
  // ライブだけが利用していた追加情報も、型変換を含めてそのまま維持する。
  if (policy === 'live') {
    info.quality = asString(data.quality);
    info.syncUri = typeof data.syncUri === 'string' ? data.syncUri : undefined;
    info.availableQualities = Array.isArray(data.availableQualities)
      ? data.availableQualities.map(String)
      : [];
  }
  return info;
}
