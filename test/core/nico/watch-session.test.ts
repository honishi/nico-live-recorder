import { WatchSession } from '../../../src/main/core/nico/watch-session';
import {
  startFakeWatchServer,
  waitFor,
  type FakeWatchServer,
} from '../../helpers/fake-watch-server';

const STREAM = {
  uri: 'https://cdn.example/hls/playlists/abc/multivariant/variant.m3u8',
  syncUri: 'https://cdn.example/sync.json',
  quality: 'abr',
  availableQualities: ['abr', '1.5Mbps480p30fps'],
  protocol: 'hls',
  cookies: [
    { name: 'session', value: 's1', domain: 'nicovideo.jp', path: '/hls/keys/abc', secure: true },
    { name: 'CloudFront-Policy', value: 'p', domain: 'nicovideo.jp', path: '/hls/playlists/abc' },
    { value: 'no-name' },
    'garbage',
  ],
};

describe('WatchSession', () => {
  let server: FakeWatchServer;
  let session: WatchSession | undefined;

  beforeEach(async () => {
    server = await startFakeWatchServer({ streamData: () => STREAM, keepIntervalSec: 0.2 });
  });

  afterEach(async () => {
    session?.close();
    session = undefined;
    await server.close();
    vi.useRealTimers();
  });

  test.each(['timeout', 'abort'] as const)('open 前の無応答を %s で中断する', async (cause) => {
    const stalled = http.createServer();
    stalled.listen(0, '127.0.0.1');
    await once(stalled, 'listening');
    const upgraded = new Promise<Duplex>((resolve) =>
      stalled.once('upgrade', (_req, socket) => resolve(socket)),
    );
    vi.useFakeTimers();
    const controller = new AbortController();
    session = new WatchSession(`ws://127.0.0.1:${(stalled.address() as AddressInfo).port}`, {
      connectTimeoutMs: 1000,
    });
    const task = session.connect(controller.signal);
    const check = expect(task).rejects.toThrow(cause === 'timeout' ? /1000ms/ : /abort/i);
    const socket = await upgraded;
    try {
      if (cause === 'timeout') {
        await vi.advanceTimersByTimeAsync(1000);
      } else {
        controller.abort();
      }
      await check;
    } finally {
      socket.destroy();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });

  test('stream 待ちと認証更新中も abort で中断できる', async () => {
    await server.close();
    server = await startFakeWatchServer({ streamData: () => ({ protocol: 'other' }) });
    session = new WatchSession(server.url);
    await session.connect();
    const controller = new AbortController();
    const waiting = session.waitForStream(false, controller.signal);
    const check = expect(waiting).rejects.toThrow(/abort/i);
    controller.abort();
    await check;
    await expect(session.refreshStream(controller.signal)).rejects.toThrow(/abort/i);
    expect(server.connections).toHaveLength(1);
  });

  test('startWatching を送り、stream メッセージを HLS 配信情報として受け取る', async () => {
    session = new WatchSession(server.url, { cookieHeader: 'user_session=u' });
    await session.connect();
    const stream = await session.waitForStream();

    expect(stream.uri).toBe(STREAM.uri);
    expect(stream.quality).toBe('abr');
    expect(stream.availableQualities).toEqual(['abr', '1.5Mbps480p30fps']);
    // name の無い項目や文字列は cookie として扱わない
    expect(stream.cookies.map((c) => c.name)).toEqual(['session', 'CloudFront-Policy']);
    expect(stream.cookies[0]).toMatchObject({ path: '/hls/keys/abc', secure: true });
    expect(session.latestStreamInfo).toBe(stream);

    const first = server.connections[0].received[0];
    expect(first['type']).toBe('startWatching');
    expect(first['data']).toMatchObject({ stream: { protocol: 'hls', quality: 'abr' } });
  });

  test('stream応答解析の共通化後もライブのCookie補完と画質変換を維持する', async () => {
    session = new WatchSession(server.url);
    await session.connect();
    await session.waitForStream();
    server.send(0, {
      type: 'stream',
      data: {
        protocol: 'hls',
        uri: 'https://example.test/next',
        quality: 720,
        cookies: [{ name: 'fallback', value: 42 }],
        availableQualities: [720, 'abr'],
      },
    });
    await waitFor(() => session?.latestStreamInfo?.uri === 'https://example.test/next');
    expect(session.latestStreamInfo).toMatchObject({
      quality: '720',
      availableQualities: ['720', 'abr'],
    });
    expect(session.latestStreamInfo?.cookies).toStrictEqual([
      {
        name: 'fallback',
        value: '42',
        domain: 'nicovideo.jp',
        path: '/',
        secure: false,
        expires: undefined,
      },
    ]);
  });

  test('ping には pong と keepSeat を返し、seat の間隔で keepSeat を送り続ける', async () => {
    session = new WatchSession(server.url);
    await session.connect();
    await session.waitForStream();

    server.send(0, { type: 'ping' });
    const received = server.connections[0].received;
    await waitFor(() => received.some((m) => m['type'] === 'pong'));
    expect(received.some((m) => m['type'] === 'keepSeat')).toBe(true);

    // seat の keepIntervalSec (0.2 秒) ごとにも keepSeat が来る
    const before = received.filter((m) => m['type'] === 'keepSeat').length;
    await waitFor(
      () => received.filter((m) => m['type'] === 'keepSeat').length >= before + 2,
      2000,
    );
  });

  test('END_PROGRAM の disconnect は ended、それ以外は disconnect として通知する', async () => {
    session = new WatchSession(server.url);
    await session.connect();
    const ended = vi.fn();
    const disconnected = vi.fn();
    session.on('ended', ended);
    session.on('disconnect', disconnected);

    server.send(0, { type: 'disconnect', data: { reason: 'TAKEOVER' } });
    await waitFor(() => disconnected.mock.calls.length === 1);
    expect(disconnected).toHaveBeenCalledWith('TAKEOVER');
    expect(ended).not.toHaveBeenCalled();

    server.send(0, { type: 'disconnect', data: { reason: 'END_PROGRAM' } });
    await waitFor(() => ended.mock.calls.length === 1);
    expect(ended).toHaveBeenCalledWith('END_PROGRAM');
  });

  test('refreshStream は接続を張り直して新しい配信情報を返す', async () => {
    await server.close();
    server = await startFakeWatchServer({
      streamData: (index) => ({
        ...STREAM,
        cookies: [{ name: 'session', value: `s${index + 1}`, domain: 'n', path: '/' }],
      }),
    });
    session = new WatchSession(server.url);
    await session.connect();
    const first = await session.waitForStream();
    expect(first.cookies[0].value).toBe('s1');

    const closed = vi.fn();
    session.on('close', closed);
    const second = await session.refreshStream();
    expect(second.cookies[0].value).toBe('s2');
    expect(server.connections).toHaveLength(2);
    // 自分で張り直した切断は intentional として通知される
    await waitFor(() => closed.mock.calls.length === 1);
    expect(closed.mock.calls[0][0]).toMatchObject({ intentional: true });
  });

  test('サーバー側から切れた場合は intentional=false の close を通知する', async () => {
    session = new WatchSession(server.url);
    await session.connect();
    await session.waitForStream();
    const closed = vi.fn();
    session.on('close', closed);

    server.connections[0].socket.terminate();
    await waitFor(() => closed.mock.calls.length === 1);
    expect(closed.mock.calls[0][0]).toMatchObject({ intentional: false });
    expect(session.isOpen).toBe(false);
  });

  test('reconnect メッセージで新しい audience_token に繋ぎ直す', async () => {
    session = new WatchSession(server.url);
    await session.connect();
    const first = await session.waitForStream();

    server.send(0, { type: 'reconnect', data: { audienceToken: 't2', waitTimeSec: 0 } });
    await waitFor(() => server.connections.length === 2);
    expect(server.connections[1].url).toContain('audience_token=t2');
    // 新しい接続で stream を受け取り直している
    await waitFor(() => session?.latestStreamInfo !== first);
  });

  test('stream が来ないときは waitForStream がタイムアウトする', async () => {
    await server.close();
    server = await startFakeWatchServer({ streamData: () => ({ protocol: 'other' }) });
    session = new WatchSession(server.url, { streamTimeoutMs: 100 });
    await session.connect();
    await expect(session.waitForStream()).rejects.toThrow(/100ms/);
  });
});
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
