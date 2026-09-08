import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordProgram } from '../../../src/main/core/recorder/program-recorder';
import { recordVideo } from '../../../src/main/core/recorder/video-recorder';
import { recordComments } from '../../../src/main/core/recorder/comment-recorder';
import type {
  VideoRecordResult,
  CommentRecordResult,
} from '../../../src/main/core/recorder/recording-types';
import {
  NicoLiveProgramStatus,
  type NicoLiveProgramInfo,
} from '../../../src/main/vendor/nico-client/types';

// 下位レコーダーを差し替え、まとめ役と出力先・メタデータ保存は実物で確認する。
vi.mock('../../../src/main/core/recorder/video-recorder', () => ({ recordVideo: vi.fn() }));
vi.mock('../../../src/main/core/recorder/comment-recorder', () => ({ recordComments: vi.fn() }));
vi.mock('../../../src/main/vendor/nico-client/NicoClient', () => ({
  NicoClient: class {
    getProgramInfo() {
      throw new Error('取得済みの番組情報を再利用すること');
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const programInfo: NicoLiveProgramInfo = {
  nicoliveProgramId: 'lv1',
  title: 'ライブ',
  description: '',
  providerId: '100',
  status: NicoLiveProgramStatus.onAir,
  openTime: 1000,
  beginTime: 1000,
  vposBaseTime: 1000,
  endTime: 0,
  scheduledEndTime: 0,
  hasTimeshift: true,
  supplierIntroduction: '',
  commentCount: 0,
  watchCount: 0,
  webSocketUrl: 'wss://example.test/watch',
};
const at = new Date('2026-09-08T00:00:00Z');
let dir: string;
let video: ReturnType<typeof deferred<VideoRecordResult>>;
let comments: ReturnType<typeof deferred<CommentRecordResult>>;
let started: ReturnType<typeof deferred<void>>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nlr-program-lifecycle-'));
  video = deferred<VideoRecordResult>();
  comments = deferred<CommentRecordResult>();
  started = deferred<void>();
  vi.mocked(recordVideo)
    .mockReset()
    .mockImplementation(() => video.promise);
  vi.mocked(recordComments)
    .mockReset()
    .mockImplementation(() => {
      started.resolve();
      return comments.promise;
    });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function videoResult(reason: VideoRecordResult['reason'] = 'endlist'): VideoRecordResult {
  return {
    outputPath: path.join(dir, 'video.ts'),
    startedAt: at,
    endedAt: at,
    reason,
    video: { reason: 'endlist', segments: 3, bytes: 300 },
    audio: { reason: 'endlist', segments: 3, bytes: 30 },
    ffmpegExitCode: 0,
  };
}
function commentResult(aborted = false): CommentRecordResult {
  return {
    outputPath: path.join(dir, 'comments.csv'),
    startedAt: at,
    endedAt: at,
    count: 2,
    aborted,
  };
}
function begin(signal?: AbortSignal) {
  // mode未指定の既存呼び出しを維持する。将来timeshiftが加わってもライブで動くことを固定する。
  return recordProgram({ programId: 'lv1', outputDir: dir, programInfo }, signal);
}

test.each(['video', 'comments'] as const)(
  'ライブの%sが先に正常終了しても、残りを中止せず最後まで待つ',
  async (first) => {
    const task = begin();
    let finished = false;
    void task.then(() => {
      finished = true;
    });
    await started.promise;
    expect(vi.mocked(recordComments).mock.calls[0][0].prefetchBackward).toBe(true);
    if (first === 'video') video.resolve(videoResult());
    else comments.resolve(commentResult());
    await (first === 'video' ? video.promise : comments.promise);
    expect(finished).toBe(false);
    expect(vi.mocked(recordVideo).mock.calls[0][1]?.aborted).toBe(false);
    expect(vi.mocked(recordComments).mock.calls[0][1]?.aborted).toBe(false);
    video.resolve(videoResult());
    comments.resolve(commentResult());
    const result = await task;
    expect(result.errors).toEqual([]);
    expect(result.video?.reason).toBe('endlist');
    expect(result.comments?.count).toBe(2);
    const metadata: unknown = JSON.parse(await fs.readFile(result.metadataPath, 'utf8'));
    expect(metadata).toMatchObject({
      video: { segments: 3, bytes: 330 },
      comments: { count: 2 },
      errors: [],
    });
  },
);

test('コメントだけの失敗でライブ映像を止めず、映像結果とコメントエラーを両方残す', async () => {
  const task = begin();
  await started.promise;
  comments.reject(new Error('comments unavailable'));
  await comments.promise.catch(() => {});
  expect(vi.mocked(recordVideo).mock.calls[0][1]?.aborted).toBe(false);
  video.resolve(videoResult());
  const result = await task;
  expect(result.video?.reason).toBe('endlist');
  expect(result.comments).toBeUndefined();
  expect(result.errors).toEqual([{ target: 'comments', message: 'comments unavailable' }]);
});

test.each(['rejected', 'idle', 'disconnected'] as const)(
  'ライブ映像の%sでコメントを止め、後始末を待って結果を返す',
  async (reason) => {
    const task = begin();
    let finished = false;
    void task.then(() => {
      finished = true;
    });
    await started.promise;
    const signal = vi.mocked(recordComments).mock.calls[0][1]!;
    const aborted = deferred<void>();
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    if (reason === 'rejected') video.reject(new Error('video failed'));
    else video.resolve(videoResult(reason));
    await aborted.promise;
    expect(finished).toBe(false);
    comments.resolve(commentResult(true));
    const result = await task;
    expect(result.comments?.aborted).toBe(true);
    const metadata: unknown = JSON.parse(await fs.readFile(result.metadataPath, 'utf8'));
    expect(metadata).toMatchObject({ comments: { count: 2 } });
    if (reason === 'rejected')
      expect(result.errors).toEqual([{ target: 'video', message: 'video failed' }]);
    else expect(result.video?.reason).toBe(reason);
  },
);

test('外側からの停止で映像とコメントの両方を止め、両方の終了まで待つ', async () => {
  const stop = new AbortController();
  const task = begin(stop.signal);
  await started.promise;
  stop.abort();
  expect(vi.mocked(recordVideo).mock.calls[0][1]?.aborted).toBe(true);
  expect(vi.mocked(recordComments).mock.calls[0][1]?.aborted).toBe(true);
  video.resolve(videoResult('aborted'));
  comments.resolve(commentResult(true));
  const result = await task;
  expect(result.video?.reason).toBe('aborted');
  expect(result.comments?.aborted).toBe(true);
});

test('ライブの別パート再開で既存CSVと過去取得無効の指定を引き継ぐ', async () => {
  const commentsPath = path.join(dir, 'previous.comments.csv');
  await fs.writeFile(commentsPath, 'existing comments');
  const task = recordProgram(
    {
      programId: 'lv1',
      outputDir: dir,
      programInfo,
      attempt: 2,
      commentsPath,
      prefetchBackwardComments: false,
    },
    new AbortController().signal,
  );
  await started.promise;
  expect(vi.mocked(recordComments).mock.calls[0][0]).toMatchObject({
    outputPath: commentsPath,
    prefetchBackward: false,
    programInfo,
  });
  expect(vi.mocked(recordVideo).mock.calls[0][0].outputPath).toMatch(/_2\.ts$/);
  video.resolve(videoResult());
  comments.resolve(commentResult());
  const result = await task;
  expect(result.commentsPath).toBe(commentsPath);
  expect(await fs.readFile(commentsPath, 'utf8')).toBe('existing comments');
});
