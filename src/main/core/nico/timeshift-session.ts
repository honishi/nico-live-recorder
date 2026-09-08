import WebSocket from 'ws';
import type { HlsStreamInfo, StreamCookie } from './watch-session';
import { DEFAULT_USER_AGENT } from '../../vendor/nico-client/internal/userAgent';
import { object, TimeshiftError } from './timeshift-common';

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // HLS・コメントを別々に待つため、呼び出し側が待つ前の失敗も回収する。
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** 1回の有限取得に必要な接続だけを保持する。ライブの再接続処理とは独立させる。 */
export function openTimeshiftSession(
  url: string,
  cookies: Record<string, string> | undefined,
  outer: AbortSignal,
) {
  outer.throwIfAborted();
  const failure = new AbortController();
  const stream = pending<HlsStreamInfo>();
  const comments = pending<string>();
  const cookie = Object.entries(cookies ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
  const socket = new WebSocket(url, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Origin: 'https://live.nicovideo.jp',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    handshakeTimeout: 15_000,
  });
  let closed = false;
  let seat: NodeJS.Timeout | undefined;
  let streamTimer: NodeJS.Timeout | undefined;
  let commentTimer: NodeJS.Timeout | undefined;
  const connectTimer = setTimeout(() => fail(new TimeshiftError('CONNECT_TIMEOUT')), 15_000);
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(connectTimer);
    clearTimeout(streamTimer);
    clearTimeout(commentTimer);
    clearInterval(seat);
    outer.removeEventListener('abort', abort);
    stream.reject(new TimeshiftError('SESSION_CLOSED'));
    comments.reject(new TimeshiftError('SESSION_CLOSED'));
    socket.terminate();
  };
  const fail = (error: unknown): void => {
    if (closed) return;
    failure.abort(error);
    stream.reject(error);
    comments.reject(error);
    close();
  };
  const abort = (): void => fail(outer.reason);
  const send = (value: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };
  const keepSeat = (seconds: number): void => {
    clearInterval(seat);
    seat = setInterval(() => send({ type: 'keepSeat' }), seconds * 1000);
  };
  outer.addEventListener('abort', abort, { once: true });
  socket.on('open', () => {
    if (closed) return;
    clearTimeout(connectTimer);
    streamTimer = setTimeout(() => fail(new TimeshiftError('HLS_NOT_RECEIVED')), 15_000);
    commentTimer = setTimeout(
      () => comments.reject(new TimeshiftError('COMMENT_URI_NOT_RECEIVED')),
      15_000,
    );
    keepSeat(30);
    send({
      type: 'startWatching',
      data: {
        stream: { quality: 'abr', protocol: 'hls', latency: 'high', chasePlay: false },
        room: { protocol: 'webSocket', commentable: true },
        reconnect: false,
      },
    });
    send({ type: 'getAkashic', data: { chasePlay: false } });
  });
  socket.on('message', (raw) => {
    if (closed) return;
    try {
      const message = object(
        JSON.parse(
          Array.isArray(raw)
            ? Buffer.concat(raw).toString()
            : Buffer.from(raw as ArrayBuffer).toString(),
        ),
      );
      const data = object(message.data);
      switch (message.type) {
        case 'ping':
          send({ type: 'pong' });
          send({ type: 'keepSeat' });
          break;
        case 'seat': {
          const seconds = Number(data.keepIntervalSec);
          if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 300) keepSeat(seconds);
          break;
        }
        case 'stream': {
          if (data.protocol !== 'hls' || typeof data.uri !== 'string') break;
          const streamCookies: StreamCookie[] = [];
          for (const rawCookie of Array.isArray(data.cookies) ? data.cookies : []) {
            const item = object(rawCookie);
            if (
              typeof item.name === 'string' &&
              typeof item.value === 'string' &&
              typeof item.path === 'string' &&
              typeof item.domain === 'string'
            )
              streamCookies.push({
                name: item.name,
                value: item.value,
                path: item.path,
                domain: item.domain,
              });
          }
          clearTimeout(streamTimer);
          stream.resolve({
            uri: data.uri,
            cookies: streamCookies,
            quality: typeof data.quality === 'string' ? data.quality : '',
            availableQualities: [],
            receivedAt: new Date(),
          });
          break;
        }
        case 'messageServer':
          if (typeof data.viewUri === 'string' && data.viewUri) {
            clearTimeout(commentTimer);
            comments.resolve(data.viewUri);
          }
          break;
        case 'disconnect':
          if (data.reason !== 'END_PROGRAM') fail(new TimeshiftError('SERVER_DISCONNECT'));
          break;
        case 'reconnect':
          fail(new TimeshiftError('RECONNECT_REQUIRED'));
          break;
        case 'error':
          fail(new TimeshiftError('VIEWING_REJECTED'));
          break;
      }
    } catch {
      fail(new TimeshiftError('INVALID_WS_MESSAGE'));
    }
  });
  socket.on('error', () => fail(new TimeshiftError('SOCKET_ERROR')));
  socket.on('unexpected-response', (_request, response) => {
    response.resume();
    fail(new TimeshiftError('UPGRADE_FAILED', response.statusCode));
  });
  socket.on('close', () => fail(new TimeshiftError('SESSION_DISCONNECTED')));
  return {
    stream: stream.promise,
    comments: comments.promise,
    signal: AbortSignal.any([outer, failure.signal]),
    close,
  };
}
