import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordProgram, buildBaseName } from '../../../src/main/core/recorder/program-recorder';
import { reserveTimeshiftPaths } from '../../../src/main/core/recorder/timeshift-program-recorder';
import { openTimeshiftSession } from '../../../src/main/core/nico/timeshift-session';
import { recordTimeshiftVideo } from '../../../src/main/core/recorder/timeshift-video-recorder';
import { recordTimeshiftComments } from '../../../src/main/core/recorder/timeshift-comment-recorder';
import { TimeshiftError } from '../../../src/main/core/nico/timeshift-common';
import type { TimeshiftProgress } from '../../../src/shared/types';
import {
  NicoLiveProgramStatus,
  type NicoLiveProgramInfo,
} from '../../../src/main/vendor/nico-client/types';

vi.mock('../../../src/main/core/nico/timeshift-session', () => ({ openTimeshiftSession: vi.fn() }));
vi.mock('../../../src/main/core/recorder/timeshift-video-recorder', () => ({
  recordTimeshiftVideo: vi.fn(),
}));
vi.mock('../../../src/main/core/recorder/timeshift-comment-recorder', () => ({
  recordTimeshiftComments: vi.fn(),
}));
vi.mock('../../../src/main/core/recorder/video-recorder', () => ({
  recordVideo: () => {
    throw new Error('ライブを呼ばないこと');
  },
}));
vi.mock('../../../src/main/core/recorder/comment-recorder', () => ({
  recordComments: () => {
    throw new Error('ライブを呼ばないこと');
  },
}));
const info: NicoLiveProgramInfo = {
  nicoliveProgramId: 'lv1',
  title: 'timeshift',
  description: '',
  providerId: '1',
  status: NicoLiveProgramStatus.ended,
  openTime: 1000,
  beginTime: 1000,
  endTime: 1100,
  vposBaseTime: 1000,
  scheduledEndTime: 1100,
  hasTimeshift: true,
  supplierIntroduction: '',
  commentCount: 0,
  watchCount: 0,
  webSocketUrl: 'wss://example.test/view?secret=TOKEN',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
let dir: string;
let session: ReturnType<typeof openTimeshiftSession>;
const at = new Date();
beforeEach(async () => {
  vi.resetAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nlr-ts-program-'));
  session = {
    signal: new AbortController().signal,
    stream: Promise.resolve({
      uri: 'https://example.test/secret',
      cookies: [],
      quality: '',
      availableQualities: [],
      receivedAt: at,
    }),
    comments: Promise.resolve('https://example.test/comments?secret=TOKEN'),
    close: vi.fn(),
  };
  vi.mocked(openTimeshiftSession).mockReturnValue(session);
  vi.mocked(recordTimeshiftVideo).mockImplementation(async (_stream, options) => {
    await fs.writeFile(options.outputPath, 'video');
    return {
      outputPath: options.outputPath,
      reason: 'endlist',
      video: { reason: 'endlist', segments: 1, bytes: 5 },
      startedAt: at,
      endedAt: at,
      ffmpegExitCode: 0,
    };
  });
  vi.mocked(recordTimeshiftComments).mockImplementation(async (_uri, outputPath) => {
    await fs.writeFile(outputPath, 'comments');
    return {
      outputPath,
      startedAt: at,
      endedAt: at,
      count: 2,
      aborted: false,
      status: 'complete',
      reason: 'snapshot-exhausted',
      sorted: true,
      duplicates: 0,
      invalidCount: 0,
    };
  });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const begin = (signal?: AbortSignal, onTimeshiftProgress?: (progress: TimeshiftProgress) => void) =>
  recordProgram(
    {
      programId: 'lv1',
      programInfo: info,
      outputDir: dir,
      mode: 'timeshift',
      cookies: { user_session: 'SECRET_COOKIE' },
      onTimeshiftProgress,
    },
    signal,
  );

test('終了済みの手動録画を有限取得し、メタデータに認証情報を含めない', async () => {
  const result = await begin();
  expect(result.timeshift?.completion).toBe('complete');
  expect(session.close).toHaveBeenCalledOnce();
  const json = await fs.readFile(result.metadataPath, 'utf8');
  expect(json).not.toMatch(/TOKEN|SECRET_COOKIE|wss:|https:/);
  expect(JSON.parse(json)).toMatchObject({
    mode: 'timeshift',
    timeshift: { completion: 'complete' },
    comments: { count: 2 },
  });
});

test.each(['.ts', '.comments.csv', '.json', '.comments.csv.sorting'])(
  '%s だけ残っていても別の連番へ進み既存内容を保つ',
  async (suffix) => {
    const old = path.join(dir, buildBaseName(info) + suffix);
    await fs.writeFile(old, 'old');
    const paths = await reserveTimeshiftPaths(dir, info);
    expect(paths.attempt).toBe(2);
    expect(await fs.readFile(old, 'utf8')).toBe('old');
  },
);

test('同時に出力先を確保しても同じファイルを使わない', async () => {
  const paths = await Promise.all([
    reserveTimeshiftPaths(dir, info),
    reserveTimeshiftPaths(dir, info),
  ]);
  expect(new Set(paths.map((entry) => entry.videoPath)).size).toBe(2);
});

test.each(['video', 'comments'] as const)(
  '%s が先に正常終了してももう一方を待つ',
  async (first) => {
    const waiting = deferred<void>();
    const entered = deferred<void>();
    if (first === 'video') {
      const callback = vi.mocked(recordTimeshiftComments).getMockImplementation()!;
      vi.mocked(recordTimeshiftComments).mockImplementation(async (...args) => {
        entered.resolve();
        await waiting.promise;
        return callback(...args);
      });
    } else {
      const callback = vi.mocked(recordTimeshiftVideo).getMockImplementation()!;
      vi.mocked(recordTimeshiftVideo).mockImplementation(async (...args) => {
        entered.resolve();
        await waiting.promise;
        return callback(...args);
      });
    }
    const task = begin();
    await entered.promise;
    expect(session.close).not.toHaveBeenCalled();
    waiting.resolve();
    expect((await task).timeshift?.completion).toBe('complete');
  },
);

test('コメント失敗で映像を止めず一部失敗として保存する', async () => {
  vi.mocked(recordTimeshiftComments).mockRejectedValue(new Error('https://secret.test/TOKEN'));
  const result = await begin();
  expect(result.video?.reason).toBe('endlist');
  expect(result.timeshift).toMatchObject({
    completion: 'partial',
    progress: { comments: 'partial' },
  });
  expect(JSON.stringify(result.errors)).not.toContain('TOKEN');
  expect(vi.mocked(recordTimeshiftVideo).mock.calls[0][2].aborted).toBe(false);
});

test.each([false, true])(
  '動画欠落後もコメントを完走する（コメントURI待機=%s）',
  async (waitingForUri) => {
    const commentsPhase = deferred<void>();
    const finishComments = deferred<void>();
    const commentsUri = deferred<string>();
    if (waitingForUri) session.comments = commentsUri.promise;
    const originalComments = vi.mocked(recordTimeshiftComments).getMockImplementation()!;
    vi.mocked(recordTimeshiftComments).mockImplementation(async (...args) => {
      await finishComments.promise;
      args[2].throwIfAborted();
      return originalComments(...args);
    });
    vi.mocked(recordTimeshiftVideo).mockImplementation(async (_stream, options) => {
      await fs.writeFile(options.outputPath, 'partial video');
      throw new TimeshiftError('SEGMENTS_INCOMPLETE');
    });
    const task = begin(undefined, (progress) => {
      if (progress.phase === 'comments') commentsPhase.resolve();
    });
    await commentsPhase.promise;
    expect(session.close).not.toHaveBeenCalled();
    expect(vi.mocked(recordTimeshiftVideo).mock.calls[0][2].aborted).toBe(false);
    commentsUri.resolve('https://example.test/comments');
    finishComments.resolve();
    const result = await task;
    expect(result.video).toBeUndefined();
    expect(result.timeshift).toMatchObject({
      completion: 'partial',
      progress: { phase: 'comments', comments: 'complete' },
      comments: { status: 'complete', sorted: true },
    });
    expect(result.errors).toEqual([
      { target: 'video', message: 'タイムシフト: SEGMENTS_INCOMPLETE' },
    ]);
    expect(await fs.readFile(result.videoPath, 'utf8')).toBe('partial video');
    expect(await fs.readFile(result.commentsPath, 'utf8')).toBe('comments');
    expect(JSON.parse(await fs.readFile(result.metadataPath, 'utf8'))).toMatchObject({
      timeshift: { completion: 'partial', comments: { status: 'complete' } },
      comments: { count: 2 },
    });
    expect(session.close).toHaveBeenCalledOnce();
  },
);

test.each(['user', 'connection'] as const)(
  '動画欠落後のコメント待ちも%sによる停止に従う',
  async (cause) => {
    const stop = new AbortController();
    const connection = new AbortController();
    const commentsPhase = deferred<void>();
    session.signal = AbortSignal.any([stop.signal, connection.signal]);
    const originalComments = vi.mocked(recordTimeshiftComments).getMockImplementation()!;
    vi.mocked(recordTimeshiftComments).mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => {
        if (args[2].aborted) resolve();
        else args[2].addEventListener('abort', () => resolve(), { once: true });
      });
      return { ...(await originalComments(...args)), status: 'partial', reason: 'interrupted' };
    });
    vi.mocked(recordTimeshiftVideo).mockRejectedValue(new TimeshiftError('SEGMENTS_INCOMPLETE'));
    const task = begin(stop.signal, (progress) => {
      if (progress.phase === 'comments') commentsPhase.resolve();
    });
    await commentsPhase.promise;
    if (cause === 'user') stop.abort();
    else connection.abort(new TimeshiftError('SESSION_DISCONNECTED'));
    const result = await task;
    expect(vi.mocked(recordTimeshiftComments).mock.calls[0][2].aborted).toBe(true);
    expect(result.timeshift?.completion).toBe(cause === 'user' ? 'cancelled' : 'partial');
    expect(result.timeshift?.progress.comments).toBe('partial');
    expect(await fs.readFile(result.commentsPath, 'utf8')).toBe('comments');
    expect(session.close).toHaveBeenCalledOnce();
  },
);

