import WebSocket from 'ws';
import type { HlsStreamInfo, StreamCookie } from '../../src/main/core/nico/watch-session';
import { DEFAULT_USER_AGENT } from '../../src/main/vendor/nico-client/internal/userAgent';
import { object } from './common';

export interface ProbeSession {
  stream?: HlsStreamInfo;
  viewUri?: string;
  summary: { opened: boolean; hasHls: boolean; hasComments: boolean; serverCodes: string[] };
  close: () => void;
}

// 本番の WatchSession はサーバー指示で再接続するため、初回応答だけを調べる接続は独立させる。
export function observeSession(
  url: string,
  cookie: string | undefined,
  signal: AbortSignal,
): Promise<ProbeSession> {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const socket = new WebSocket(url, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Origin: 'https://live.nicovideo.jp',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      handshakeTimeout: 15_000,
    });
    let seatTimer: NodeJS.Timeout | undefined;
    const result: ProbeSession = {
      summary: { opened: false, hasHls: false, hasComments: false, serverCodes: [] },
      close: () => {
        clearInterval(seatTimer);
        socket.terminate();
        finish();
        signal.removeEventListener('abort', result.close);
      },
    };
    const observationTimer = setTimeout(() => {
      code('OBSERVATION_TIMEOUT');
      if (socket.readyState === WebSocket.OPEN && (result.stream || result.viewUri)) finish();
      else result.close();
    }, 15_000);
    const finish = (): void => {
      clearTimeout(observationTimer);
      resolve(result);
    };
    const code = (value: unknown): void => {
      if (
        typeof value === 'string' &&
        /^[A-Z][A-Z0-9_]{1,63}$/.test(value) &&
        !result.summary.serverCodes.includes(value)
      )
        result.summary.serverCodes.push(value);
    };
    const send = (payload: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };
    const keepSeat = (seconds: number): void => {
      clearInterval(seatTimer);
      seatTimer = setInterval(() => send({ type: 'keepSeat' }), seconds * 1000);
    };
    signal.addEventListener('abort', result.close, { once: true });
    socket.on('open', () => {
      result.summary.opened = true;
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
      let message: Record<string, unknown>;
      try {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.from(raw as ArrayBuffer).toString('utf8');
        message = object(JSON.parse(text));
      } catch {
        code('INVALID_WS_MESSAGE');
        result.close();
        return;
      }
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
          const cookies: StreamCookie[] = [];
          for (const value of Array.isArray(data.cookies) ? data.cookies : []) {
            const item = object(value);
            if (
              typeof item.name === 'string' &&
              typeof item.value === 'string' &&
              typeof item.domain === 'string' &&
              typeof item.path === 'string'
            ) {
              cookies.push({
                name: item.name,
                value: item.value,
                domain: item.domain,
                path: item.path,
                secure: item.secure === true,
              });
            }
          }
          result.stream = {
            uri: data.uri,
            cookies,
            quality: typeof data.quality === 'string' ? data.quality : '',
            availableQualities: [],
            receivedAt: new Date(),
          };
          result.summary.hasHls = true;
          break;
        }
        case 'messageServer':
          if (typeof data.viewUri === 'string' && data.viewUri) {
            result.viewUri = data.viewUri;
            result.summary.hasComments = true;
          }
          break;
        case 'error':
          code(data.code);
          code('SERVER_ERROR');
          result.close();
          break;
        case 'disconnect':
          code(data.reason);
          code('SERVER_DISCONNECT');
          result.close();
          break;
        case 'reconnect':
          code('RECONNECT_REQUESTED');
          result.close();
          break;
      }
      if (result.summary.hasHls && result.summary.hasComments) finish();
    });
    socket.on('error', () => {
      code('SOCKET_ERROR');
      result.close();
    });
    socket.on('unexpected-response', (_request, response) => {
      code(`UPGRADE_HTTP_${response.statusCode ?? 0}`);
      response.resume();
      result.close();
    });
    socket.on('close', () => {
      clearInterval(seatTimer);
      signal.removeEventListener('abort', result.close);
      finish();
    });
  });
}
