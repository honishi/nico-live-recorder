import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

export interface WatchServerOptions {
  /** startWatching を受けたときに返す stream メッセージの data */
  streamData: (connectionIndex: number) => Record<string, unknown>;
  keepIntervalSec?: number;
}

export interface FakeWatchServer {
  url: string;
  /** 接続ごとに受信したメッセージ (JSON を parse したもの) */
  connections: { url: string; received: Record<string, unknown>[]; socket: WebSocket }[];
  send(index: number, message: unknown): void;
  close(): Promise<void>;
}

/**
 * ニコ生の視聴 WebSocket (wsapi/v2/watch) を最小限に真似るサーバー。
 * startWatching に seat / stream / messageServer を返し、それ以外は記録するだけ
 */
export async function startFakeWatchServer(options: WatchServerOptions): Promise<FakeWatchServer> {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const port = (wss.address() as AddressInfo).port;
  const connections: FakeWatchServer['connections'] = [];

  wss.on('connection', (socket, request) => {
    const index = connections.length;
    const entry = { url: request.url ?? '', received: [] as Record<string, unknown>[], socket };
    connections.push(entry);
    socket.on('message', (raw: RawData) => {
      const message = JSON.parse(rawToString(raw)) as Record<string, unknown>;
      entry.received.push(message);
      if (message['type'] === 'startWatching') {
        socket.send(
          JSON.stringify({
            type: 'seat',
            data: { keepIntervalSec: options.keepIntervalSec ?? 30 },
          }),
        );
        socket.send(JSON.stringify({ type: 'stream', data: options.streamData(index) }));
        socket.send(
          JSON.stringify({
            type: 'messageServer',
            data: { viewUri: 'https://mpn.example/view', vposBaseTime: '2026-09-04T00:00:00Z' },
          }),
        );
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/watch?audience_token=t1`,
    connections,
    send: (index, message) => connections[index]?.socket.send(JSON.stringify(message)),
    close: async () => {
      for (const c of connections) {
        c.socket.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** 条件が満たされるまで短い間隔で待つ */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function rawToString(raw: RawData): string {
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  return Buffer.from(raw as ArrayBuffer).toString('utf8');
}
