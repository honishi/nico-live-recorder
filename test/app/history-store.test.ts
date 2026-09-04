import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../../src/main/app/history-store';
import type { RecordingInfo } from '../../src/shared/types';

function entry(patch: Partial<RecordingInfo> & { programId: string }): RecordingInfo {
  return {
    title: `title-${patch.programId}`,
    providerName: 'provider',
    source: 'manual',
    state: 'done',
    startedAt: '2026-09-04T00:00:00.000Z',
    endedAt: '2026-09-04T01:00:00.000Z',
    commentCount: 0,
    videoBytes: 100,
    outputDir: '/tmp',
    ...patch,
  };
}

describe('HistoryStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-history-'));
    filePath = path.join(dir, 'history.json');
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('upsert は新しい順に並べ、遅延して保存し、再読み込みで同じ内容になる', () => {
    const store = new HistoryStore(filePath);
    store.upsert(entry({ programId: 'lv1', endedAt: '2026-09-04T01:00:00.000Z' }));
    store.upsert(entry({ programId: 'lv2', endedAt: '2026-09-04T02:00:00.000Z' }));
    store.upsert(entry({ programId: 'lv1', commentCount: 5, endedAt: '2026-09-04T01:00:00.000Z' }));

    expect(fs.existsSync(filePath)).toBe(false);
    vi.advanceTimersByTime(600);
    expect(fs.existsSync(filePath)).toBe(true);

    const reloaded = new HistoryStore(filePath).all();
    expect(reloaded.map((e) => [e.programId, e.commentCount])).toEqual([
      ['lv2', 0],
      ['lv1', 5],
    ]);
  });

  test('上限を超えた古い項目は捨てる', () => {
    const store = new HistoryStore(filePath, 2);
    store.upsert(entry({ programId: 'lv1', endedAt: '2026-09-04T01:00:00.000Z' }));
    store.upsert(entry({ programId: 'lv2', endedAt: '2026-09-04T02:00:00.000Z' }));
    store.upsert(entry({ programId: 'lv3', endedAt: '2026-09-04T03:00:00.000Z' }));
    expect(store.all().map((e) => e.programId)).toEqual(['lv3', 'lv2']);
  });

  test('前回終わらなかった録画は起動時に中断として扱う', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify([
        entry({ programId: 'lv1', state: 'recording', endedAt: undefined }),
        entry({ programId: 'lv2' }),
      ]),
    );
    const store = new HistoryStore(filePath);
    const stale = store.get('lv1');
    expect(stale?.state).toBe('failed');
    expect(stale?.error).toContain('中断');
    expect(stale?.endedAt).toBe(stale?.startedAt);
    expect(store.get('lv2')?.state).toBe('done');
  });

  test('壊れたファイルは空の履歴として扱う', () => {
    fs.writeFileSync(filePath, '{ broken');
    expect(new HistoryStore(filePath).all()).toEqual([]);
  });

  test('query は絞り込みとページングを行い、配信者の一覧と合計サイズを返す', () => {
    const store = new HistoryStore(filePath);
    store.upsert(
      entry({ programId: 'lv1', providerName: 'alice', title: 'ゲーム', videoBytes: 10 }),
    );
    store.upsert(
      entry({
        programId: 'lv2',
        providerName: 'bob',
        title: '雑談',
        state: 'failed',
        videoBytes: 20,
        endedAt: '2026-09-04T02:00:00.000Z',
      }),
    );
    store.upsert(
      entry({
        programId: 'lv3',
        providerName: 'alice',
        title: '歌',
        videoBytes: 30,
        endedAt: '2026-09-04T00:30:00.000Z',
      }),
    );
    store.upsert(entry({ programId: 'lv4', state: 'recording', endedAt: undefined }));

    const all = store.query();
    expect(all.total).toBe(3);
    expect(all.providers).toEqual(['alice', 'bob']);
    expect(all.totalBytes).toBe(60);
    expect(all.items.map((e) => e.programId)).toEqual(['lv2', 'lv1', 'lv3']);

    expect(store.query({ provider: 'alice' }).items.map((e) => e.programId)).toEqual([
      'lv1',
      'lv3',
    ]);
    expect(store.query({ state: 'failed' }).total).toBe(1);
    expect(store.query({ query: 'ゲーム' }).items[0].programId).toBe('lv1');
    expect(store.query({ query: 'BOB' }).items[0].programId).toBe('lv2');
    expect(store.query({ offset: 1, limit: 1 }).items.map((e) => e.programId)).toEqual(['lv1']);
  });

  test('finishedToday は当日に終わったものだけを返す', () => {
    const store = new HistoryStore(filePath);
    const now = new Date(2026, 8, 4, 12, 0, 0);
    const today = new Date(2026, 8, 4, 1, 0, 0).toISOString();
    const yesterday = new Date(2026, 8, 3, 23, 0, 0).toISOString();
    store.upsert(entry({ programId: 'lv1', endedAt: today }));
    store.upsert(entry({ programId: 'lv2', endedAt: yesterday }));
    store.upsert(entry({ programId: 'lv3', state: 'recording', endedAt: undefined }));
    expect(store.finishedToday(now).map((e) => e.programId)).toEqual(['lv1']);
  });

  test('remove と flush', () => {
    const store = new HistoryStore(filePath);
    store.upsert(entry({ programId: 'lv1' }));
    expect(store.remove('lv1')).toBe(true);
    expect(store.remove('lv1')).toBe(false);
    store.flush();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual([]);
  });

  test('checkExistence はファイルの有無を videoExists に入れる', async () => {
    const existing = path.join(dir, 'a.ts');
    fs.writeFileSync(existing, '');
    const checked = await HistoryStore.checkExistence([
      entry({ programId: 'lv1', videoPath: existing }),
      entry({ programId: 'lv2', videoPath: path.join(dir, 'missing.ts') }),
      entry({ programId: 'lv3' }),
      entry({ programId: 'lv4', state: 'recording' }),
    ]);
    expect(checked.map((e) => e.videoExists)).toEqual([true, false, false, undefined]);
  });

  test('checkExistence はパートのどれかが残っていれば実在とし、代表パスを実在する最後のパートにする', async () => {
    const part1 = path.join(dir, 'p1.ts');
    fs.writeFileSync(part1, '');
    const [checked] = await HistoryStore.checkExistence([
      entry({
        programId: 'lv1',
        videoPath: path.join(dir, 'p2-never-created.ts'),
        videoPaths: [part1, path.join(dir, 'p2-never-created.ts')],
      }),
    ]);
    expect(checked.videoExists).toBe(true);
    expect(checked.videoPath).toBe(part1);
  });
});
