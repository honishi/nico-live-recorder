import { EventEmitter } from 'node:events';
import { openTimeshiftSession } from '../../../src/main/core/nico/timeshift-session';

// タイマーを手動で進め、接続順序と期限を実時間に依存せず検証する。
const sockets = vi.hoisted(
  () =>
    [] as {
      emit(name: string, ...args: unknown[]): boolean;
      sent: object[];
      terminated: boolean;
    }[],
);
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent: object[] = [];
    terminated = false;
    constructor() {
      super();
      sockets.push(this);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data) as object);
    }
    terminate() {
      this.terminated = true;
      this.emit('close');
    }
  },
}));
beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});
function begin() {
  const controller = new AbortController();
  const session = openTimeshiftSession(
    'wss://example.test/view',
    { user_session: 'secret' },
    controller.signal,
  );
  const socket = sockets[0];
  const send = (type: string, data: object = {}) =>
    socket.emit('message', Buffer.from(JSON.stringify({ type, data })));
  return { controller, session, socket, send };
}

test('HLSが先に届けばコメントを待たず利用でき、終了通知だけでは中止しない', async () => {
  const { session, socket, send } = begin();
  socket.emit('open');
  send('stream', {
    protocol: 'hls',
    uri: 'https://example.test/master',
    cookies: [{ name: 's', value: 'v', path: '/', domain: 'example.test' }],
  });
  expect(await session.stream).toMatchObject({
    uri: 'https://example.test/master',
    cookies: [{ name: 's', value: 'v' }],
  });
  send('disconnect', { reason: 'END_PROGRAM' });
  expect(session.signal.aborted).toBe(false);
  send('messageServer', { viewUri: 'https://example.test/comments' });
  expect(await session.comments).toBe('https://example.test/comments');
  expect(socket.sent).toContainEqual({ type: 'getAkashic', data: { chasePlay: false } });
  session.close();
  expect(socket.terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('コメントURIの期限切れだけならHLSの取得は継続できる', async () => {
  const { session, socket, send } = begin();
  socket.emit('open');
  send('stream', { protocol: 'hls', uri: 'https://example.test/master' });
  await session.stream;
  const rejected = expect(session.comments).rejects.toThrow('COMMENT_URI_NOT_RECEIVED');
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(session.signal.aborted).toBe(false);
  session.close();
});

test.each(['connecting', 'stream'] as const)(
  '%s の期限切れで待機と接続を終了する',
  async (phase) => {
    const { session, socket } = begin();
    if (phase === 'stream') socket.emit('open');
    const rejected = expect(session.stream).rejects.toThrow(
      phase === 'stream' ? 'HLS_NOT_RECEIVED' : 'CONNECT_TIMEOUT',
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(session.signal.aborted).toBe(true);
    expect(socket.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each(['reconnect', 'error', 'close', 'abort'] as const)(
  '%s で未完了の要求を停止し再接続しない',
  async (reason) => {
    const { session, socket, send, controller } = begin();
    socket.emit('open');
    send('stream', { protocol: 'hls', uri: 'https://example.test/master' });
    await session.stream;
    if (reason === 'close') socket.emit('close');
    else if (reason === 'abort') controller.abort();
    else send(reason);
    await expect(session.comments).rejects.toThrow();
    expect(session.signal.aborted).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);
