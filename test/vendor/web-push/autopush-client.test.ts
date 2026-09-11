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