test('映像失敗でコメントを止め、クリーンアップまで待つ', async () => {
  const started = deferred<void>();
  const cleaned = deferred<void>();
  vi.mocked(recordTimeshiftComments).mockImplementation(async (_uri, _output, signal) => {
    started.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    await cleaned.promise;
    throw new Error('aborted');
  });
  vi.mocked(recordTimeshiftVideo).mockImplementation(async () => {
    await started.promise;
    throw new Error('failed');
  });
  const task = begin();
  await started.promise;
  let done = false;
  void task.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  cleaned.resolve();
  expect((await task).timeshift?.completion).toBe('partial');
  expect(vi.mocked(recordTimeshiftComments).mock.calls[0][2].aborted).toBe(true);
});

test('ユーザー停止は失敗・完了と区別し両方の取得を止める', async () => {
  const started = deferred<void>();
  const stop = new AbortController();
  vi.mocked(openTimeshiftSession).mockImplementation((_url, _cookies, signal) => ({
    ...session,
    signal,
  }));
  vi.mocked(recordTimeshiftVideo).mockImplementation(async (_stream, _options, signal) => {
    started.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    throw new Error('aborted');
  });
  const task = begin(stop.signal);
  await started.promise;
  stop.abort();
  const result = await task;
  expect(result.timeshift?.completion).toBe('cancelled');
  expect(result.errors).toEqual([]);
});

