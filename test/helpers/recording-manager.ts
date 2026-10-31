import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProgramRecorderOptions } from '../../src/main/core/recorder/recording-types';
import type { NicoLiveProgramInfo } from '../../src/main/vendor/nico-client/types';
import { NicoLiveProgramStatus } from '../../src/main/vendor/nico-client/types';
import { HistoryStore } from '../../src/main/app/history-store';
import { SettingsStore } from '../../src/main/app/settings-store';
import type { NicoAuth } from '../../src/main/app/auth';
import { waitFor } from './fake-watch-server';

// ---------------------------------------------------------------------------
// Electron と外部依存 (録画本体、番組情報、検知器、push) を差し替える
// ---------------------------------------------------------------------------

const notifications = vi.hoisted(() => [] as { title: string; body: string }[]);
const notificationSupported = vi.hoisted(() => vi.fn(() => true));
vi.mock('electron', () => ({
  Notification: class {
    static isSupported = notificationSupported;
    constructor(private options: { title: string; body: string }) {}
    show(): void {
      notifications.push(this.options);
    }
  },
}));

export type RecordCall = {
  options: ProgramRecorderOptions;
  signal?: AbortSignal;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  /** onPaths を呼び済みか (実際の録画本体は開始時に 1 回だけ呼ぶ) */
  pathsSent?: boolean;
};
const recordCalls = vi.hoisted(() => [] as RecordCall[]);
vi.mock('../../src/main/core/recorder/program-recorder', () => ({
  recordProgram: vi.fn(
    (options: ProgramRecorderOptions, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        recordCalls.push({ options, signal, resolve, reject });
      }),
  ),
}));

const extractPreview = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/core/nico/preview-image', () => ({ extractPreviewImage: extractPreview }));

const getProgramInfo = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/vendor/nico-client/NicoClient', () => ({
  NicoClient: class {
    getProgramInfo = getProgramInfo;
  },
}));

// vi.mock は import より先に巻き上げられるので、差し替え用のクラスも hoisted で作る
interface DetectorDouble extends EventEmitter {
  seen: Set<string>;
  running: boolean;
  start(): void;
  stop(): void;
  markSeen(id: string): void;
  unmarkSeen(id: string): void;
}
const {
  FakeDetector,
  detectors,
}: { FakeDetector: new () => DetectorDouble; detectors: DetectorDouble[] } = await vi.hoisted(
  async () => {
    const { EventEmitter: Emitter } = await import('node:events');
    class FakeDetector extends Emitter {
      seen = new Set<string>();
      running = false;
      constructor() {
        super();
        detectors.push(this);
      }
      start(): void {
        this.running = true;
      }
      stop(): void {
        this.running = false;
      }
      markSeen(id: string): void {
        this.seen.add(id);
      }
      unmarkSeen(id: string): void {
        this.seen.delete(id);
      }
    }
    const detectors: FakeDetector[] = [];
    return { FakeDetector, detectors };
  },
);
vi.mock('../../src/main/core/detector/program-detector', () => ({
  ProgramDetector: FakeDetector,
}));

// push は接続せず、起動・停止だけを記録する
const pushManagers = vi.hoisted(() => [] as { started: boolean; stop(): Promise<void> }[]);
const resetPush = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('../../src/main/core/push/web-push-manager', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    WebPushManager: class extends Emitter {
      started = false;
      constructor() {
        super();
        pushManagers.push(this);
      }
      async start(): Promise<void> {
        this.started = true;
      }
      async stop(): Promise<void> {
        this.started = false;
      }
      async reset(): Promise<void> {
        this.started = false;
        await resetPush();
      }
      getStatus(): unknown {
        return { state: this.started ? 'connected' : 'stopped', niconicoRegistered: false };
      }
    },
  };
});

import {
  RecordingManager,
  type RecordingManagerOptions,
} from '../../src/main/app/recording-manager';

export function info(patch: Partial<NicoLiveProgramInfo> = {}): NicoLiveProgramInfo {
  return {
    nicoliveProgramId: 'lv1',
    title: 'タイトル',
    description: '',
    providerId: '100',
    providerName: 'alice',
    status: NicoLiveProgramStatus.onAir,
    openTime: 0,
    beginTime: 0,
    vposBaseTime: 0,
    endTime: 0,
    scheduledEndTime: 0,
    webSocketUrl: 'wss://watch.example/1',
    hasTimeshift: false,
    supplierIntroduction: '',
    commentCount: 0,
    watchCount: 0,
    ...patch,
  };
}

