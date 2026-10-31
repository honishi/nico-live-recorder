import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecordingManager } from '../../src/main/app/recording-manager';
import { SettingsStore } from '../../src/main/app/settings-store';
import { HistoryStore } from '../../src/main/app/history-store';
import { FilePushStateStore } from '../../src/main/app/push-state-store';
import { CSV_HEADER } from '../../src/main/core/recorder/comment-csv';
import { startFakeProgram } from '../helpers/fake-program';
import { startFakeAutoPush, encryptWebPush } from '../helpers/fake-autopush';
import { writeFakeFfmpeg } from '../helpers/fake-ffmpeg';
import { waitFor } from '../helpers/fake-watch-server';

// OS通知だけを差し替え、manager・検知・録画・永続化は本体を通す。
vi.mock('electron', () => ({
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
let dir, program, push, settings, history, store, manager, logger;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nlr-manager-integration-'));
  settings = new SettingsStore(path.join(dir, 'settings.json'), dir);
  settings.update({ notificationsEnabled: false, minFreeSpaceGb: 0 });
  history = new HistoryStore(path.join(dir, 'history.json'));
  store = new FilePushStateStore(path.join(dir, 'push.json'));
  logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level, vi.fn()]));
});
afterEach(async () => {
  await manager?.shutdown();
  history.flush();
  await push?.close();
  await program?.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
  manager = program = push = undefined;
});
function createManager() {
  const auth = Object.assign(new EventEmitter(), {
    isLoggedIn: async () => true,
    getCookieHeader: async () => 'user_session=dummy',
    getCookieRecord: async () => ({ user_session: 'dummy' }),
  });
  return new RecordingManager({
    settings,
    history,
    pushStore: store,
    auth,
    logger,
    ffmpegPath: writeFakeFfmpeg(dir),
  });
}
async function recordingMatches(predicate, timeout = 5000) {
  let found;
  await waitFor(async () => {
    found = (await manager.getRecordings()).find(predicate);
    return !!found;
  }, timeout);
  return structuredClone(found);
}

test('実録画の失敗後に次のパートへ再開し、動画・CSV・累計履歴を保持する', async () => {
  program = await startFakeProgram();
  manager = createManager();
  // 最初の子だけ入力を書き切って異常終了し、2パート目は正常終了する。
  writeFakeFfmpeg(dir, { failFirstPart: true });
  await manager.startRecording('lv42', 'manual');
  const first = await recordingMatches(
    (r) => r.state === 'starting' && r.commentCount === 1 && r.videoBytes > 0,
  );
  const originalVideo = await fs.readFile(first.videoPath);
  const originalCsv = await fs.readFile(first.commentsPath, 'utf8');
  // 異常終了後は本体のバックオフを経て、番組情報を取り直す。
  const second = await recordingMatches(
    (r) => r.attempt === 2 && r.commentCount === 2 && r.videoBytes > originalVideo.length,
    15_000,
  );
  expect(second.videoPath).toMatch(/_2\.ts$/);
  expect(second.videoPaths).toEqual([first.videoPath, second.videoPath]);
  expect(second.commentsPath).toBe(first.commentsPath);
  await manager.stopRecording('lv42');
  const done = await recordingMatches((r) => r.state === 'done');
  expect(await fs.readFile(first.videoPath)).toEqual(originalVideo);
  expect(await fs.readFile(second.videoPath)).toEqual(originalVideo);
  const csv = await fs.readFile(done.commentsPath, 'utf8');
  expect(csv.startsWith(originalCsv)).toBe(true);
  expect(csv.split(CSV_HEADER)).toHaveLength(2);
  expect(csv.match(/fixture-comment/g)).toHaveLength(done.commentCount);
  history.flush();
  expect(new HistoryStore(path.join(dir, 'history.json')).all()).toEqual([
    expect.objectContaining({
      state: 'done',
      attempt: 2,
      commentCount: 2,
      videoBytes: originalVideo.length * 2,
      videoPaths: done.videoPaths,
    }),
  ]);
  expect(program.requests.filter((r) => r.path === '/packed')).toHaveLength(1);
}, 25_000);

