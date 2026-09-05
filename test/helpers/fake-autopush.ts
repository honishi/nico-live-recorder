import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { rawToString } from './fake-watch-server';

export interface FakeAutoPush {
  url: string;
  uaid: string;
  /** register で払い出したチャネル (channelId → 鍵の有無) */
  channels: { channelId: string; key?: string }[];
  /** 受信した hello メッセージ */
  hellos: Record<string, unknown>[];
  acks: Record<string, unknown>[];
  /** 通知を最新の接続に送る */
  notify(channelId: string, data: string): void;
  /** 最新の接続を close フレーム無しで切る (サーバー側の異常切断を真似る) */
  drop(): void;
  /** 次の HELLO 応答を保留し、返した関数で送信を再開する */
  holdNextHello(): () => void;
  close(): Promise<void>;
}

/**
 * Mozilla AutoPush の WebSocket プロトコルを最小限に真似るサーバー
 * (hello / register / unregister / ack / ping)
 */
export async function startFakeAutoPush(): Promise<FakeAutoPush> {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const port = (wss.address() as AddressInfo).port;
  const uaid = crypto.randomUUID();
  const channels: FakeAutoPush['channels'] = [];
  const hellos: Record<string, unknown>[] = [];
  const acks: Record<string, unknown>[] = [];
  let latest: WebSocket | undefined;
  let nextHelloResponse: Promise<void> | undefined;

  wss.on('connection', (socket) => {
    latest = socket;
    socket.on('message', (raw: RawData) => {
      const message = JSON.parse(rawToString(raw)) as Record<string, unknown>;
      switch (message['messageType']) {
        case 'hello': {
          hellos.push(message);
          // 接続済みでも HELLO 応答は未処理、という順序をテストから作れるようにする。
          const sendResponse = (): void => {
            socket.send(
              JSON.stringify({ messageType: 'hello', status: 200, uaid, use_webpush: true }),
            );
          };
          const responseGate = nextHelloResponse;
          nextHelloResponse = undefined;
          if (responseGate) {
            void responseGate.then(sendResponse);
          } else {
            sendResponse();
          }
          break;
        }
        case 'register': {
          const channelId = String(message['channelID']);
          channels.push({ channelId, key: message['key'] as string | undefined });
          socket.send(
            JSON.stringify({
              messageType: 'register',
              status: 200,
              channelID: channelId,
              pushEndpoint: `https://push.example/wpush/${channelId}`,
            }),
          );
          break;
        }
        case 'ack':
          acks.push(message);
          break;
        case undefined:
          // ping ({}) には pong ({}) を返す
          socket.send('{}');
          break;
        default:
          break;
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    uaid,
    channels,
    hellos,
    acks,
    notify: (channelId, data) => {
      latest?.send(
        JSON.stringify({ messageType: 'notification', channelID: channelId, version: 'v1', data }),
      );
    },
    drop: () => latest?.terminate(),
    holdNextHello: () => {
      let release!: () => void;
      nextHelloResponse = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function base64UrlDecode(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * RFC 8291 (aes128gcm) で通知本文を暗号化し、AutoPush の data 形式 (base64url) にする。
 * 復号側 (web-push-crypto.ts) と対になる、送信側の処理
 */
export function encryptWebPush(
  plaintext: string,
  subscriber: { publicKey: string; authSecret: string },
): string {
  const uaPublic = base64UrlDecode(subscriber.publicKey);
  const authSecret = base64UrlDecode(subscriber.authSecret);
  const sender = crypto.createECDH('prime256v1');
  sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const sharedSecret = sender.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);

  const prkInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, prkInfo, 32));
  const cek = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const padded = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([0x02])]);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  const header = Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic]);
  return base64UrlEncode(Buffer.concat([header, ciphertext]));
}
