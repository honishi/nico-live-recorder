import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProgramRecorderOptions } from '../../src/main/core/recorder/program-recorder';
import type { NicoLiveProgramInfo } from '../../src/main/vendor/nico-client/types';
import { NicoLiveProgramStatus } from '../../src/main/vendor/nico-client/types';
import { ERROR_CODES, parseErrorCode } from '../../src/shared/types';
import { HistoryStore } from '../../src/main/app/history-store';
import { SettingsStore } from '../../src/main/app/settings-store';
import type { NicoAuth } from '../../src/main/app/auth';
import { waitFor } from '../helpers/fake-watch-server';

// ---------------------------------------------------------------------------
// Electron と外部依存 (録画本体、番組情報、検知器、push) を差し替える
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    show(): void {}
  },
}));

type RecordCall = {
  options: ProgramRecorderOptions;
  signal?: AbortSignal;
  resolve: (result: unknown) => void;
  /** onPaths を呼び済みか (実際の録画本体は開始時に 1 回だけ呼ぶ) */
  pathsSent?: boolean;
};
const recordCalls = vi.hoisted(() => [] as RecordCall[]);
vi.mock('../../src/main/core/recorder/program-recorder', () => ({
  recordProgram: vi.fn(
    (options: ProgramRecorderOptions, signal?: AbortSignal) =>
      new Promise((resolve) => {
        recordCalls.push({ options, signal, resolve });
      }),
  ),
}));

const getProgramInfo = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/vendor/nico-client/NicoClient', () => ({
  NicoClient: class {
    getProgramInfo = getProgramInfo;
  },
}));

// vi.mock は import より先に巻き上げられるので、差し替え用のクラスも hoisted で作る
const { FakeDetector, detectors } = await vi.hoisted(async () => {
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
});
type FakeDetector = InstanceType<typeof FakeDetector>;
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