async function setupDetection(registrationStatus = 200) {
  program = await startFakeProgram({ openEnded: true });
  push = await startFakeAutoPush();
  program.dispatcher.enableNetConnect(new URL(push.url).host);
  const NativeWebSocket = globalThis.WebSocket;
  // 接続先だけを偽AutoPushに向け、内蔵WebSocketと暗号処理はそのまま使う。
  vi.stubGlobal(
    'WebSocket',
    class extends NativeWebSocket {
      constructor(url, protocols) {
        expect(String(url)).toBe('wss://push.services.mozilla.com');
        super(push.url, protocols);
      }
    },
  );
  program.dispatcher
    .get('https://account.nicovideo.jp')
    .intercept({ path: '/sw.js' })
    .reply(200, '')
    .persist();
  program.dispatcher
    .get('https://api.push.nicovideo.jp')
    .intercept({ path: '/v1/nicopush/webpush/endpoints.json', method: 'POST' })
    .reply(registrationStatus, '')
    .persist();
  program.dispatcher
    .get('https://push.example')
    .intercept({ path: /.*/, method: 'POST' })
    .reply(201, '')
    .persist();
  let programs = [];
  let polls = 0;
  program.dispatcher
    .get('https://live.nicovideo.jp')
    .intercept({ path: '/front/api/pages/follow/v1/programs?status=onair&offset=0' })
    .reply(() => {
      polls++;
      return { statusCode: 200, data: JSON.stringify({ data: { programs } }) };
    })
    .persist();
  settings.upsertTarget({ userId: '123', name: '配信者', enabled: true, addedAt: '2026-01-01' });
  return {
    publish: () => {
      programs = [{ id: 'lv42', title: 'test', programProvider: { id: '123', name: '配信者' } }];
    },
    polls: () => polls,
  };
}

test('保存したpush購読を再読込して暗号通知から録画し、再ポーリングと重複しない', async () => {
  const feed = await setupDetection();
  manager = createManager();
  await manager.start();
  await waitFor(async () => (await store.load())?.niconicoRegistered === true);
  await manager.shutdown();
  const saved = await store.load();
  const registeredChannels = push.channels.length;
  // storeとmanagerを作り直して、実ファイルからUAID・鍵・チャネルを復元する。
  store = new FilePushStateStore(path.join(dir, 'push.json'));
  manager = createManager();
  await manager.start();
  await waitFor(() => push.hellos.length === 2);
  await waitFor(
    () =>
      manager.getPushStatus().state === 'connected' && manager.getPushStatus().niconicoRegistered,
  );
  expect(push.hellos[1].uaid).toBe(saved.uaid);
  expect(push.channels).toHaveLength(registeredChannels);
  const data = encryptWebPush(
    JSON.stringify({ data: { on_click: 'https://live.nicovideo.jp/watch/lv42' } }),
    saved.keys,
  );
  push.notify(saved.channelId, data);
  await recordingMatches((r) => r.source === 'push' && r.commentCount === 1 && r.videoBytes > 0);
  // 設定変更による検知再起動は即時ポーリングする。録画中IDの既知集合も引き継ぐ。
  const previousPolls = feed.polls();
  feed.publish();
  settings.update({ pollIntervalSec: 45 });
  await waitFor(() => feed.polls() > previousPolls);
  push.notify(saved.channelId, data);
  await waitFor(() => push.acks.length >= 2);
  await manager.stopRecording('lv42');
  await recordingMatches((r) => r.state === 'done');
  // 映像とコメントがそれぞれ視聴WSを1本使う。二重録画なら4本になる。
  expect(program.watch.connections).toHaveLength(2);
  expect(history.all()).toHaveLength(1);
  expect((await store.load()).keys).toEqual(saved.keys);
});

test('push登録に失敗してもポーリング検知から実録画を保存する', async () => {
  const feed = await setupDetection(503);
  feed.publish();
  manager = createManager();
  await manager.start();
  await waitFor(() =>
    logger.error.mock.calls.some(([message]) => message.includes('polling continues')),
  );
  await recordingMatches((r) => r.source === 'poll' && r.commentCount === 1 && r.videoBytes > 0);
  await manager.stopRecording('lv42');
  await recordingMatches((r) => r.state === 'done');
  // 映像とコメントがそれぞれ視聴WSを1本使う。二重録画なら4本になる。
  expect(program.watch.connections).toHaveLength(2);
  expect(history.all()[0].commentCount).toBe(1);
});
