import WebSocket from 'ws';
import { test } from 'vitest';
import { verifyHttpRecovery, verifyWebSocketRecovery } from '../helpers/network-runtime.mjs';

test('不正圧縮・途中切断・中断の後もBrotli応答を読み取れる', verifyHttpRecovery);
test('内蔵WebSocketで送受信・PING/PONG・切断後の接続ができる', () =>
  verifyWebSocketRecovery(globalThis.WebSocket));
test('wsで送受信・PING/PONG・切断後の接続ができる', () => verifyWebSocketRecovery(WebSocket));