export function fakeAuth(): NicoAuth {
  const auth = new EventEmitter() as unknown as NicoAuth;
  let loggedIn = true;
  Object.assign(auth, {
    isLoggedIn: async () => loggedIn,
    getCookieHeader: async () => (loggedIn ? 'user_session=x' : undefined),
    getCookieRecord: async () => (loggedIn ? { user_session: 'x' } : undefined),
    logout: vi.fn(async () => {
      loggedIn = false;
      auth.emit('change', false);
    }),
  });
  return auth;
}

/** 非同期処理の途中でログアウトする順序を、実時間に頼らず固定する */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 録画本体の呼び出しを 1 件取り出す (まだ来ていなければ待つ) */
export async function nextRecordCall(index: number): Promise<RecordCall> {
  await waitFor(() => recordCalls.length > index, 3000, 5);
  return recordCalls[index];
}

/** recorder が連番を決めた通知を送る (pathsSent を立てて finishedResult が二重に送らないようにする) */
export function sendPaths(
  call: RecordCall,
  attempt: number,
  videoPath: string,
  commentsPath: string,
): void {
  call.pathsSent = true;
  call.options.onPaths?.({ attempt, videoPath, commentsPath });
}

/** 1 秒ごとのサイズ監視を 1 回動かし、videoBytes が期待値になるまで待つ (stat は実 I/O なので完了を待つ) */
export async function expectVideoBytes(manager: RecordingManager, bytes: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000);
  await waitFor(async () => (await manager.getRecordings())[0]?.videoBytes === bytes);
}

export const GIB = 1024 ** 3;

export function finishedResult(call: RecordCall, patch: Record<string, unknown> = {}): unknown {
  const attempt = call.options.attempt ?? 1;
  const base = `${call.options.outputDir}/rec${attempt > 1 ? `_${attempt}` : ''}`;
  if (!call.pathsSent) {
    call.pathsSent = true;
    call.options.onPaths?.({
      attempt,
      videoPath: `${base}.ts`,
      commentsPath: `${base}.comments.csv`,
    });
  }
  return {
    programId: call.options.programId,
    programInfo: call.options.programInfo,
    attempt,
    baseName: 'rec',
    videoPath: `${base}.ts`,
    commentsPath: `${base}.comments.csv`,
    metadataPath: `${base}.json`,
    video: { reason: 'endlist', video: { segments: 1, bytes: 1 } },
    errors: [],
    ...patch,
  };
}
export let dir: string;

export let settings: SettingsStore;

export let history: HistoryStore;

export let manager: RecordingManager;

export let auth: NicoAuth;

export let logger: Record<
  'debug' | 'info' | 'warn' | 'error',
  ReturnType<typeof vi.fn<(...args: unknown[]) => void>>
>;

export function createManager(overrides: Partial<RecordingManagerOptions> = {}): RecordingManager {
  return new RecordingManager({
    settings,
    auth,
    pushStore: {
      load: async () => undefined,
      save: async () => undefined,
      clear: async () => undefined,
    },
    history,
    logger,
    ffmpegPath: '/bin/false',
    ...overrides,
  });
}

/**
 * 再開待ち (5 秒から倍々) に入るのを待ってから、その待ちを進める。
 * 待ちに入る前に進めると、遅い環境ではタイマーが後から作られて実時間でしか進まない
 */
export async function skipRetryWait(ms: number): Promise<void> {
  await waitFor(async () => (await manager.getRecordings())[0]?.state === 'starting');
  await vi.advanceTimersByTimeAsync(ms);
}

/** 各スイートで同じ隔離環境と終了処理を登録する。 */
export function setupRecordingManager(): void {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-manager-'));
    recordCalls.length = 0;
    notifications.length = 0;
    notificationSupported.mockReset().mockReturnValue(true);
    detectors.length = 0;
    pushManagers.length = 0;
    resetPush.mockReset().mockResolvedValue(undefined);
    extractPreview.mockReset().mockResolvedValue(Buffer.from('jpeg'));
    getProgramInfo.mockReset();
    getProgramInfo.mockResolvedValue(info());
    settings = new SettingsStore(path.join(dir, 'settings.json'), path.join(dir, 'out'));
    settings.update({ pushEnabled: false });
    history = new HistoryStore(path.join(dir, 'history.json'));
    auth = fakeAuth();
    logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    manager = createManager();
  });
  afterEach(async () => {
    // 未完了の録画本体は abort 扱いで終わらせてから shutdown を待つ (逆だと待ち合わせで詰まる)
    const shutdown = manager.shutdown();
    for (const call of recordCalls) {
      call.resolve(finishedResult(call, { video: { reason: 'aborted', video: {} } }));
    }
    try {
      await shutdown;
      history.flush();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

export {
  notifications,
  notificationSupported,
  recordCalls,
  extractPreview,
  getProgramInfo,
  pushManagers,
  resetPush,
  detectors,
};