function info(patch: Partial<NicoLiveProgramInfo> = {}): NicoLiveProgramInfo {
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

function fakeAuth(): NicoAuth {
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
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 録画本体の呼び出しを 1 件取り出す (まだ来ていなければ待つ) */
async function nextRecordCall(index: number): Promise<RecordCall> {
  await waitFor(() => recordCalls.length > index, 3000, 5);
  return recordCalls[index];
}

/** recorder が連番を決めた通知を送る (pathsSent を立てて finishedResult が二重に送らないようにする) */
function sendPaths(
  call: RecordCall,
  attempt: number,
  videoPath: string,
  commentsPath: string,
): void {
  call.pathsSent = true;
  call.options.onPaths?.({ attempt, videoPath, commentsPath });
}

/** 1 秒ごとのサイズ監視を 1 回動かし、videoBytes が期待値になるまで待つ (stat は実 I/O なので完了を待つ) */
async function expectVideoBytes(manager: RecordingManager, bytes: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000);
  await waitFor(async () => (await manager.getRecordings())[0]?.videoBytes === bytes);
}

const GIB = 1024 ** 3;

function finishedResult(call: RecordCall, patch: Record<string, unknown> = {}): unknown {
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

describe('RecordingManager', () => {
  let dir: string;
  let settings: SettingsStore;
  let history: HistoryStore;
  let manager: RecordingManager;
  let auth: NicoAuth;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-manager-'));
    recordCalls.length = 0;
    detectors.length = 0;
    pushManagers.length = 0;
    resetPush.mockReset().mockResolvedValue(undefined);
    getProgramInfo.mockReset();
    getProgramInfo.mockResolvedValue(info());
    settings = new SettingsStore(path.join(dir, 'settings.json'), path.join(dir, 'out'));
    settings.update({ pushEnabled: false });
    history = new HistoryStore(path.join(dir, 'history.json'));
    auth = fakeAuth();
    manager = createManager();
  });

  function createManager(overrides: Partial<RecordingManagerOptions> = {}): RecordingManager {
    return new RecordingManager({
      settings,
      auth,
      pushStore: {
        load: async () => undefined,
        save: async () => undefined,
        clear: async () => undefined,
      },
      history,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      ffmpegPath: '/bin/false',
      ...overrides,
    });
  }

  afterEach(async () => {
    // 未完了の録画本体は abort 扱いで終わらせてから shutdown を待つ (逆だと待ち合わせで詰まる)
    const shutdown = manager.shutdown();
    for (const call of recordCalls) {
      call.resolve(finishedResult(call, { video: { reason: 'aborted', video: {} } }));
    }
    await shutdown;
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 再開待ち (5 秒から倍々) に入るのを待ってから、その待ちを進める。
   * 待ちに入る前に進めると、遅い環境ではタイマーが後から作られて実時間でしか進まない
   */
  async function skipRetryWait(ms: number): Promise<void> {
    await waitFor(async () => (await manager.getRecordings())[0]?.state === 'starting');
    await vi.advanceTimersByTimeAsync(ms);
  }

  test('空の予約を見た後に開始失敗しても出力消失とせず、成果物一覧から除外する', async () => {
    getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    const result = finishedResult(call, {
      video: undefined,
      errors: [{ target: 'video', message: 'CONNECT_TIMEOUT' }],
      timeshift: { completion: 'partial' },
    });
    const base = path.join(call.options.outputDir, 'rec');
    fs.mkdirSync(call.options.outputDir, { recursive: true });
    fs.writeFileSync(base + '.ts', '');
    fs.writeFileSync(base + '.comments.csv', '');
    await vi.advanceTimersByTimeAsync(1_000);
    fs.unlinkSync(base + '.ts');
    fs.unlinkSync(base + '.comments.csv');
    call.resolve(result);
    await waitFor(() => !manager.hasActiveRecordings());
    expect(history.get('lv1')).toMatchObject({
      state: 'failed',
      completion: 'partial',
      videoPaths: [],
      commentsPaths: [],
      error: 'video: CONNECT_TIMEOUT',
    });
    expect(history.get('lv1')?.videoPath).toBeUndefined();
    expect(history.get('lv1')?.commentsPath).toBeUndefined();
    expect(call.signal?.aborted).toBe(false);
  });

  test('視聴できないタイムシフトや取得できない番組はコード付きの例外にする', async () => {
    getProgramInfo.mockResolvedValueOnce(
      info({ status: NicoLiveProgramStatus.ended, webSocketUrl: undefined }),
    );
    await expect(manager.startRecording('lv1', 'manual')).rejects.toSatisfy(
      (e: Error) => parseErrorCode(e.message) === ERROR_CODES.timeshiftUnavailable,
    );
    getProgramInfo.mockRejectedValueOnce(new Error('network'));
    await expect(manager.startRecording('lv1', 'manual')).rejects.toSatisfy(
      (e: Error) => parseErrorCode(e.message) === ERROR_CODES.programUnavailable,
    );
    expect(recordCalls).toHaveLength(0);
    expect(await manager.getRecordings()).toEqual([]);
  });

  test.each(['complete', 'partial', 'cancelled'] as const)(
    '手動タイムシフトの%sを区別し、自動再試行しない',
    async (completion) => {
      getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
      await manager.startRecording('lv1', 'manual');
      const call = await nextRecordCall(0);
      expect(call.options.mode).toBe('timeshift');
      const progress = {
        phase: 'comments' as const,
        savedSegments: 10,
        totalSegments: 10,
        comments: 'pending' as const,
      };
      call.options.onTimeshiftProgress?.(progress);
      expect((await manager.getRecordings())[0]).toMatchObject({
        state: 'finishing',
        timeshift: progress,
      });
      if (completion === 'cancelled') manager.stopRecording('lv1');
      call.resolve(
        finishedResult(call, {
          timeshift: { completion, progress },
          ...(completion === 'partial'
            ? { video: undefined, errors: [{ target: 'video', message: 'failed' }] }
            : {}),
        }),
      );
      await waitFor(() => !manager.hasActiveRecordings());
      expect(history.get('lv1')).toMatchObject({
        mode: 'timeshift',
        completion,
        state: completion === 'partial' ? 'failed' : 'done',
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(recordCalls).toHaveLength(1);
      expect(getProgramInfo).toHaveBeenCalledOnce();
      if (completion === 'cancelled') {
        expect(history.match({ state: 'done' })).toEqual([]);
        expect(history.match({ state: 'cancelled' })).toHaveLength(1);
      }
    },
  );

  test('タイムシフトの録り直しは旧CSVを残し、今回の件数だけを数える', async () => {
    const oldVideo = path.join(dir, 'old.ts');
    const oldCsv = path.join(dir, 'old.comments.csv');
    fs.writeFileSync(oldVideo, 'video');
    fs.writeFileSync(oldCsv, 'old comments');
    history.upsert({
      programId: 'lv1',
      title: 'old',
      source: 'manual',
      state: 'done',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      outputDir: dir,
      commentCount: 999,
      videoBytes: 5,
      videoPath: oldVideo,
      commentsPath: oldCsv,
    });
    getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    expect(call.options.commentsPath).toBeUndefined();
    const result = finishedResult(call, { timeshift: { completion: 'complete' } });
    fs.mkdirSync(call.options.outputDir, { recursive: true });
    fs.writeFileSync(path.join(call.options.outputDir, 'rec.comments.csv'), 'new comments');
    call.options.onComment?.({} as never, 2);
    call.resolve(result);
    await waitFor(() => !manager.hasActiveRecordings());
    const entry = history.get('lv1')!;
    expect(entry.commentCount).toBe(2);
    expect(entry.commentsPaths).toEqual([oldCsv, entry.commentsPath]);
    expect(entry.videoPaths).toContain(oldVideo);
    expect(fs.readFileSync(oldCsv, 'utf8')).toBe('old comments');
    expect(manager.getCommentPaths('lv1')).toEqual(entry.commentsPaths);
  });

  test('自動ライブ録画と手動タイムシフトを同時に動かし停止を分離する', async () => {
    getProgramInfo
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(
        info({ nicoliveProgramId: 'lv2', status: NicoLiveProgramStatus.ended }),
      );
    await manager.startRecording('lv1', 'push');
    await manager.startRecording('lv2', 'manual');
    const live = await nextRecordCall(0);
    const timeshift = await nextRecordCall(1);
    expect(live.options.mode).toBe('live');
    expect(timeshift.options.mode).toBe('timeshift');
    manager.stopRecording('lv2');
    expect(timeshift.signal?.aborted).toBe(true);
    expect(live.signal?.aborted).toBe(false);
    timeshift.resolve(finishedResult(timeshift, { timeshift: { completion: 'cancelled' } }));
    live.resolve(finishedResult(live));
    await waitFor(() => !manager.hasActiveRecordings());
    expect(history.get('lv1')).toMatchObject({ state: 'done', mode: 'live' });
    expect(history.get('lv1')?.completion).toBeUndefined();
  });

  test('録画を始めて完了すると、履歴に配信者フォルダとファイルが残る', async () => {
    const started = await manager.startRecording('lv1', 'manual');
    expect(started).toMatchObject({ providerName: 'alice', title: 'タイトル' });
    expect(['starting', 'recording']).toContain(started.state);
    expect(started.outputDir).toBe(path.join(dir, 'out', '100_alice'));

    const call = await nextRecordCall(0);
    expect(call.options.outputDir).toBe(started.outputDir);
    expect(call.options.attempt).toBe(1);
    expect(call.options.prefetchBackwardComments).toBe(true);
    // 開始時点で履歴に残り (クラッシュ時の復元用)、進行中の状態は active 側で持つ
    expect(history.get('lv1')?.state).toBe('starting');
    expect((await manager.getRecordings())[0]).toMatchObject({
      programId: 'lv1',
      state: 'recording',
    });

    call.resolve(finishedResult(call));
    await waitFor(() => history.get('lv1')?.state === 'done');
    const entry = history.get('lv1')!;
    expect(entry.videoPaths).toEqual([`${entry.outputDir}/rec.ts`]);
    expect(entry.commentsPath).toBe(`${entry.outputDir}/rec.comments.csv`);
    expect(entry.endedAt).toBeDefined();
    expect(manager.hasActiveRecordings()).toBe(false);
  });

  test.each([
    ['100', '配信者/名:*?. ', '100_配信者_名___'],
    ['../100', 'alice', '.._100_alice'],
    ['100', undefined, '100'],
    ['100', '', '100'],
    ['100', '   ', '100'],
    [undefined, 'alice', 'unknown_alice'],
    ['', 'alice', 'unknown_alice'],
    [undefined, undefined, 'unknown'],
  ] as const)(
    '配信者 ID %j・名前 %j の保存フォルダは %s',
    async (providerId, providerName, folder) => {
      getProgramInfo.mockResolvedValueOnce(info({ providerId, providerName }));
      const started = await manager.startRecording('lv1', 'manual');
      const call = await nextRecordCall(0);
      expect(started.outputDir).toBe(path.join(dir, 'out', folder));
      expect(call.options.outputDir).toBe(started.outputDir);
    },
  );

  test('同名の配信者でも ID が異なれば別のフォルダに保存する', async () => {
    const first = await manager.startRecording('lv1', 'manual');
    getProgramInfo.mockResolvedValueOnce(info({ nicoliveProgramId: 'lv2', providerId: '200' }));
    const second = await manager.startRecording('lv2', 'manual');
    expect(first.outputDir).toBe(path.join(dir, 'out', '100_alice'));
    expect(second.outputDir).toBe(path.join(dir, 'out', '200_alice'));
  });

  test('映像が異常終了したら、最新の番組情報で連番の別ファイルとして再開する', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    getProgramInfo.mockResolvedValue(info({ webSocketUrl: 'wss://watch.example/2' }));
    first.resolve(
      finishedResult(first, { video: undefined, errors: [{ target: 'video', message: 'boom' }] }),
    );

    // 5 秒の待ちの後に再開する
    await skipRetryWait(5_500);
    const second = await nextRecordCall(1);
    expect(second.options.attempt).toBe(2);
    expect(second.options.prefetchBackwardComments).toBe(false);
    expect(second.options.programInfo?.webSocketUrl).toBe('wss://watch.example/2');
    expect(second.options.commentsPath).toBe(first.options.outputDir + '/rec.comments.csv');

    second.resolve(finishedResult(second));
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(history.get('lv1')?.videoPaths).toHaveLength(2);
    expect(history.get('lv1')?.attempt).toBe(2);
  });

  test.each(['csv', 'jsonl'])(
    '履歴の %s を持つ番組を再開すると、CSV だけを引き継ぐ',
    async (extension) => {
      const commentsPath = path.join(dir, `previous.comments.${extension}`);
      const original = extension === 'csv' ? 'existing csv\n' : '{"content":"過去のコメント"}\n';
      fs.writeFileSync(commentsPath, original);
      history.upsert({
        programId: 'lv1',
        title: 'タイトル',
        source: 'manual',
        state: 'failed',
        startedAt: new Date().toISOString(),
        commentCount: 42,
        videoBytes: 0,
        outputDir: dir,
        commentsPath,
      });
      await manager.startRecording('lv1', 'manual');
      const call = await nextRecordCall(0);
      expect(call.options.commentsPath).toBe(extension === 'csv' ? commentsPath : undefined);
      expect(call.options.prefetchBackwardComments).toBe(extension !== 'csv');
      expect((await manager.getRecordings())[0].commentCount).toBe(extension === 'csv' ? 42 : 0);
      expect(fs.readFileSync(commentsPath, 'utf8')).toBe(original);
    },
  );

  test('再開前の確認で番組情報が取れなくても、終了扱いにせずもう一度試す', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    getProgramInfo.mockRejectedValue(new Error('offline'));
    first.resolve(finishedResult(first, { video: { reason: 'idle', video: {} } }));

    await skipRetryWait(5_500);
    const second = await nextRecordCall(1);
    expect(second.options.attempt).toBe(2);
    expect(history.get('lv1')?.state).not.toBe('done');
  });

  test('録画中に出力ファイルが消えたら、そのパートを止めて別ファイルで再開する', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    const videoPath = path.join(first.options.outputDir, 'rec.ts');
    fs.mkdirSync(first.options.outputDir, { recursive: true });
    fs.writeFileSync(videoPath, 'x'.repeat(100));
    sendPaths(first, 1, videoPath, `${videoPath}.csv`);

    // サイズ監視でファイルを観測してから、フォルダごと消す
    await expectVideoBytes(manager, 100);
    fs.rmSync(first.options.outputDir, { recursive: true, force: true });

    // パートだけが abort され、録画全体の停止ではない (abort の後に後始末が反映されるので、容量の変化を待つ)
    await expectVideoBytes(manager, 0);
    expect(first.signal?.aborted).toBe(true);
    expect(manager.hasActiveRecordings()).toBe(true);
    const active = (await manager.getRecordings())[0];
    expect(active.videoPaths ?? []).not.toContain(videoPath);

    // 消えたパートの結果は採用されず、コメントファイルも消えているので次のパートで作り直す
    first.resolve(finishedResult(first, { video: { reason: 'aborted', video: {} }, videoPath }));
    await skipRetryWait(5_500);
    const second = await nextRecordCall(1);
    expect(second.options.attempt).toBe(2);
    expect(second.options.commentsPath).toBeUndefined();
    expect(second.options.prefetchBackwardComments).toBe(true);
    expect(history.get('lv1')?.videoPaths ?? []).not.toContain(videoPath);
    expect(history.get('lv1')?.videoPath).not.toBe(videoPath);

    second.resolve(finishedResult(second));
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(history.get('lv1')?.videoPaths).toEqual([`${second.options.outputDir}/rec_2.ts`]);
  });

  /** 1 パート目 (100 bytes) を実ファイル付きで終わらせ、2 パート目 (50 bytes) を書き込み中の状態にする */
  async function startSecondPart(): Promise<{
    firstPath: string;
    secondPath: string;
    second: RecordCall;
  }> {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    const firstPath = path.join(first.options.outputDir, 'rec.ts');
    fs.mkdirSync(first.options.outputDir, { recursive: true });
    fs.writeFileSync(firstPath, 'x'.repeat(100));
    sendPaths(first, 1, firstPath, `${firstPath}.csv`);
    await expectVideoBytes(manager, 100);
    first.resolve(
      finishedResult(first, { video: { reason: 'idle', video: {} }, videoPath: firstPath }),
    );

    // 再開待ちの間もサイズ監視は動くが、完了済みのパートを二重に数えない
    await skipRetryWait(5_500);
    const second = await nextRecordCall(1);
    expect(second.options.attempt).toBe(2);
    expect((await manager.getRecordings())[0]?.videoBytes).toBe(100);

    const secondPath = path.join(second.options.outputDir, 'rec_2.ts');
    fs.writeFileSync(secondPath, 'y'.repeat(50));
    sendPaths(second, 2, secondPath, `${firstPath}.csv`);
    await expectVideoBytes(manager, 150);
    return { firstPath, secondPath, second };
  }

  /** 消失で止まった 2 パート目を abort として終わらせ、3 パート目の呼び出しを返す */
  async function resumeAfterLostPart(second: RecordCall, secondPath: string): Promise<RecordCall> {
    second.resolve(
      finishedResult(second, { video: { reason: 'aborted', video: {} }, videoPath: secondPath }),
    );
    // 2 回目の再開は待ち時間が倍 (10 秒) になる
    await skipRetryWait(10_500);
    const third = await nextRecordCall(2);
    expect(third.options.attempt).toBe(3);
    return third;
  }

  test('2 パート目のファイルだけが消えても、残った 1 パート目を二重に数えない', async () => {
    const { firstPath, secondPath, second } = await startSecondPart();
    fs.rmSync(secondPath);
    await expectVideoBytes(manager, 100);
    expect(second.signal?.aborted).toBe(true);
    expect((await manager.getRecordings())[0]?.videoPaths).toEqual([firstPath]);

    // 再開待ちの間に 1 パート目が finishedPartBytes と stat の両方で数えられないこと
    await resumeAfterLostPart(second, secondPath);
    expect((await manager.getRecordings())[0]?.videoBytes).toBe(100);
    expect(history.get('lv1')?.videoPath).toBe(firstPath);
    expect(history.get('lv1')?.videoBytes).toBe(100);
  });

  test('2 パート目の録画中にフォルダごと消えたら、以前のパートも一覧と容量から外す', async () => {
    const { firstPath, secondPath, second } = await startSecondPart();
    fs.rmSync(second.options.outputDir, { recursive: true, force: true });
    await expectVideoBytes(manager, 0);
    expect(second.signal?.aborted).toBe(true);
    expect((await manager.getRecordings())[0]?.videoPaths ?? []).toEqual([]);

    // 代表パスが消えたファイルを指さない
    const third = await resumeAfterLostPart(second, secondPath);
    expect(history.get('lv1')?.videoPath).toBeUndefined();
    expect(history.get('lv1')?.videoPaths ?? []).not.toContain(firstPath);
    expect(history.get('lv1')?.videoBytes).toBe(0);

    third.resolve(finishedResult(third));
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(history.get('lv1')?.videoPaths).toEqual([`${third.options.outputDir}/rec_3.ts`]);
  });

  /** 2 パート目が消えた後、残った 1 パート目だけで確定し、3 パート目の合計も正しいことを確かめる */
  async function expectSecondPartDropped(firstPath: string): Promise<void> {
    // 再開待ちに入った時点で、後始末が反映された一覧と容量で履歴が確定している
    await waitFor(async () => (await manager.getRecordings())[0]?.state === 'starting');
    expect(history.get('lv1')?.videoPath).toBe(firstPath);
    expect(history.get('lv1')?.videoPaths).toEqual([firstPath]);
    expect(history.get('lv1')?.videoBytes).toBe(100);

    // 完了済みの合計も古い値 (消えたパート込み) になっていない
    await vi.advanceTimersByTimeAsync(10_500);
    const third = await nextRecordCall(2);
    const thirdPath = path.join(third.options.outputDir, 'rec_3.ts');
    fs.writeFileSync(thirdPath, 'z'.repeat(30));
    sendPaths(third, 3, thirdPath, `${firstPath}.csv`);
    await expectVideoBytes(manager, 130);
  }

  test('消失の後始末より先に録画本体が終わっても、後始末を待ってから状態を確定する', async () => {
    const { firstPath, secondPath, second } = await startSecondPart();
    // パート停止の abort と同時に (後始末の実在確認が終わる前に) 録画本体が自然終了する
    second.signal?.addEventListener('abort', () => {
      second.resolve(
        finishedResult(second, { video: { reason: 'endlist', video: {} }, videoPath: secondPath }),
      );
    });
    fs.rmSync(secondPath);
    await vi.advanceTimersByTimeAsync(1_000);
    await expectSecondPartDropped(firstPath);
  });

  test('ファイルが消えたのをサイズ監視が拾う前に録画本体が終わっても、消失として扱う', async () => {
    const { firstPath, secondPath, second } = await startSecondPart();
    // 削除の直後 (1 秒ごとの監視が見る前) に録画本体が idle で戻る
    fs.rmSync(secondPath);
    second.resolve(
      finishedResult(second, { video: { reason: 'idle', video: {} }, videoPath: secondPath }),
    );
    await expectSecondPartDropped(firstPath);
  });

  test('番組が終わっていたら、そこまでの録画で完了にする', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
    first.resolve(finishedResult(first, { video: { reason: 'disconnected', video: {} } }));

    await skipRetryWait(5_500);
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(recordCalls).toHaveLength(1);
    expect(history.get('lv1')?.error).toBeUndefined();
  });

  test('放送中に視聴 URL が取れなければ、完了ではなく理由付きの失敗にする', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    getProgramInfo.mockResolvedValue(info({ webSocketUrl: undefined }));
    first.resolve(finishedResult(first, { video: { reason: 'disconnected', video: {} } }));
    await skipRetryWait(5_500);
    await waitFor(() => history.get('lv1')?.state === 'failed');
    expect(history.get('lv1')?.error).toContain('視聴接続情報');
    expect(recordCalls).toHaveLength(1);
  });

  test('同じ番組の開始要求が重なっても録画は 1 本だけ', async () => {
    let release: ((value: NicoLiveProgramInfo) => void) | undefined;
    getProgramInfo.mockImplementationOnce(
      () => new Promise<NicoLiveProgramInfo>((resolve) => (release = resolve)),
    );
    const a = manager.startRecording('lv1', 'manual');
    const b = manager.startRecording('lv1', 'poll');
    await waitFor(() => release !== undefined);
    release!(info());
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    await nextRecordCall(0);
    expect(recordCalls).toHaveLength(1);
    expect(getProgramInfo).toHaveBeenCalledTimes(1);
  });

  test('停止すると録画本体に abort が伝わり、完了として履歴に残る', async () => {
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    expect(manager.stopRecording('lv1')).toBe(true);
    expect(call.signal?.aborted).toBe(true);
    call.resolve(finishedResult(call, { video: { reason: 'aborted', video: {} } }));
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(manager.stopRecording('lv1')).toBe(false);
  });

  test('空き容量がしきい値を下回るとバナー用の警告を出し、回復したら消す', async () => {
    let free = 1 * GIB;
    let probeFails = false;
    let probeCalls = 0;
    const lowManager = createManager({
      diskProbe: async () => {
        probeCalls += 1;
        if (probeFails) {
          throw new Error('statfs failed');
        }
        return free;
      },
    });
    try {
      settings.update({ minFreeSpaceGb: 5 });
      await lowManager.refreshDiskSpace();
      expect(lowManager.diskFreeBytes).toBe(free);
      expect((await lowManager.getAlerts(true)).map((a) => a.kind)).toEqual(['disk-space']);

      free = 50 * GIB;
      await lowManager.refreshDiskSpace();
      expect(await lowManager.getAlerts(true)).toEqual([]);

      // 取得に失敗しても回復とは見なさない
      free = 1 * GIB;
      await lowManager.refreshDiskSpace();
      expect((await lowManager.getAlerts(true)).map((a) => a.kind)).toEqual(['disk-space']);
      probeFails = true;
      await lowManager.refreshDiskSpace();
      expect((await lowManager.getAlerts(true)).map((a) => a.kind)).toEqual(['disk-space']);
      probeFails = false;

      // 保存先としきい値に関係ない設定変更では測り直さない
      let callsBefore = probeCalls;
      settings.update({ notificationsEnabled: false });
      expect(probeCalls).toBe(callsBefore);

      // 0 にすると確認しない (probe も呼ばない)
      callsBefore = probeCalls;
      settings.update({ minFreeSpaceGb: 0 });
      await lowManager.refreshDiskSpace();
      expect(await lowManager.getAlerts(true)).toEqual([]);
      expect(probeCalls).toBe(callsBefore);
    } finally {
      await lowManager.shutdown();
    }
  });

  test('空き容量の取得に失敗したとき、直前の値を使うのは同じ保存先のときだけ', async () => {
    let free = 1 * GIB;
    let probeFails = false;
    settings.update({ minFreeSpaceGb: 5 });
    const ctxManager = createManager({
      diskProbe: async () => {
        if (probeFails) {
          throw new Error('statfs failed');
        }
        return free;
      },
    });
    try {
      await ctxManager.refreshDiskSpace();
      expect((await ctxManager.getAlerts(true)).map((a) => a.kind)).toEqual(['disk-space']);

      // 同じ保存先でしきい値だけ下がり、取得に失敗しても、わかっている空き容量で判定し直す
      probeFails = true;
      settings.update({ minFreeSpaceGb: 0.5 });
      await ctxManager.refreshDiskSpace();
      expect(ctxManager.diskFreeBytes).toBe(free);
      expect(await ctxManager.getAlerts(true)).toEqual([]);
      settings.update({ minFreeSpaceGb: 5 });
      await ctxManager.refreshDiskSpace();
      expect((await ctxManager.getAlerts(true)).map((a) => a.kind)).toEqual(['disk-space']);

      // 保存先が変わって取得に失敗したら、古い保存先の警告は引き継がず不明に戻す
      settings.update({ outputDir: path.join(dir, 'other') });
      await ctxManager.refreshDiskSpace();
      expect(ctxManager.diskFreeBytes).toBeUndefined();
      expect(await ctxManager.getAlerts(true)).toEqual([]);

      // 取得できるようになれば新しい保存先の値で判定する
      probeFails = false;
      free = 50 * GIB;
      await ctxManager.refreshDiskSpace();
      expect(ctxManager.diskFreeBytes).toBe(free);
      expect(await ctxManager.getAlerts(true)).toEqual([]);
    } finally {
      await ctxManager.shutdown();
    }
  });

  test('空き容量の確認が重なっても、最新の呼び出しの結果だけを反映する', async () => {
    let resolveSlow: ((value: number) => void) | undefined;
    // 設定変更でも確認が走るので、しきい値は manager を作る前に決めておく
    settings.update({ minFreeSpaceGb: 5 });
    const probe = vi
      .fn<() => Promise<number>>(async () => 50 * GIB)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSlow = resolve)))
      .mockResolvedValueOnce(50 * GIB);
    const raceManager = createManager({
      diskProbe: probe,
    });
    try {
      // 古い保存先の遅い確認 (1 GiB) が、新しい保存先の速い確認 (50 GiB) の後に返る
      const slow = raceManager.refreshDiskSpace();
      await waitFor(() => resolveSlow !== undefined);
      await raceManager.refreshDiskSpace();
      resolveSlow!(1 * GIB);
      await slow;
      expect(raceManager.diskFreeBytes).toBe(50 * GIB);
      expect(await raceManager.getAlerts(true)).toEqual([]);
    } finally {
      await raceManager.shutdown();
    }
  });

  test('有効な対象が 0 件なら検知器も push も動かさず、対象が増えたら動かす', async () => {
    settings.update({ pushEnabled: true });
    await manager.start();
    expect(manager.detectorRunning).toBe(false);
    expect(detectors).toHaveLength(0);
    expect(pushManagers).toHaveLength(0);

    // 対象を足すと動き出し、無効にすると止まる
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await waitFor(() => manager.detectorRunning);
    expect(detectors.at(-1)?.running).toBe(true);
    expect(pushManagers.at(-1)?.started).toBe(true);
    settings.setTargetEnabled('100', false);
    await waitFor(() => !manager.detectorRunning);
    expect(detectors.at(-1)?.running).toBe(false);
    expect(pushManagers.at(-1)?.started).toBe(false);
  });

  test('一括削除は検知を一度だけ更新し、全対象を消しても進行中の録画は止めない', async () => {
    settings.restoreTargets(
      ['100', '200', '300'].map((userId) => ({
        userId,
        name: userId,
        enabled: true,
        addedAt: '2026-01-01T00:00:00Z',
      })),
    );
    await manager.start();
    await manager.startRecording('lv1', 'manual');
    const recording = await nextRecordCall(0);
    const detectorCount = detectors.length;

    settings.removeTargets(['100', '200']);
    await waitFor(() => detectors.length > detectorCount);
    await vi.advanceTimersByTimeAsync(0);
    expect(detectors).toHaveLength(detectorCount + 1);
    expect(recording.signal?.aborted).toBe(false);

    settings.removeTargets(['300']);
    await waitFor(() => !manager.detectorRunning);
    expect(manager.hasActiveRecordings()).toBe(true);
    expect(recording.signal?.aborted).toBe(false);
  });

  test('一括の有効状態変更は検知を一度だけ更新し、全件無効でも録画は続ける', async () => {
    const ids = ['100', '200', '300'];
    settings.restoreTargets(
      ids.map((userId) => ({
        userId,
        name: userId,
        enabled: true,
        addedAt: '2026-01-01T00:00:00Z',
      })),
    );
    await manager.start();
    await manager.startRecording('lv1', 'manual');
    const recording = await nextRecordCall(0);
    const detectorCount = detectors.length;

    settings.setTargetsEnabled(['100', '200'], false);
    await waitFor(() => detectors.length > detectorCount);
    await vi.advanceTimersByTimeAsync(0);
    expect(detectors).toHaveLength(detectorCount + 1);
    settings.setTargetsEnabled(ids, false);
    await waitFor(() => !manager.detectorRunning);
    expect(manager.hasActiveRecordings()).toBe(true);
    expect(recording.signal?.aborted).toBe(false);

    settings.setTargetsEnabled(ids, true);
    await waitFor(() => manager.detectorRunning);
    await vi.advanceTimersByTimeAsync(0);
    expect(detectors).toHaveLength(detectorCount + 2);
    expect(recording.signal?.aborted).toBe(false);
  });

  test('対象の並び替えは検知器を再起動しない', async () => {
    settings.restoreTargets(
      ['100', '200'].map((userId) => ({
        userId,
        name: userId,
        enabled: true,
        addedAt: '2026-01-01T00:00:00Z',
      })),
    );
    await manager.start();
    const detectorCount = detectors.length;
    settings.moveTarget('200', '100');
    await vi.advanceTimersByTimeAsync(0);
    expect(detectors).toHaveLength(detectorCount);
    expect(detectors.at(-1)?.running).toBe(true);
  });

  test('無関係な設定で検知器を作り直さず、再接続後も手動停止を保持する', async () => {
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    manager.stopRecording('lv1');
    first.resolve(finishedResult(first, { video: { reason: 'aborted', video: {} } }));
    await waitFor(() => !manager.hasActiveRecordings());
    const detectorCount = detectors.length;
    settings.update({ notificationsEnabled: false, outputDir: path.join(dir, 'other') });
    await vi.advanceTimersByTimeAsync(0);
    expect(detectors).toHaveLength(detectorCount);

    await manager.restartDetection();
    const detector = detectors.at(-1)!;
    expect(detector.seen.has('lv1')).toBe(true);
    detector.emit('program', {
      programId: 'lv1',
      providerId: '100',
      source: 'poll',
      alreadyOnAir: true,
      detectedAt: new Date(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(recordCalls).toHaveLength(1);

    // 自動再開は抑えるが、明示的に手動録画を始め直すことはできる
    await manager.startRecording('lv1', 'manual');
    await nextRecordCall(1);
    expect(recordCalls).toHaveLength(2);
  });

  test('ログアウトは検知を止め、push 解除後に Cookie を削除する。重複要求と設定変更でも再開しない', async () => {
    const logoutAuth = vi.spyOn(auth, 'logout');
    settings.update({ pushEnabled: true });
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    const detector = detectors.at(-1)!;
    const push = pushManagers.at(-1)!;
    const gate = deferred<void>();
    resetPush.mockImplementation(async () => {
      expect(await auth.getCookieHeader()).toBe('user_session=x');
      expect(detector.running).toBe(false);
      await gate.promise;
    });

    const logout = manager.logout();
    expect(manager.logout()).toBe(logout);
    await waitFor(() => resetPush.mock.calls.length === 1);
    expect(logoutAuth).not.toHaveBeenCalled();
    const detectorCount = detectors.length;
    settings.update({ pollIntervalSec: 60 });
    await manager.restartDetection();
    expect(detectors).toHaveLength(detectorCount);
    // 停止前から取得中だった通知が遅れて届いても録画しない
    detector.emit('program', { programId: 'lv1', providerId: '100', source: 'push' });
    expect(getProgramInfo).not.toHaveBeenCalled();

    gate.resolve();
    await logout;
    expect(logoutAuth).toHaveBeenCalledOnce();
    expect(await auth.isLoggedIn()).toBe(false);
    expect(push.started).toBe(false);
    expect(manager.detectorRunning).toBe(false);
    await manager.restartDetection();
    expect(manager.detectorRunning).toBe(false);
  });

  test('push が未起動でも解除し、解除に失敗してもログアウトする', async () => {
    const logoutAuth = vi.spyOn(auth, 'logout');
    await manager.start();
    expect(pushManagers).toHaveLength(0);
    resetPush.mockRejectedValue(new Error('cleanup failed'));
    await manager.logout();
    expect(resetPush).toHaveBeenCalledOnce();
    expect(logoutAuth).toHaveBeenCalledOnce();
    expect(await auth.isLoggedIn()).toBe(false);
  });

  test('ログイン確認待ちの検知再起動はログアウトで再開せず、購読解除へ進む', async () => {
    const logoutAuth = vi.spyOn(auth, 'logout');
    const gate = deferred<boolean>();
    vi.spyOn(auth, 'isLoggedIn').mockReturnValueOnce(gate.promise);
    const restarting = manager.restartDetection();
    const logout = manager.logout();
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    gate.resolve(true);
    await Promise.all([restarting, logout]);
    expect(detectors).toHaveLength(0);
    expect(resetPush).toHaveBeenCalledOnce();
    expect(logoutAuth).toHaveBeenCalledOnce();
  });

  test('ログアウトは全録画の終了と履歴保存を待ってから push 解除と Cookie 削除へ進む', async () => {
    await manager.startRecording('lv1', 'manual');
    await manager.startRecording('lv2', 'manual');
    const first = await nextRecordCall(0);
    const second = await nextRecordCall(1);
    const logoutAuth = vi.spyOn(auth, 'logout');
    const flush = vi.spyOn(history, 'flush');
    expect(manager.getActiveRecordingCount()).toBe(2);
    resetPush.mockImplementation(async () => {
      expect(manager.hasActiveRecordings()).toBe(false);
      expect(flush).toHaveBeenCalled();
      expect(history.get('lv1')).toMatchObject({ state: 'done' });
      expect(history.get('lv2')).toMatchObject({ state: 'done' });
    });

    const logout = manager.logout();
    await waitFor(() => first.signal?.aborted === true && second.signal?.aborted === true);
    expect(resetPush).not.toHaveBeenCalled();
    expect(logoutAuth).not.toHaveBeenCalled();
    await expect(manager.startRecording('lv3', 'manual')).rejects.toThrow('ログアウト処理中');
    first.resolve(finishedResult(first, { video: { reason: 'aborted', video: {} } }));
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(logoutAuth).not.toHaveBeenCalled();
    second.resolve(finishedResult(second, { video: { reason: 'aborted', video: {} } }));
    await logout;
    expect(logoutAuth).toHaveBeenCalledOnce();
    expect(manager.getActiveRecordingCount()).toBe(0);
  });

  test('ログアウトは番組情報の取得中の録画開始を取り消す', async () => {
    const gate = deferred<NicoLiveProgramInfo>();
    getProgramInfo.mockReturnValue(gate.promise);
    const starting = manager.startRecording('lv1', 'manual');
    const cancelled = expect(starting).rejects.toThrow('ログアウトのため');
    await waitFor(() => getProgramInfo.mock.calls.length === 1);
    expect(manager.getActiveRecordingCount()).toBe(1);
    const logout = manager.logout();
    gate.resolve(info());
    await Promise.all([cancelled, logout]);
    expect(recordCalls).toHaveLength(0);
    expect(manager.getActiveRecordingCount()).toBe(0);
  });

  test('ログアウトは再開待ちの録画を終了し、次のパートを作らない', async () => {
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    call.resolve(finishedResult(call, { video: { reason: 'idle', video: {} } }));
    await waitFor(async () => (await manager.getRecordings())[0]?.state === 'starting');
    await manager.logout();
    expect(history.get('lv1')?.state).toBe('done');
    expect(recordCalls).toHaveLength(1);
  });

  test('ログアウトが再開前の番組情報取得と重なっても録画を再開しない', async () => {
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    const gate = deferred<NicoLiveProgramInfo>();
    getProgramInfo.mockReturnValue(gate.promise);
    call.resolve(finishedResult(call, { video: { reason: 'idle', video: {} } }));
    await waitFor(async () => (await manager.getRecordings())[0]?.state === 'starting');
    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => getProgramInfo.mock.calls.length === 2);
    const logout = manager.logout();
    await waitFor(() => call.signal?.aborted === true);
    gate.resolve(info());
    await logout;
    expect(history.get('lv1')?.state).toBe('done');
    expect(recordCalls).toHaveLength(1);
  });

  test('push 停止待ちの検知再起動もログアウトで再開しない', async () => {
    settings.update({ pushEnabled: true });
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    const gate = deferred<void>();
    const stop = vi.spyOn(pushManagers.at(-1)!, 'stop').mockReturnValue(gate.promise);
    settings.update({ pushEnabled: false });
    await waitFor(() => stop.mock.calls.length === 1);
    const detectorCount = detectors.length;
    const logout = manager.logout();
    gate.resolve();
    await logout;
    expect(detectors).toHaveLength(detectorCount);
    expect(manager.detectorRunning).toBe(false);
    expect(resetPush).toHaveBeenCalledOnce();
  });

  test('検知の再起動中に来た設定変更は、終わってから最新の設定で反映する', async () => {
    // ログイン確認を遅らせて、再起動の途中で対象を追加する
    let release: ((loggedIn: boolean) => void) | undefined;
    const auth = fakeAuth();
    Object.assign(auth, {
      isLoggedIn: () => new Promise<boolean>((resolve) => (release = resolve)),
    });
    const slowManager = createManager({ auth });
    try {
      const started = slowManager.start();
      await waitFor(() => release !== undefined);
      settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
      const first = release!;
      release = undefined;
      first(true);
      // 2 周目のログイン確認が始まったら、対象ありとして検知器が動く
      await waitFor(() => release !== undefined);
      release!(true);
      await started;
      await waitFor(() => slowManager.detectorRunning);
      expect(detectors.at(-1)?.running).toBe(true);
    } finally {
      await slowManager.shutdown();
    }
  });

  test('検知した放送は対象の配信者のときだけ録画する', async () => {
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    const detector = detectors[detectors.length - 1];
    expect(detector.running).toBe(true);

    detector.emit('program', {
      programId: 'lv2',
      title: 'x',
      providerId: '999',
      source: 'poll',
      detectedAt: new Date(),
      alreadyOnAir: false,
    });
    detector.emit('program', {
      programId: 'lv1',
      title: 'x',
      providerId: '100',
      source: 'push',
      detectedAt: new Date(),
      alreadyOnAir: false,
    });
    const call = await nextRecordCall(0);
    expect(call.options.programId).toBe('lv1');
    expect(recordCalls).toHaveLength(1);
    expect(detector.seen.has('lv1')).toBe(true);
  });

  // タイムシフトの開始分岐を追加しても、自動検知の入口と既存ジョブの独立性を保つ。
  test.each(['push', 'poll'] as const)(
    '自動検知 %s は終了済み番組を開始せず、開始再試行も打ち切る',
    async (source) => {
      settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
      await manager.start();
      const detector = detectors.at(-1)!;
      getProgramInfo.mockResolvedValue(
        info({ status: NicoLiveProgramStatus.ended, hasTimeshift: true }),
      );
      const start = vi.spyOn(manager, 'startRecording');
      detector.emit('program', {
        programId: 'lv1',
        providerId: '100',
        source,
        alreadyOnAir: false,
      });
      await expect(start.mock.results[0].value).rejects.toThrow(/ended$/);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(start).toHaveBeenCalledTimes(1);
      expect(getProgramInfo).toHaveBeenCalledTimes(1);
      expect(recordCalls).toHaveLength(0);
      expect(history.get('lv1')).toBeUndefined();
      expect(manager.hasActiveRecordings()).toBe(false);
    },
  );

  test.each(['push', 'poll'] as const)(
    '自動検知 %s の重複通知でもライブ録画を一度だけ開始する',
    async (source) => {
      settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
      await manager.start();
      const detector = detectors.at(-1)!;
      const program = { programId: 'lv1', providerId: '100', source, alreadyOnAir: false };
      detector.emit('program', program);
      detector.emit('program', { ...program, source: source === 'push' ? 'poll' : 'push' });
      const call = await nextRecordCall(0);
      expect(recordCalls).toHaveLength(1);
      expect(getProgramInfo).toHaveBeenCalledTimes(1);
      expect(call.options).toMatchObject({
        programId: 'lv1',
        prefetchBackwardComments: true,
        programInfo: { status: NicoLiveProgramStatus.onAir },
      });
      expect(history.get('lv1')?.source).toBe(source);
      call.resolve(finishedResult(call));
      await waitFor(() => history.get('lv1')?.state === 'done');
      expect(history.get('lv1')?.error).toBeUndefined();
    },
  );

  test.each([false, true])(
    '起動時の放送中番組は設定=%sに従い、新規放送は常に録画する',
    async (recordOngoingOnStart) => {
      settings.update({ recordOngoingOnStart });
      settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
      await manager.start();
      const detector = detectors.at(-1)!;
      const start = vi.spyOn(manager, 'startRecording');
      detector.emit('program', {
        programId: 'lv1',
        providerId: '100',
        source: 'poll',
        alreadyOnAir: true,
      });
      if (recordOngoingOnStart) await nextRecordCall(0);
      else expect(start).not.toHaveBeenCalled();
      getProgramInfo.mockResolvedValueOnce(info({ nicoliveProgramId: 'lv2' }));
      detector.emit('program', {
        programId: 'lv2',
        providerId: '100',
        source: 'push',
        alreadyOnAir: false,
      });
      const next = await nextRecordCall(recordOngoingOnStart ? 1 : 0);
      expect(next.options.programId).toBe('lv2');
    },
  );

  test('手動録画の終了を待たずに自動録画を開始し、手動停止が他の録画へ波及しない', async () => {
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    getProgramInfo.mockResolvedValueOnce(info({ nicoliveProgramId: 'lv2' }));
    await manager.startRecording('lv2', 'manual');
    const manual = await nextRecordCall(0);
    detectors.at(-1)!.emit('program', {
      programId: 'lv1',
      providerId: '100',
      source: 'push',
      alreadyOnAir: false,
    });
    const automatic = await nextRecordCall(1);
    expect(automatic.options.programId).toBe('lv1');
    expect(history.get('lv1')?.source).toBe('push');
    manager.stopRecording('lv2');
    expect(manual.signal?.aborted).toBe(true);
    expect(automatic.signal?.aborted).toBe(false);
    manual.resolve(finishedResult(manual, { video: { reason: 'aborted', video: {} } }));
    await waitFor(() => history.get('lv2')?.state === 'done');
    expect(manager.hasActiveRecordings()).toBe(true);
    expect(automatic.signal?.aborted).toBe(false);
    automatic.resolve(finishedResult(automatic));
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(history.get('lv1')?.error).toBeUndefined();
  });

  test('自動録画でコメントだけ失敗しても映像を取り直さず、一部失敗として結果を残す', async () => {
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    detectors.at(-1)!.emit('program', {
      programId: 'lv1',
      providerId: '100',
      source: 'poll',
      alreadyOnAir: false,
    });
    const call = await nextRecordCall(0);
    call.resolve(
      finishedResult(call, { errors: [{ target: 'comments', message: 'コメント取得失敗' }] }),
    );
    await waitFor(() => history.get('lv1')?.state === 'done');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recordCalls).toHaveLength(1);
    expect(history.get('lv1')).toMatchObject({
      state: 'done',
      source: 'poll',
      error: 'comments: コメント取得失敗',
    });
  });

  test('終了処理は開始処理中の録画を待ち、その後の開始は拒否する', async () => {
    let release: ((value: NicoLiveProgramInfo) => void) | undefined;
    getProgramInfo.mockImplementationOnce(
      () => new Promise<NicoLiveProgramInfo>((resolve) => (release = resolve)),
    );
    const starting = manager.startRecording('lv1', 'manual');
    await waitFor(() => release !== undefined);
    const shutdown = manager.shutdown();
    release!(info());
    await expect(starting).rejects.toThrow(/shutting down/);
    await shutdown;
    expect(recordCalls).toHaveLength(0);
    expect(manager.hasActiveRecordings()).toBe(false);
  });
});
