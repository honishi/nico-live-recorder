import { DEFAULT_USER_AGENT } from '../../vendor/nico-client/internal/userAgent';
export function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

// エラーの本文や URL は保存せず、原因を比較するための固定コードだけを出力する。
export class TimeshiftError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus?: number,
  ) {
    super(code);
  }
}

export function timeshiftErrorText(error: unknown): string {
  if (error instanceof TimeshiftError)
    return `タイムシフト: ${error.code}${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ''}`;
  return 'タイムシフト: 取得または保存に失敗しました';
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
    throw new TimeshiftError('HTTP_ERROR', response.status);
  }
  return response;
}
