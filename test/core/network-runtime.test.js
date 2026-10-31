import WebSocket from 'ws';
import { test } from 'vitest';
import { verifyHttpRecovery, verifyWebSocketRecovery } from '../helpers/network-runtime.mjs';
import {
  verifyHttpsRecovery,
  verifyWssRecovery,
  verifyUndiciHttp2Recovery,
  verifyUndiciHttpsRecovery,
} from '../helpers/tls-runtime.mjs';

test('不正圧縮・途中切断・中断の後もBrotli応答を読み取れる', verifyHttpRecovery);
test('内蔵WebSocketで送受信・PING/PONG・切断後の接続ができる', () =>
  verifyWebSocketRecovery(globalThis.WebSocket));
test('wsで送受信・PING/PONG・切断後の接続ができる', () => verifyWebSocketRecovery(WebSocket));
test('HTTPSの証明書拒否・TLS切断・中断後も正常な通信ができる', verifyHttpsRecovery);
test('内蔵WebSocketでWSSの証明書拒否・TLS切断後も通信を再開できる', () =>
  verifyWssRecovery(globalThis.WebSocket));
test('wsでWSSの証明書拒否・TLS切断後も通信を再開できる', () => verifyWssRecovery(WebSocket));
test(
  'npm UndiciがHTTP/2を交渉し、証明書拒否・TLS切断・RST_STREAM・中断から回復する',
  verifyUndiciHttp2Recovery,
);

test('npm Undiciの既定requestでHTTPSの拒否・切断・中断から回復する', verifyUndiciHttpsRecovery);
