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

vi.mock('../../src/main/core/push/web-push-manager', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    WebPushManager: class extends Emitter {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      getStatus(): unknown {
        return { state: 'stopped', niconicoRegistered: false };
      }
    },
  };
});

import { RecordingManager } from '../../src/main/app/recording-manager';

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
  Object.assign(auth, {
    isLoggedIn: async () => true,
    getCookieHeader: async () => 'user_session=x',
    getCookieRecord: async () => ({ user_session: 'x' }),
  });
  return auth;
}

/** 録画本体の呼び出しを 1 件取り出す (まだ来ていなければ待つ) */
async function nextRecordCall(index: number): Promise<RecordCall> {
  await waitFor(() => recordCalls.length > index, 3000, 5);
  return recordCalls[index];
}

function finishedResult(call: RecordCall, patch: Record<string, unknown> = {}): unknown {
  const attempt = call.options.attempt ?? 1;
  const base = `${call.options.outputDir}/rec${attempt > 1 ? `_${attempt}` : ''}`;
  call.options.onPaths?.({
    attempt,
    videoPath: `${base}.ts`,
    commentsPath: `${base}.comments.jsonl`,
  });
  return {
    programId: call.options.programId,
    programInfo: call.options.programInfo,
    attempt,
    baseName: 'rec',
    videoPath: `${base}.ts`,
    commentsPath: `${base}.comments.jsonl`,
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

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-manager-'));
    recordCalls.length = 0;
    detectors.length = 0;
    getProgramInfo.mockReset();
    getProgramInfo.mockResolvedValue(info());
    settings = new SettingsStore(path.join(dir, 'settings.json'), path.join(dir, 'out'));
    settings.update({ pushEnabled: false });
    history = new HistoryStore(path.join(dir, 'history.json'));
    manager = new RecordingManager({
      settings,
      auth: fakeAuth(),
      pushStore: {
        load: async () => undefined,
        save: async () => undefined,
        clear: async () => undefined,
      },
      history,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      ffmpegPath: '/bin/false',
    });
  });

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

  test('終了済みや取得できない番組は開始せず、コード付きの例外にする', async () => {
    getProgramInfo.mockResolvedValueOnce(info({ status: NicoLiveProgramStatus.ended }));
    await expect(manager.startRecording('lv1', 'manual')).rejects.toSatisfy(
      (e: Error) => parseErrorCode(e.message) === ERROR_CODES.programUnavailable,
    );
    getProgramInfo.mockRejectedValueOnce(new Error('network'));
    await expect(manager.startRecording('lv1', 'manual')).rejects.toSatisfy(
      (e: Error) => parseErrorCode(e.message) === ERROR_CODES.programUnavailable,
    );
    expect(recordCalls).toHaveLength(0);
    expect(await manager.getRecordings()).toEqual([]);
  });

  test('録画を始めて完了すると、履歴に配信者フォルダとファイルが残る', async () => {
    const started = await manager.startRecording('lv1', 'manual');
    expect(started).toMatchObject({ providerName: 'alice', title: 'タイトル' });
    expect(['starting', 'recording']).toContain(started.state);
    expect(started.outputDir).toBe(path.join(dir, 'out', 'alice'));

    const call = await nextRecordCall(0);
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
    expect(entry.commentsPath).toBe(`${entry.outputDir}/rec.comments.jsonl`);
    expect(entry.endedAt).toBeDefined();
    expect(manager.hasActiveRecordings()).toBe(false);
  });

  test('映像が異常終了したら、最新の番組情報で連番の別ファイルとして再開する', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    getProgramInfo.mockResolvedValue(info({ webSocketUrl: 'wss://watch.example/2' }));
    first.resolve(
      finishedResult(first, { video: undefined, errors: [{ target: 'video', message: 'boom' }] }),
    );

    // 5 秒の待ちの後に再開する
    await vi.advanceTimersByTimeAsync(5_500);
    const second = await nextRecordCall(1);
    expect(second.options.attempt).toBe(2);
    expect(second.options.prefetchBackwardComments).toBe(false);
    expect(second.options.programInfo?.webSocketUrl).toBe('wss://watch.example/2');
    expect(second.options.commentsPath).toBe(first.options.outputDir + '/rec.comments.jsonl');

    second.resolve(finishedResult(second));
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(history.get('lv1')?.videoPaths).toHaveLength(2);
    expect(history.get('lv1')?.attempt).toBe(2);
  });

  test('再開前の確認で番組情報が取れなくても、終了扱いにせずもう一度試す', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    getProgramInfo.mockRejectedValue(new Error('offline'));
    first.resolve(finishedResult(first, { video: { reason: 'idle', video: {} } }));

    await vi.advanceTimersByTimeAsync(5_500);
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
    first.options.onPaths?.({ attempt: 1, videoPath, commentsPath: `${videoPath}.jsonl` });

    // 1 秒ごとのサイズ監視でファイルを観測してから、フォルダごと消す (stat は実 I/O なので完了を待つ)
    await waitFor(async () => (await manager.getRecordings())[0]?.videoBytes === 100, 5000);
    fs.rmSync(first.options.outputDir, { recursive: true, force: true });

    // パートだけが abort され、録画全体の停止ではない
    await waitFor(() => first.signal?.aborted === true, 5000);
    expect(manager.hasActiveRecordings()).toBe(true);
    const active = (await manager.getRecordings())[0];
    expect(active.videoBytes).toBe(0);
    expect(active.videoPaths ?? []).not.toContain(videoPath);

    first.resolve(finishedResult(first, { video: { reason: 'aborted', video: {} } }));
    await vi.advanceTimersByTimeAsync(5_500);
    const second = await nextRecordCall(1);
    expect(second.options.attempt).toBe(2);
    second.resolve(finishedResult(second));
    await waitFor(() => history.get('lv1')?.state === 'done');
  });

  test('番組が終わっていたら、そこまでの録画で完了にする', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
    first.resolve(finishedResult(first, { video: { reason: 'disconnected', video: {} } }));

    await vi.advanceTimersByTimeAsync(5_500);
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(recordCalls).toHaveLength(1);
    expect(history.get('lv1')?.error).toBeUndefined();
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
