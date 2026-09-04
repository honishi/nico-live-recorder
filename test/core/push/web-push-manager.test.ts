import {
  NotLoggedInError,
  WebPushManager,
  type PushStateStore,
  type PushSubscriptionState,
} from '../../../src/main/core/push/web-push-manager';
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

function installFetch(options: { registerStatus?: number } = {}): FetchLog[] {
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
        return new Response('{}', { status: options.registerStatus ?? 200 });
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
});
