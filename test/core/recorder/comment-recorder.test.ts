import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { recordComments } from '../../../src/main/core/recorder/comment-recorder';
import { toCommentCsv } from '../../../src/main/core/recorder/comment-csv';
import { CommentViewStalledError } from '../../../src/main/vendor/nico-client/errors';
import type { NicoComment, StreamOptions } from '../../../src/main/vendor/nico-client/types';

// NDGR への接続は差し替え、渡されたオプションと abort の扱いを確認する
const streamCalls = vi.hoisted(() => [] as StreamOptions[]);
const failures = vi.hoisted(() => [] as Error[]);
const receivedInfo = vi.hoisted(() => [] as unknown[]);
const comments = vi.hoisted(() => [] as NicoComment[]);
const header =
  '\uFEFFat,no,content,vpos,rawUserId,hashedUserId,accountStatus,position,size,color,font,opacity,id,liveId\n';

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
    const outputPath = path.join(dir, 'retry.csv');
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
    expect(fs.readFileSync(outputPath, 'utf8').trim().split('\n')).toHaveLength(4);
  });

  test('取得位置の停滞エラーでは再接続せず、保存済みコメントを残す', async () => {
    const error = new CommentViewStalledError();
    failures.push(error);
    const outputPath = path.join(dir, 'stalled.csv');
    await expect(recordComments({ programId: 'lv1', outputPath })).rejects.toBe(error);
    expect(streamCalls).toHaveLength(1);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain('c1');
  });

  test('コメントの再試行待ちも停止でき、保存エラー以外の元の失敗は上限で返す', async () => {
    vi.useFakeTimers();
    comments.length = 0;
    const error = Object.assign(new Error('unavailable'), { statusCode: 503 });
    failures.push(...Array.from({ length: 6 }, () => error));
    const task = recordComments({ programId: 'lv1', outputPath: path.join(dir, 'failed.csv') });
    const check = expect(task).rejects.toBe(error);
    await vi.waitFor(() => expect(streamCalls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(31_000);
    await check;
    expect(streamCalls).toHaveLength(6);

    failures.push(error);
    const controller = new AbortController();
    const aborted = recordComments(
      { programId: 'lv1', outputPath: path.join(dir, 'abort.csv') },
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
      recordComments({ programId: 'lv1', outputPath: path.join(dir, 'missing', 'c.csv') }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(streamCalls[0].signal?.aborted).toBe(true);
  });

  test.each([1, 2])(
    'ヘッダー・本文の書き込み失敗を捕捉し、受信を止める (失敗する書き込み: %s)',
    async (failAt) => {
      const error = new Error('disk full');
      let writes = 0;
      const file = new Writable({
        write(_chunk, _encoding, callback) {
          writes += 1;
          queueMicrotask(() => callback(writes === failAt ? error : undefined));
        },
      });
      vi.spyOn(fs, 'createWriteStream').mockReturnValue(file as fs.WriteStream);
      await expect(
        recordComments({ programId: 'lv1', outputPath: path.join(dir, 'c.csv') }),
      ).rejects.toBe(error);
      expect(streamCalls[0].signal?.aborted).toBe(true);
      expect(file.destroyed).toBe(true);
    },
  );

  test('再開しても BOM・ヘッダーを重複させずに追記し、追加分の件数を通知する', async () => {
    const outputPath = path.join(dir, 'c.csv');
    const run = async (): Promise<number[]> => {
      const counts: number[] = [];
      const controller = new AbortController();
      const result = await recordComments(
        {
          programId: 'lv1',
          outputPath,
          onComment: (_c, count) => {
            counts.push(count);
            if (count === comments.length) controller.abort();
          },
        },
        controller.signal,
      );
      expect(result.count).toBe(comments.length);
      expect(result.aborted).toBe(true);
      return counts;
    };
    expect(await run()).toEqual([1, 2]);
    const original = fs.readFileSync(outputPath, 'utf8');
    expect(original.startsWith(header)).toBe(true);
    comments.splice(0, comments.length, comment(3));
    expect(await run()).toEqual([1]);
    const saved = fs.readFileSync(outputPath, 'utf8');
    expect(saved).toBe(original + toCommentCsv(comment(3)));
    expect(saved.match(/\uFEFF/g)).toHaveLength(1);
    expect(saved.trim().split('\n')).toHaveLength(4);
  });

  test.each([false, true])(
    'コメントが 0 件でも BOM・ヘッダーを保存する (空ファイルあり: %s)',
    async (exists) => {
      const outputPath = path.join(dir, 'empty.csv');
      if (exists) fs.writeFileSync(outputPath, '');
      const result = await recordComments({ programId: 'lv1', outputPath }, AbortSignal.abort());
      expect(result.count).toBe(0);
      expect(fs.readFileSync(outputPath, 'utf8')).toBe(header);
    },
  );

  test.each(['id,content\n', '{"existing":true}\n', '\uFEFFat,no'])(
    '異なる形式・不完全なヘッダーには追記しない: %j',
    async (existing) => {
      const outputPath = path.join(dir, 'mismatch.csv');
      fs.writeFileSync(outputPath, existing);
      await expect(recordComments({ programId: 'lv1', outputPath })).rejects.toThrow(
        'ヘッダーが一致しない',
      );
      expect(fs.readFileSync(outputPath, 'utf8')).toBe(existing);
      expect(streamCalls).toHaveLength(0);
    },
  );

  test('大きな本文の drain 待ちでも内容を欠かさず保存する', async () => {
    const outputPath = path.join(dir, 'large.csv');
    const large = { ...comment(1), content: '日本語,"\n\t'.repeat(100_000) };
    comments.splice(0, comments.length, large);
    const controller = new AbortController();
    const result = await recordComments(
      { programId: 'lv1', outputPath, onComment: () => controller.abort() },
      controller.signal,
    );
    expect(result.count).toBe(1);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(header + toCommentCsv(large));
  });

  test('過去分の取得は既定で有効、再開時は無効にできる', async () => {
    const run = async (prefetchBackward?: boolean): Promise<void> => {
      const controller = new AbortController();
      await recordComments(
        {
          programId: 'lv1',
          outputPath: path.join(dir, 'c.csv'),
          prefetchBackward,
          onComment: (_c, count) => {
            if (count === comments.length) controller.abort();
          },
        },
        controller.signal,
      );
    };
    await run();
    await run(false);
    expect(streamCalls.map((o) => o.prefetchBackward)).toEqual([true, false]);
    expect(streamCalls.every((o) => o.startPosition === 'now')).toBe(true);
  });
});

// 列順・時差・特殊文字は期待する CSV を直接比較し、書式変更による情報の欠落を検知する
describe('toCommentCsv', () => {
  test('全14項目を固定順に並べ、日付をまたぐ投稿時刻と RGB 色を整形する', () => {
    const value = {
      ...comment(1),
      at: new Date('2026-12-31T23:59:59.123Z'),
      color: { r: 0, g: 128, b: 255 },
      content: '日本語, "引用"\t改行\r\n続き🙂\\n',
    };
    expect(toCommentCsv(value)).toBe(
      '"2027-01-01T08:59:59.123+09:00","1","日本語, ""引用""\t改行\r\n続き🙂\\n","100","0","a:x","Standard","naka","medium","#0080FF","defont","Normal","id1","1"\n',
    );
  });

  test.each(['', '=1+2', '+1', '-1', '@name', '\t=1+2', ' white '])(
    '本文 %j を補正せず保存し、名前付きの色は維持する',
    (content) => {
      expect(toCommentCsv({ ...comment(1), content })).toBe(
        `"2026-09-04T09:00:01.000+09:00","1","${content}","100","0","a:x","Standard","naka","medium","white","defont","Normal","id1","1"\n`,
      );
    },
  );
});
