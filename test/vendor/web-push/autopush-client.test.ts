import { AutoPushClient } from '../../../src/main/vendor/web-push/autopush-client';
import { setPushLogger } from '../../../src/main/vendor/web-push/push-diagnostics';

/** ネットワークと実時間を使わず、ソケットのイベント順序を制御する。 */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '', wasClean: false });
  }
  hello(uaid: string): void {
    this.onmessage?.({ data: JSON.stringify({ messageType: 'hello', status: 200, uaid }) });
  }
  notifyCanary(): void {
    this.onmessage?.({
      data: JSON.stringify({ messageType: 'notification', channelID: 'canary', version: 'v1' }),
    });
  }
  pong(): void {
    this.onmessage?.({ data: '{}' });
  }
}

let client: AutoPushClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.instances = [];
  setPushLogger({ debug() {}, info() {}, warn() {}, error() {} });
  client = new AutoPushClient('ws://test.invalid');
});
afterEach(() => {
  client.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each([false, true])(
  'リスナーが例外を投げても接続・再接続・停止と後続通知を続ける (ログ例外=%s)',
  async (logThrows) => {
    const report = vi.fn(() => {
      if (logThrows) throw new Error('logger failed');
    });
    setPushLogger({ debug() {}, info() {}, warn() {}, error: report });
    client.onStateChanged(() => {
      throw new Error('listener failed');
    });
    const states: boolean[] = [];
    client.onStateChanged(() => states.push(client.isConnectionOpen()));
    const connecting = client.connect();
    expect(() => FakeSocket.instances[0].open()).not.toThrow();
    await connecting;
    expect(states).toEqual([true]);
    // close の通知が失敗しても、1秒後の再接続まで進む。
    expect(() => FakeSocket.instances[0].drop()).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(() => FakeSocket.instances[1].open()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(() => client.disconnect()).not.toThrow();
    expect(states).toEqual([true, false, true, false]);
    expect(report).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.instances).toHaveLength(2);
  },
);

test('ログ出力なしで切断・再接続を通知し、errorとcloseが続いても重複しない', async () => {
  const states: boolean[] = [];
  client.onStateChanged(() => states.push(client.isConnectionOpen()));
  const connecting = client.connect();
  const first = FakeSocket.instances[0];
  first.open();
  await connecting;
  first.onerror?.(new Error('connection lost'));
  first.drop();
  expect(states).toEqual([true, false]);
  await vi.advanceTimersByTimeAsync(1_000);
  FakeSocket.instances[1].open();
  await vi.advanceTimersByTimeAsync(0);
  expect(states).toEqual([true, false, true]);
  client.disconnect();
  first.drop();
  expect(states).toEqual([true, false, true, false]);
});

test('強制再接続と購読修復を通知し、古いソケットと解除済みの購読者を無視する', async () => {
  const changed = vi.fn();
  const unsubscribe = client.onStateChanged(changed);
  const connecting = client.connect();
  const first = FakeSocket.instances[0];
  first.open();
  await connecting;
  const staleClose = first.onclose;
  client.restartSession();
  expect(changed).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1_000);
  const second = FakeSocket.instances[1];
  second.open();
  await vi.advanceTimersByTimeAsync(0);
  staleClose?.({ code: 1006, reason: '', wasClean: false });
  expect(client.isConnectionOpen()).toBe(true);
  expect(changed).toHaveBeenCalledTimes(3);
  const hello = client.sendHello('saved', ['channel']);
  second.hello('replacement');
  await hello;
  expect(client.isSubscriptionRepairRequired()).toBe(true);
  expect(changed).toHaveBeenCalledTimes(4);
  unsubscribe();
  client.disconnect();
  expect(changed).toHaveBeenCalledTimes(4);
});

describe('Canary probe の連続失敗ログ', () => {
  let socket: FakeSocket;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(async () => {
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
    setPushLogger(logger);
    const connecting = client.connect();
    socket = FakeSocket.instances[0];
    socket.open();
    await connecting;
    const hello = client.sendHello('saved', ['canary']);
    socket.hello('saved');
    await hello;
    client.configureCanaryProbe('canary', 'https://test.invalid/canary');
  });

  // WebSocket 自体は生きている状態で、1分ごとの probe だけを進める。
  async function nextProbe(delayMs = 60_000): Promise<void> {
    socket.pong();
    await vi.advanceTimersByTimeAsync(delayMs);
  }

  test.each(['network', 'http', 'timeout'] as const)(
    '単発の失敗と成功を繰り返しても警告しない (%s)',
    async (kind) => {
      for (let i = 0; i < 2; i += 1) {
        if (kind === 'network') fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
        if (kind === 'http') fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));
        // タイムアウトを進めた分、次の定期実行までの待ち時間を短くする。
        await nextProbe(kind === 'timeout' && i > 0 ? 50_000 : 60_000);
        if (kind === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
        const expectedMessage = {
          network: 'POST failed',
          http: 'POST rejected',
          timeout: 'unanswered',
        }[kind];
        expect(
          logger.debug.mock.calls.some(([message]) => String(message).includes(expectedMessage)),
        ).toBe(true);
        // 次の通知が届けば、前回の失敗を持ち越さない。
        if (kind !== 'timeout') await nextProbe();
        socket.notifyCanary();
      }
    },
  );

  test('異なる失敗も連続2回で一度だけ警告し、受信成功後は数え直す', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await nextProbe();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));
    await nextProbe();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      '[AutoPush] Canary probe failed 2 consecutive times:',
      '[AutoPush] Canary probe POST rejected, status:',
      502,
    );
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await nextProbe();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(1);

    await nextProbe();
    socket.notifyCanary();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await nextProbe();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await nextProbe();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('POST が2xxでも通知が届かなければ連続失敗をリセットしない', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await nextProbe();
    await nextProbe();
    expect(logger.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    socket.notifyCanary();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('2回の応答なしで再接続し、再接続後のクールダウンでも警告を繰り返さない', async () => {
    await nextProbe();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(3);

    // 自動再接続の HELLO 成功だけでは、配送経路の回復と見なさない。
    await vi.advanceTimersByTimeAsync(1_000);
    socket = FakeSocket.instances[1];
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    socket.hello('saved');
    await vi.advanceTimersByTimeAsync(0);
    await nextProbe();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    expect(logger.debug).toHaveBeenCalledWith(
      '[AutoPush] Canary probe missed again within cooldown, not reconnecting',
    );
  });

  test('停止による中断と古いPOSTの失敗を次の監視へ持ち越さない', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await nextProbe();
    let rejectPost!: (error: Error) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectPost = reject;
        }),
    );
    await nextProbe();
    const signal = fetchMock.mock.calls[1][1]?.signal;
    client.disconnect();
    expect(signal?.aborted).toBe(true);
    rejectPost(new TypeError('late fetch failed'));
    await vi.advanceTimersByTimeAsync(0);

    const connecting = client.connect();
    socket = FakeSocket.instances[1];
    socket.open();
    await connecting;
    const hello = client.sendHello('saved', ['canary']);
    socket.hello('saved');
    await hello;
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await nextProbe();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
