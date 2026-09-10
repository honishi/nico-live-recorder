import {
  NotLoggedInError,
  WebPushManager,
  type PushStateStore,
  type PushStatus,
  type PushSubscriptionState,
} from '../../../src/main/core/push/web-push-manager';
import { setPushLogger } from '../../../src/main/vendor/web-push/push-diagnostics';
import { encryptWebPush, startFakeAutoPush, type FakeAutoPush } from '../../helpers/fake-autopush';
import { waitFor } from '../../helpers/fake-watch-server';

// ニコニコ側の HTTP (Service Worker の取得、push API への登録) を偽装する
const VAPID = new Uint8Array(65);
VAPID[0] = 0x04;
for (let i = 1; i < 65; i += 1) {
  VAPID[i] = (i * 7) % 256;
}
const OTHER = new Uint8Array(65).fill(1);
const uint8Literal = (bytes: Uint8Array): string => `new Uint8Array([${[...bytes].join(',')}])`;

interface FetchLog {
  url: string;
  init?: RequestInit;
}

function installFetch(
  options: { registerStatus?: number; unregisterStatus?: number } = {},
): FetchLog[] {
  const log: FetchLog[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      log.push({ url, init });
      if (url.endsWith('/sw.js')) {
        return new Response("importScripts('https://account.nicovideo.jp/main.js')");
      }
      if (url.endsWith('/main.js')) {
        return new Response(
          [
            `const local = ${uint8Literal(OTHER)};`,
            `const dev = ${uint8Literal(OTHER)};`,
            `const prod = ${uint8Literal(VAPID)};`,
            'const endpoint = { URL: "https://api.push.nicovideo.jp/v1/nicopush/webpush/endpoints.json" };',
          ].join('\n'),
        );
      }
      if (url.includes('api.push.nicovideo.jp')) {
        return new Response('{}', {
          status:
            (init?.method === 'DELETE' ? options.unregisterStatus : options.registerStatus) ?? 200,
        });
      }
      if (url.includes('push.example')) {
        return new Response('', { status: 201 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return log;
}

function memoryStore(initial?: PushSubscriptionState): PushStateStore & {
  state?: PushSubscriptionState;
} {
  const store = {
    state: initial,
    async load() {
      return store.state;
    },
    async save(state: PushSubscriptionState) {
      store.state = structuredClone(state);
    },
    async clear() {
      store.state = undefined;
    },
  };
  return store;
}

describe('WebPushManager', () => {
  let autopush: FakeAutoPush;
  let manager: WebPushManager | undefined;

  beforeEach(async () => {
    autopush = await startFakeAutoPush();
  });

  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
    await autopush.close();
    vi.unstubAllGlobals();
  });

  test('未ログインなら購読を作らない', async () => {
    installFetch();
    manager = new WebPushManager({
      store: memoryStore(),
      cookieHeader: async () => undefined,
      autoPushEndpoint: autopush.url,
    });
    await expect(manager.start()).rejects.toBeInstanceOf(NotLoggedInError);
    expect(autopush.hellos).toHaveLength(0);
  });

  test('初回はチャネルを VAPID 鍵付きで登録し、エンドポイントと鍵をニコニコに送って保存する', async () => {
    const log = installFetch();
    const store = memoryStore();
    manager = new WebPushManager({
      store,
      cookieHeader: async () => 'user_session=abc',
      autoPushEndpoint: autopush.url,
    });
    await manager.start();

    // AutoPush 側: uaid 無しの hello、本チャネルは VAPID 鍵付き、canary は鍵無し
    expect(autopush.hellos[0]).toMatchObject({ uaid: '', channelIDs: [], use_webpush: true });
    expect(autopush.channels).toHaveLength(2);
    expect(autopush.channels[0].key).toBe(
      Buffer.from(VAPID)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, ''),
    );
    expect(autopush.channels[1].key).toBeUndefined();

    // ニコニコ側: cookie 付きで endpoint と鍵 (標準 base64) を POST
    const register = log.find((l) => l.url.includes('api.push.nicovideo.jp'));
    expect(register?.init?.method).toBe('POST');
    expect((register?.init?.headers as Record<string, string>)['Cookie']).toBe('user_session=abc');
    const body = JSON.parse(register?.init?.body as string) as {
      destApp: string;
      endpoint: { endpoint: string; auth: string; p256dh: string };
    };
    expect(body.destApp).toBe('nico_account_webpush');
    expect(body.endpoint.endpoint).toBe(
      `https://push.example/wpush/${autopush.channels[0].channelId}`,
    );
    expect(Buffer.from(body.endpoint.p256dh, 'base64')).toHaveLength(65);
    expect(Buffer.from(body.endpoint.auth, 'base64')).toHaveLength(16);

    // 保存された状態
    expect(store.state).toMatchObject({
      uaid: autopush.uaid,
      channelId: autopush.channels[0].channelId,
      niconicoRegistered: true,
      canary: { channelId: autopush.channels[1].channelId },
    });
    expect(manager.getStatus()).toMatchObject({ state: 'connected', niconicoRegistered: true });
  });

  test('暗号化された通知を復号し、放送 ID 付きの program イベントにする', async () => {
    installFetch();
    const store = memoryStore();
    manager = new WebPushManager({
      store,
      cookieHeader: async () => 'user_session=abc',
      autoPushEndpoint: autopush.url,
    });
    await manager.start();
    const receivedStatus = vi.fn<(status: PushStatus) => void>();
    manager.on('status', receivedStatus);
    const programs: unknown[] = [];
    manager.on('program', (p) => programs.push(p));

    const payload = encryptWebPush(
      JSON.stringify({
        title: 'alice さんが生放送を開始',
        body: '「テスト」を放送',
        icon: 'https://i/1.png',
        data: {
          on_click: 'https://live.nicovideo.jp/watch/lv999?from=webpush',
          created_at: '2026-09-04T00:00:00Z',
        },
      }),
      { publicKey: store.state!.keys.publicKey, authSecret: store.state!.keys.authSecret },
    );
    autopush.notify(store.state!.channelId, payload);

    await waitFor(() => programs.length === 1);
    expect(programs[0]).toMatchObject({
      programId: 'lv999',
      title: 'alice さんが生放送を開始',
      createdAt: '2026-09-04T00:00:00Z',
    });
    await waitFor(() => autopush.acks.length === 1);
    expect(manager.getStatus().lastReceivedAt).toBeInstanceOf(Date);
    expect(receivedStatus.mock.calls.at(-1)?.[0].lastReceivedAt).toBeInstanceOf(Date);
    expect(receivedStatus.mock.calls.at(-1)?.[0].state).toBe('connected');
  });

  test('保存済みの購読は uaid 付きの hello で復元し、登録し直さない', async () => {
    const log = installFetch();
    const store = memoryStore();
    manager = new WebPushManager({
      store,
      cookieHeader: async () => 'user_session=abc',
      autoPushEndpoint: autopush.url,
    });
    await manager.start();
    await manager.stop();
    const saved = structuredClone(store.state!);
    const registrations = log.filter((l) => l.url.includes('api.push.nicovideo.jp')).length;

    manager = new WebPushManager({
      store: memoryStore(saved),
      cookieHeader: async () => 'user_session=abc',
      autoPushEndpoint: autopush.url,
    });
    await manager.start();

    expect(autopush.hellos[1]).toMatchObject({
      uaid: saved.uaid,
      channelIDs: [saved.channelId, saved.canary!.channelId],
    });
    expect(autopush.channels).toHaveLength(2);
    expect(log.filter((l) => l.url.includes('api.push.nicovideo.jp')).length).toBe(registrations);
    expect(manager.getStatus().state).toBe('connected');
  });

  test('サーバーから切られても再接続して同じ購読を復元し、error や warn は出さない', async () => {
    const fetchLog = installFetch();
    const store = memoryStore();
    const logs: { level: string; text: string }[] = [];
    let releaseHello: (() => void) | undefined;
    setPushLogger({
      debug: (...args) => logs.push({ level: 'debug', text: args.map(String).join(' ') }),
      info: (...args) => logs.push({ level: 'info', text: args.map(String).join(' ') }),
      warn: (...args) => logs.push({ level: 'warn', text: args.map(String).join(' ') }),
      error: (...args) => logs.push({ level: 'error', text: args.map(String).join(' ') }),
    });
    try {
      manager = new WebPushManager({
        store,
        cookieHeader: async () => 'user_session=abc',
        autoPushEndpoint: autopush.url,
      });
      await manager.start();
      const saved = structuredClone(store.state!);
      const channelIds = [saved.channelId, saved.canary!.channelId];
      const registrations = fetchLog.filter((l) => l.url.includes('api.push.nicovideo.jp')).length;
      logs.length = 0;
      const states: string[] = [];
      manager.on('status', (status) => states.push(status.state));

      // HELLO 応答を保留して、以前の待機条件だけでは処理完了を保証しない順序を再現する。
      releaseHello = autopush.holdNextHello();
      autopush.drop();
      // 1 秒後に再接続し、保存済みの uaid で hello する
      await waitFor(() => autopush.hellos.length === 2, 5000);
      expect(autopush.hellos[1]).toMatchObject({ uaid: saved.uaid, channelIDs: channelIds });
      await waitFor(() => manager!.getStatus().state === 'connected', 5000);
      expect(states).toEqual(['disconnected', 'connected']);
      expect(logs.some((l) => /reconnected after \d+s/.test(l.text))).toBe(false);
      expect(logs.some((l) => l.text.includes('Restored channel IDs from HELLO'))).toBe(false);

      // connected は WebSocket の開通だけを表すので、HELLO 成功後のログまで待つ。
      releaseHello();
      await waitFor(() => logs.some((l) => /reconnected after \d+s/.test(l.text)), 5000);
      expect(logs).toContainEqual({
        level: 'debug',
        text: `[AutoPush] Restored channel IDs from HELLO: ${channelIds.join(',')}`,
      });
      expect(manager.getStatus()).toMatchObject({ state: 'connected', uaid: saved.uaid });
      expect(store.state).toEqual(saved);
      expect(autopush.channels).toHaveLength(2);
      expect(fetchLog.filter((l) => l.url.includes('api.push.nicovideo.jp')).length).toBe(
        registrations,
      );
      expect(logs.filter((l) => l.level !== 'debug')).toEqual([]);
      expect(
        logs.some((l) =>
          /WebSocket closed: code=1006 .*connectedFor=\d+s idleFor=\d+s/.test(l.text),
        ),
      ).toBe(true);
      expect(logs.some((l) => /reconnected after \d+s/.test(l.text))).toBe(true);
    } finally {
      releaseHello?.();
      setPushLogger({
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      });
    }
  });

  test('ニコニコへの登録に失敗したら start は失敗し、未登録として保存する', async () => {
    installFetch({ registerStatus: 403 });
    const store = memoryStore();
    manager = new WebPushManager({
      store,
      cookieHeader: async () => 'user_session=abc',
      autoPushEndpoint: autopush.url,
    });
    await expect(manager.start()).rejects.toThrow(/HTTP 403/);
    expect(store.state?.niconicoRegistered).toBe(false);
    expect(manager.getStatus()).toMatchObject({ state: 'error', niconicoRegistered: false });
  });

  test.each([false, true])(
    'reset は保存済み購読を両サーバーから解除して破棄する (停止中: %s)',
    async (stopped) => {
      const log = installFetch();
      const store = memoryStore();
      const options = {
        store,
        cookieHeader: async () => 'user_session=abc',
        autoPushEndpoint: autopush.url,
      };
      manager = new WebPushManager(options);
      await manager.start();
      const saved = structuredClone(store.state!);
      if (stopped) {
        await manager.stop();
        manager = new WebPushManager(options);
      }

      await manager.reset();

      const request = log.find((entry) => entry.init?.method === 'DELETE');
      expect(request?.init?.headers).toMatchObject({ Cookie: 'user_session=abc' });
      expect(JSON.parse(request!.init!.body as string)).toEqual({
        destApp: 'nico_account_webpush',
        endpoint: { endpoint: saved.endpoint },
      });
      await waitFor(() => autopush.unregistered.length === 2);
      expect(autopush.unregistered).toEqual([saved.channelId, saved.canary!.channelId]);
      expect(store.state).toBeUndefined();
      expect(manager.getStatus()).toMatchObject({
        state: 'stopped',
        niconicoRegistered: false,
        endpoint: undefined,
      });
      // 解除のための接続では購読を新規登録しない
      expect(
        log.filter(
          (entry) => entry.init?.method === 'POST' && entry.url.includes('api.push.nicovideo.jp'),
        ),
      ).toHaveLength(1);
    },
  );

  test('ニコニコの解除に失敗しても購読を破棄し、次回は新規登録する', async () => {
    const log = installFetch({ unregisterStatus: 503 });
    const store = memoryStore();
    let cookie = 'user_session=old';
    const warn = vi.fn();
    manager = new WebPushManager({
      store,
      cookieHeader: async () => cookie,
      autoPushEndpoint: autopush.url,
      logger: { debug() {}, info() {}, warn, error() {} },
    });
    await manager.start();
    const oldEndpoint = store.state!.endpoint;

    await manager.reset();
    expect(store.state).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('push: unregister from niconico failed', expect.any(Error));
    await waitFor(() => autopush.unregistered.length === 2);
    cookie = 'user_session=new';
    await manager.start();

    expect(store.state!.endpoint).not.toBe(oldEndpoint);
    const registrations = log.filter(
      (entry) => entry.init?.method === 'POST' && entry.url.includes('api.push.nicovideo.jp'),
    );
    expect(registrations).toHaveLength(2);
    expect(registrations[1].init?.headers).toMatchObject({ Cookie: cookie });
  });

  test('AutoPush に再接続できなくても保存済み購読を破棄する', async () => {
    installFetch();
    const store = memoryStore();
    manager = new WebPushManager({
      store,
      cookieHeader: async () => 'user_session=abc',
      autoPushEndpoint: autopush.url,
    });
    await manager.start();
    await manager.stop();
    // 閉じたローカルサーバーを使い、外部通信なしで接続失敗を再現する
    const unavailable = await startFakeAutoPush();
    await unavailable.close();
    manager = new WebPushManager({
      store,
      cookieHeader: async () => 'user_session=abc',
      autoPushEndpoint: unavailable.url,
    });
    await manager.reset();
    expect(store.state).toBeUndefined();
    expect(manager.getStatus().state).toBe('stopped');
  });

  test('保存済み購読がなければ reset は外部に接続しない', async () => {
    const log = installFetch();
    manager = new WebPushManager({
      store: memoryStore(),
      cookieHeader: async () => 'user_session=abc',
      autoPushEndpoint: autopush.url,
    });
    await manager.reset();
    expect(log).toEqual([]);
    expect(autopush.hellos).toEqual([]);
  });

  test('起動中の reset は登録完了を待ち、作成された購読を解除する', async () => {
    const log = installFetch();
    const store = memoryStore();
    manager = new WebPushManager({
      store,
      cookieHeader: async () => 'user_session=abc',
      autoPushEndpoint: autopush.url,
    });
    const release = autopush.holdNextHello();
    const starting = manager.start();
    await waitFor(() => autopush.hellos.length === 1);
    const resetting = manager.reset();
    release();
    await Promise.all([starting, resetting]);
    expect(
      log
        .filter((entry) => entry.url.includes('api.push.nicovideo.jp'))
        .map((entry) => entry.init?.method),
    ).toEqual(['POST', 'DELETE']);
    expect(store.state).toBeUndefined();
    expect(manager.getStatus().state).toBe('stopped');
    await waitFor(() => autopush.unregistered.length === 2);
  });
});