test('映像終了後に出力が消えても成功にせず、取得済みコメントは保持する', async () => {
  const written = deferred<string>();
  const originalVideo = vi.mocked(recordTimeshiftVideo).getMockImplementation()!;
  vi.mocked(recordTimeshiftVideo).mockImplementation(async (...args) => {
    const result = await originalVideo(...args);
    written.resolve(result.outputPath);
    return result;
  });
  const originalComments = vi.mocked(recordTimeshiftComments).getMockImplementation()!;
  vi.mocked(recordTimeshiftComments).mockImplementation(async (...args) => {
    const video = await written.promise;
    await fs.unlink(video);
    return originalComments(...args);
  });
  const result = await begin();
  expect(result.timeshift?.completion).toBe('partial');
  expect(result.video).toBeUndefined();
  expect(result.comments?.count).toBe(2);
  expect(result.errors).toContainEqual({
    target: 'video',
    message: 'タイムシフト: OUTPUT_MISSING',
  });
});

test('映像取得前の拒否に出力消失という二次エラーを追加しない', async () => {
  const { TimeshiftError } = await import('../../../src/main/core/nico/timeshift-common');
  vi.mocked(recordTimeshiftVideo).mockRejectedValue(new TimeshiftError('UNSUPPORTED_PLAYLIST_TAG'));
  const result = await begin();
  expect(result.errors.filter((error) => error.target === 'video')).toEqual([
    { target: 'video', message: 'タイムシフト: UNSUPPORTED_PLAYLIST_TAG' },
  ]);
});

