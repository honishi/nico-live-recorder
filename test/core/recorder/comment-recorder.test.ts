import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { recordComments } from '../../../src/main/core/recorder/comment-recorder';
import type { NicoComment, StreamOptions } from '../../../src/main/vendor/nico-client/types';

// NDGR への接続は差し替え、渡されたオプションと abort の扱いを確認する
const streamCalls = vi.hoisted(() => [] as StreamOptions[]);
const failures = vi.hoisted(() => [] as Error[]);
const receivedInfo = vi.hoisted(() => [] as unknown[]);
const comments = vi.hoisted(() => [] as NicoComment[]);

// timers/promises の待機を仮想時計で進められる形に差し替える (外部待機はしない)
vi.mock('../../../src/main/vendor/nico-client/abortableDelay', () => ({
  abortableDelay: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish, { once: true });
    }),
}));

vi.mock('../../../src/main/vendor/nico-client/NicoClient', () => ({
  NicoClient: class {
    async *streamComments(options: StreamOptions, info?: unknown): AsyncGenerator<NicoComment> {
      streamCalls.push(options);
      receivedInfo.push(info);
      for (const comment of comments) {
        if (options.signal?.aborted) {
          return;
        }
        yield comment;
      }
      const failure = failures.shift();
      if (failure) {
        throw failure;
      }
      // 番組が続いている間は abort されるまで待つ
      if (!options.signal?.aborted) {
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    }
  },
}));

function comment(no: number): NicoComment {
  return {
    id: `id${no}`,
    at: new Date(Date.UTC(2026, 8, 4, 0, 0, no)),
    liveId: 1,
    rawUserId: 0,
    hashedUserId: 'a:x',
    accountStatus: 'Standard',
    no,
    vpos: no * 100,
    position: 'naka',
    size: 'medium',
    color: 'white',
    font: 'defont',
    opacity: 'Normal',
    content: `c${no}`,
  };
}

describe('recordComments', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-comments-'));
    streamCalls.length = 0;
    failures.length = 0;
    receivedInfo.length = 0;
    comments.length = 0;
    comments.push(comment(1), comment(2));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('一時切断から番組情報を取り直して再接続し、過去コメントを二重保存しない', async () => {
    vi.useFakeTimers();
    failures.push(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    const controller = new AbortController();
    const outputPath = path.join(dir, 'retry.jsonl');
    const debug = vi.fn();
    const counts: number[] = [];
    const task = recordComments(
      {
        programId: 'lv1',
        outputPath,
        logger: { debug, info() {}, warn() {}, error() {} },
        onComment: (_c, count) => {
          counts.push(count);
          if (count === 3) controller.abort();
        },
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(1));
    comments.push(comment(3));
    await vi.advanceTimersByTimeAsync(1000);
    const result = await task;
    expect(result.count).toBe(3);
    expect(streamCalls).toHaveLength(2);
    expect(receivedInfo[1]).toBeUndefined();
    expect(counts).toEqual([1, 2, 3]);
    expect(fs.readFileSync(outputPath, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  test('コメントの再試行待ちも停止でき、保存エラー以外の元の失敗は上限で返す', async () => {
    vi.useFakeTimers();
    comments.length = 0;
    const error = Object.assign(new Error('unavailable'), { statusCode: 503 });
    failures.push(...Array.from({ length: 6 }, () => error));
    const task = recordComments({ programId: 'lv1', outputPath: path.join(dir, 'failed.jsonl') });
    const check = expect(task).rejects.toBe(error);
    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(31_000);
    await check;
    expect(streamCalls).toHaveLength(6);

    failures.push(error);
    const controller = new AbortController();
    const aborted = recordComments(
      { programId: 'lv1', outputPath: path.join(dir, 'abort.jsonl') },
      controller.signal,
    );
    await vi.waitFor(() => expect(streamCalls).toHaveLength(7));
    controller.abort();
    expect((await aborted).aborted).toBe(true);
    expect(streamCalls).toHaveLength(7);
  });

  test('最初のコメントを待っている間のオープン失敗を捕捉し、受信も止める', async () => {
    comments.length = 0;
    await expect(
      recordComments({ programId: 'lv1', outputPath: path.join(dir, 'missing', 'c.jsonl') }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(streamCalls[0].signal?.aborted).toBe(true);
  });

  test('drain を待たない書き込みの失敗も捕捉し、受信を止めて元のエラーを返す', async () => {
    const error = new Error('disk full');
    const file = new Writable({
      write(_chunk, _encoding, callback) {
        queueMicrotask(() => callback(error));
      },
    });
    vi.spyOn(fs, 'createWriteStream').mockReturnValue(file as fs.WriteStream);
    await expect(
      recordComments({ programId: 'lv1', outputPath: path.join(dir, 'c.jsonl') }),
    ).rejects.toBe(error);
    expect(streamCalls[0].signal?.aborted).toBe(true);
    expect(file.destroyed).toBe(true);
  });

  test('受信したコメントを 1 行 1 JSON で追記し、件数を通知する', async () => {
    const outputPath = path.join(dir, 'c.jsonl');
    fs.writeFileSync(outputPath, '{"existing":true}\n');
    const counts: number[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await recordComments(
      { programId: 'lv1', outputPath, onComment: (_c, count) => counts.push(count) },
      controller.signal,
    );

    expect(result.count).toBe(2);
    expect(result.aborted).toBe(true);
    expect(counts).toEqual([1, 2]);
    const lines = fs.readFileSync(outputPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1])).toMatchObject({
      no: 1,
      content: 'c1',
      at: '2026-09-04T00:00:01.000Z',
    });
  });

  test('過去分の取得は既定で有効、再開時は無効にできる', async () => {
    const run = async (prefetchBackward?: boolean): Promise<void> => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      await recordComments(
        { programId: 'lv1', outputPath: path.join(dir, 'c.jsonl'), prefetchBackward },
        controller.signal,
      );
    };
    await run();
    await run(false);
    expect(streamCalls.map((o) => o.prefetchBackward)).toEqual([true, false]);
    expect(streamCalls.every((o) => o.startPosition === 'now')).toBe(true);
  });
});
