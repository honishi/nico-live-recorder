import { DEFAULT_USER_AGENT } from '../../vendor/nico-client/internal/userAgent';
import { TimeshiftError } from './timeshift-common';

/** ヘッダー待ちと本文の無通信時間を制限し、受信が進む低速回線を打ち切らない。 */
export async function fetchTimeshiftBytes(
  url: string,
  signal: AbortSignal,
  options: {
    cookie?: string;
    maxBytes: number;
    limitCode: string;
    onBytes?: (size: number) => void;
  },
): Promise<Buffer> {
  const timeout = new AbortController();
  const work = AbortSignal.any([signal, timeout.signal]);
  let timer: NodeJS.Timeout;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () => timeout.abort(new DOMException('request timed out', 'TimeoutError')),
      20_000,
    );
  };
  arm();
  try {
    work.throwIfAborted();
    const response = await fetch(url, {
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      signal: work,
    });
    work.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel();
      throw new TimeshiftError('HTTP_ERROR', response.status);
    }
    if (!response.body) throw new TimeshiftError('MEDIA_BODY_MISSING');
    arm();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of response.body) {
      work.throwIfAborted();
      const chunk = Buffer.from(raw as Uint8Array);
      if (chunk.length) arm();
      size += chunk.length;
      options.onBytes?.(chunk.length);
      if (size > options.maxBytes) throw new TimeshiftError(options.limitCode);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    // 本文の中断がAbortErrorになっても、呼び出し元では期限切れと停止を判別できるようにする。
    if (work.aborted) throw work.reason;
    throw error;
  } finally {
    clearTimeout(timer!);
  }
}
