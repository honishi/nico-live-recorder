import { parseArgs } from 'node:util';
import * as cheerio from 'cheerio';
import { DEFAULT_USER_AGENT } from '../../src/main/vendor/nico-client/internal/userAgent';
import { HlsForbiddenError, HlsHttpError } from '../../src/main/core/nico/hls';

export type ProbeMode = 'inspect' | 'video' | 'comments';

// CLI の入力は通信前に検証する。匿名モードでは環境変数が残っていても使わない。
export function parseOptions(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      anonymous: { type: 'boolean' },
      full: { type: 'boolean' },
      mode: { type: 'string', default: 'inspect' },
      label: { type: 'string', default: 'unlabelled' },
      out: { type: 'string', default: '.cache/timeshift-probe' },
      'media-seconds': { type: 'string' },
      timeout: { type: 'string' },
      'comment-limit': { type: 'string' },
      'view-at': { type: 'string', default: 'now' },
      'segment-threads': { type: 'string' },
      'view-pages': { type: 'string', default: '3' },
    },
  });
  if (values.help) return undefined;
  const input = positionals[0] ?? '';
  const match = /^(?:https?:\/\/live\d*\.nicovideo\.jp\/watch\/)?(lv\d+)(?:[?#].*)?$/.exec(input);
  if (!match || positionals.length !== 1)
    throw new Error('番組 ID または視聴 URL を一つ指定してください');
  if (!['inspect', 'video', 'comments'].includes(values.mode)) throw new Error('mode が不正です');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(values.label))
    throw new Error('label は英数字・ハイフン・下線で指定してください');
  if (!['now', 'beginning'].includes(values['view-at']) && !/^\d{1,19}$/.test(values['view-at']))
    throw new Error('view-at が不正です');
  const positive = (name: string, value: string, max: number): number => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > max)
      throw new Error(`${name} は 1〜${max} の整数で指定してください`);
    return number;
  };
  if (values.full && values.mode === 'inspect')
    throw new Error('full は video または comments 用です');
  if (values.full && values['media-seconds'] !== undefined)
    throw new Error('full と media-seconds は併用できません');
  if (values['segment-threads'] !== undefined && values.mode !== 'video')
    throw new Error('segment-threads は video 用です');
  const session = values.anonymous ? undefined : env.NICO_USER_SESSION?.trim();
  if (!values.anonymous && !session)
    throw new Error('NICO_USER_SESSION または --anonymous を指定してください');
  if (session && !/^[\x21-\x7e]+$/.test(session))
    throw new Error('セッションには Cookie の値だけを指定してください');
  if (session?.includes(';') || session?.startsWith('user_session='))
    throw new Error('セッションには Cookie の値だけを指定してください');
  return {
    segmentThreads:
      values['segment-threads'] === undefined
        ? undefined
        : positive('segment-threads', values['segment-threads'], 5),
    full: values.full ?? false,
    programId: match[1],
    mode: values.mode as ProbeMode,
    label: values.label,
    out: values.out,
    session,
    mediaSeconds: positive('media-seconds', values['media-seconds'] ?? '30', 300),
    timeout: positive('timeout', values.timeout ?? (values.full ? '1800' : '120'), 7200),
    commentLimit: positive(
      'comment-limit',
      values['comment-limit'] ?? (values.full ? '200000' : '1000'),
      values.full ? 200000 : 10000,
    ),
    viewAt: values['view-at'],
    viewPages: positive('view-pages', values['view-pages'], 10),
  };
}

export type ProbeOptions = NonNullable<ReturnType<typeof parseOptions>>;

export function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

// エラーの本文や URL は保存せず、原因を比較するための固定コードだけを出力する。
export class ProbeError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus?: number,
  ) {
    super(code);
  }
}

export function errorSummary(error: unknown): { code: string; httpStatus?: number } {
  if (error instanceof ProbeError) return { code: error.code, httpStatus: error.httpStatus };
  if (error instanceof HlsForbiddenError) return { code: 'HLS_HTTP_ERROR', httpStatus: 403 };
  if (error instanceof HlsHttpError) return { code: 'HLS_HTTP_ERROR', httpStatus: error.status };
  return { code: 'UNEXPECTED_ERROR' };
}

export async function checkedFetch(
  url: string,
  signal: AbortSignal,
  cookie?: string,
): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'user-agent': DEFAULT_USER_AGENT, ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProbeError('HTTP_ERROR', response.status);
  }
  return response;
}

// 認証情報を含む埋め込みデータはメモリ内だけで扱い、観測した項目だけ選んで返す。
export function parsePage(html: string) {
  const props = cheerio.load(html)('#embedded-data').attr('data-props');
  if (!props) throw new ProbeError('EMBEDDED_DATA_MISSING');
  const data = object(JSON.parse(props));
  const program = object(data.program);
  const site = object(data.site);
  const relive = object(site.relive);
  const user = object(data.user);
  const publication = object(object(data.programTimeshift).publication);
  const ws =
    typeof relive.webSocketUrl === 'string' && relive.webSocketUrl
      ? new URL(relive.webSocketUrl)
      : undefined;
  if (ws && ws.protocol !== 'wss:') throw new ProbeError('INVALID_WEBSOCKET_URL');
  if (ws && typeof site.frontendId === 'number')
    ws.searchParams.set('frontend_id', String(site.frontendId));
  const status =
    typeof program.status === 'string' && ['ENDED', 'ON_AIR', 'RELEASED'].includes(program.status)
      ? program.status
      : 'UNKNOWN';
  return {
    webSocketUrl: ws?.toString(),
    summary: {
      status,
      publication:
        typeof publication.status === 'string' &&
        ['Open', 'Closed', 'NotYet'].includes(publication.status)
          ? publication.status
          : 'unknown',
      // このフィールドが存在しない応答では、Cookie の有無から推測しない。
      loginObserved: typeof user.isLoggedIn === 'boolean' ? user.isLoggedIn : 'unknown',
      hasWebSocketUrl: Boolean(ws),
      timeshiftEndpoint: ws?.pathname.includes('timeshift') ?? false,
      beginTime: typeof program.beginTime === 'number' ? program.beginTime : undefined,
      endTime: typeof program.endTime === 'number' ? program.endTime : undefined,
    },
  };
}

// 失敗した工程も finally で計測し、レポートには URL や入力値を含めない。
export class ProbeTimings {
  readonly milliseconds: Record<string, number> = {};

  async measure<T>(stage: string, task: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await task();
    } finally {
      this.milliseconds[stage] =
        (this.milliseconds[stage] ?? 0) + Math.round(performance.now() - start);
    }
  }
}