test('接続前に失敗した予約ファイルは片付け、診断JSONと以前の成果物を残す', async () => {
  const previous = await begin();
  vi.mocked(openTimeshiftSession).mockImplementation(() => {
    throw new Error('connection failed');
  });
  const failed = await begin();
  expect(failed.attempt).toBe(2);
  await expect(fs.stat(failed.videoPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(failed.commentsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const diagnostic = JSON.parse(await fs.readFile(failed.metadataPath, 'utf8')) as {
    errors: unknown[];
  };
  expect(diagnostic.errors).not.toHaveLength(0);
  expect(await fs.readFile(previous.videoPath, 'utf8')).toBe('video');
  expect(await fs.readFile(previous.commentsPath, 'utf8')).toBe('comments');
});

test('映像失敗でコメントURI待ちが閉じても主原因だけをエラー表示する', async () => {
  const { TimeshiftError } = await import('../../../src/main/core/nico/timeshift-common');
  let rejectComments!: (error: Error) => void;
  session.comments = new Promise((_resolve, reject) => {
    rejectComments = reject;
  });
  session.close = vi.fn(() => rejectComments(new TimeshiftError('SESSION_CLOSED')));
  vi.mocked(recordTimeshiftVideo).mockRejectedValue(new TimeshiftError('HTTP_ERROR', 403));
  const result = await begin();
  expect(result.errors).toEqual([
    { target: 'video', message: 'タイムシフト: HTTP_ERROR (HTTP 403)' },
  ]);
  expect(result.timeshift?.commentReason).toBe('VIDEO_FAILED');
});

test.each(['VIDEO_FAILED', 'HTTP_ERROR'])(
  'コメントの%sと映像失敗の重複を区別する',
  async (reason) => {
    const { TimeshiftError } = await import('../../../src/main/core/nico/timeshift-common');
    const ready = deferred<void>();
    const originalComments = vi.mocked(recordTimeshiftComments).getMockImplementation()!;
    vi.mocked(recordTimeshiftComments).mockImplementation(async (...args) => {
      const result = await originalComments(...args);
      ready.resolve();
      if (reason === 'VIDEO_FAILED')
        await new Promise<void>((resolve) =>
          args[2].addEventListener('abort', () => resolve(), { once: true }),
        );
      return { ...result, status: 'partial', reason };
    });
    vi.mocked(recordTimeshiftVideo).mockImplementation(async () => {
      await ready.promise;
      throw new TimeshiftError('UNSUPPORTED_PLAYLIST_TAG');
    });
    const result = await begin();
    expect(result.errors.filter((error) => error.target === 'comments')).toEqual(
      reason === 'VIDEO_FAILED'
        ? []
        : [{ target: 'comments', message: 'タイムシフト: HTTP_ERROR' }],
    );
    expect(result.timeshift?.comments?.reason).toBe(reason);
    expect(await fs.readFile(result.commentsPath, 'utf8')).toBe('comments');
  },
);
