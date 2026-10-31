import {
  setupRecordingManager,
  type RecordCall,
  recordCalls,
  getProgramInfo,
  info,
  nextRecordCall,
  sendPaths,
  expectVideoBytes,
  GIB,
  finishedResult,
  dir,
  settings,
  history,
  manager,
  createManager,
  skipRetryWait,
} from '../helpers/recording-manager';
import fs from 'node:fs';
import path from 'node:path';
import { NicoLiveProgramStatus } from '../../src/main/vendor/nico-client/types';
import { waitFor } from '../helpers/fake-watch-server';

describe('RecordingManager: storage', () => {
  setupRecordingManager();

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

  test('履歴確定後に削除された以前のCSVをメニュー候補から除く', async () => {
    const retained = path.join(dir, 'retained.csv');
    const deleted = path.join(dir, 'deleted.csv');
    fs.writeFileSync(retained, 'comments');
    history.upsert({
      programId: 'lv1',
      title: 'old',
      source: 'manual',
      mode: 'timeshift',
      state: 'done',
      startedAt: new Date().toISOString(),
      outputDir: dir,
      commentCount: 1,
      videoBytes: 0,
      commentsPaths: [deleted, retained],
    });
    expect(await manager.getCommentPaths('lv1')).toEqual([retained]);
    expect(fs.readFileSync(retained, 'utf8')).toBe('comments');
  });

  test('タイムシフト中のフォルダ消失を一部失敗として停止し、削除済みCSVを残さない', async () => {
    getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    const result = finishedResult(call, { timeshift: { completion: 'cancelled' } });
    fs.mkdirSync(call.options.outputDir, { recursive: true });
    fs.writeFileSync(path.join(call.options.outputDir, 'rec.ts'), 'video');
    fs.writeFileSync(path.join(call.options.outputDir, 'rec.comments.csv'), 'comments');
    await expectVideoBytes(manager, 5);
    fs.rmSync(call.options.outputDir, { recursive: true });
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => call.signal!.aborted);
    expect(call.signal?.reason).toMatchObject({ code: 'OUTPUT_MISSING' });
    call.resolve(result);
    await waitFor(() => !manager.hasActiveRecordings());
    expect(history.get('lv1')).toMatchObject({
      state: 'failed',
      completion: 'partial',
      commentsPaths: [],
    });
    expect(await manager.getCommentPaths('lv1')).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recordCalls).toHaveLength(1);
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
});
