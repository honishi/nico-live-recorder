import { EventEmitter } from 'node:events';
import { LatestPublisher, UiUpdates } from '../../src/main/app/ui-updates';
import type { IpcContext } from '../../src/main/app/ipc';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('取得中の変更をまとめ直し、取得順に配信して同時取得を避ける', async () => {
  const first = deferred<number>();
  const read = vi
    .fn<() => Promise<number>>()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(2);
  const send = vi.fn();
  const publisher = new LatestPublisher(read, send, vi.fn());
  publisher.schedule();
  await vi.advanceTimersByTimeAsync(200);
  publisher.schedule();
  publisher.schedule();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledTimes(1);
  first.resolve(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledExactlyOnceWith(1);
  await vi.advanceTimersByTimeAsync(200);
  expect(read).toHaveBeenCalledTimes(2);
  expect(send.mock.calls).toEqual([[1], [2]]);
  publisher.stop();
});

test('取得より短い間隔で変更が続いても配信し、変更終了後は最新値に追いつく', async () => {
  let value = 0;
  const sent: number[] = [];
  const publisher = new LatestPublisher(
    () =>
      new Promise<number>((resolve) => {
        const snapshot = value;
        setTimeout(() => resolve(snapshot), 5);
      }),
    (snapshot) => sent.push(snapshot),
    (error) => {
      throw error;
    },
  );
  const changes = setInterval(() => {
    value += 1;
    publisher.schedule();
  }, 2);
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent.length).toBeGreaterThanOrEqual(8);
    expect(sent.every((snapshot, index) => index === 0 || snapshot > sent[index - 1])).toBe(true);
    clearInterval(changes);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent.at(-1)).toBe(value);
  } finally {
    clearInterval(changes);
    publisher.stop();
  }
});

test('取得失敗後も次の変更を配信でき、停止後の取得結果は送らない', async () => {
  const last = deferred<number>();
  const read = vi
    .fn<() => Promise<number>>()
    .mockRejectedValueOnce(new Error('read failed'))
    .mockResolvedValueOnce(2)
    .mockReturnValueOnce(last.promise);
  const send = vi.fn();
  const error = vi.fn();
  const publisher = new LatestPublisher(read, send, error);
  publisher.schedule();
  await vi.advanceTimersByTimeAsync(200);
  expect(error).toHaveBeenCalledTimes(1);
  publisher.schedule();
  await vi.advanceTimersByTimeAsync(200);
  expect(send).toHaveBeenCalledExactlyOnceWith(2);
  publisher.schedule();
  await vi.advanceTimersByTimeAsync(200);
  publisher.stop();
  last.resolve(3);
  publisher.schedule();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(send).toHaveBeenCalledTimes(1);
});

/** 実際の状態組み立てを通し、ログイベントによる余計な取得を検出する。 */
function setup(): {
  updates: UiUpdates;
  manager: EventEmitter;
  settings: EventEmitter;
  logger: EventEmitter;
  ui: { showDebug: boolean };
  authRead: ReturnType<typeof vi.fn>;
  settingsRead: ReturnType<typeof vi.fn>;
  recordingsRead: ReturnType<typeof vi.fn>;
  destination: {
    status: ReturnType<typeof vi.fn>;
    logs: ReturnType<typeof vi.fn>;
    settings: ReturnType<typeof vi.fn>;
  };
} {
  const ui = { showDebug: false };
  const authRead = vi.fn(async () => true);
  const settingsRead = vi.fn(() => ({ ui }));
  const recordingsRead = vi.fn(async () => []);
  const manager = Object.assign(new EventEmitter(), {
    getPushStatus: () => ({ state: 'connected' }),
    getRecordings: recordingsRead,
    getAlerts: async () => [],
  });
  const settings = Object.assign(new EventEmitter(), { get: settingsRead });
  const logger = Object.assign(new EventEmitter(), {
    recent: vi.fn((_limit: number, debug: boolean) => (debug ? ['debug', 'info'] : ['info'])),
    error: vi.fn(),
  });
  const ctx = {
    manager,
    settings,
    logger,
    auth: Object.assign(new EventEmitter(), { isLoggedIn: authRead }),
    updates: Object.assign(new EventEmitter(), { getStatus: () => ({}) }),
  } as unknown as IpcContext;
  const destination = { status: vi.fn(), logs: vi.fn(), settings: vi.fn() };
  const updates = new UiUpdates(ctx, destination);
  settingsRead.mockClear();
  return {
    updates,
    manager,
    settings,
    logger,
    ui,
    authRead,
    settingsRead,
    recordingsRead,
    destination,
  };
}

test('ログはログだけを更新し、非表示のdebugでは何も配信しない', async () => {
  const h = setup();
  h.logger.emit('entry', { level: 'debug' });
  await vi.advanceTimersByTimeAsync(200);
  expect(h.destination.logs).not.toHaveBeenCalled();
  expect(h.settingsRead).not.toHaveBeenCalled();
  h.logger.emit('entry', { level: 'info' });
  h.logger.emit('entry', { level: 'warn' });
  await vi.advanceTimersByTimeAsync(200);
  expect(h.destination.logs).toHaveBeenCalledExactlyOnceWith(['info']);
  expect(h.destination.status).not.toHaveBeenCalled();
  expect(h.destination.settings).not.toHaveBeenCalled();
  expect(h.authRead).not.toHaveBeenCalled();
  expect(h.recordingsRead).not.toHaveBeenCalled();
  h.updates.stop();
});

test('状態・設定・debug切り替えをそれぞれ配信し、終了時に購読と待機を解除する', async () => {
  const h = setup();
  h.manager.emit('change');
  await vi.advanceTimersByTimeAsync(200);
  expect(h.destination.status).toHaveBeenCalledTimes(1);
  expect(h.destination.settings).not.toHaveBeenCalled();
  expect(h.settingsRead).not.toHaveBeenCalled();
  expect(h.destination.logs).not.toHaveBeenCalled();
  h.ui.showDebug = true;
  h.settings.emit('ui', h.ui);
  await vi.advanceTimersByTimeAsync(200);
  expect(h.destination.logs).toHaveBeenLastCalledWith(['debug', 'info']);
  expect(h.destination.settings).toHaveBeenCalledTimes(1);
  expect(h.destination.status).toHaveBeenCalledTimes(1);
  h.ui.showDebug = false;
  h.settings.emit('ui', h.ui);
  h.settings.emit('change');
  await vi.advanceTimersByTimeAsync(200);
  expect(h.destination.logs).toHaveBeenLastCalledWith(['info']);
  expect(h.destination.status).toHaveBeenCalledTimes(2);
  expect(h.destination.settings).toHaveBeenCalledTimes(2);
  h.updates.refreshStatus();
  h.updates.stop();
  h.manager.emit('change');
  h.logger.emit('entry', { level: 'info' });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.destination.status).toHaveBeenCalledTimes(2);
  expect(h.destination.logs).toHaveBeenCalledTimes(2);
  expect(h.manager.listenerCount('change')).toBe(0);
  expect(h.logger.listenerCount('entry')).toBe(0);
  expect(h.settings.listenerCount('ui')).toBe(0);
});
