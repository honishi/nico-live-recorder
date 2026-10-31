import {
  setupRecordingManager,
  recordCalls,
  getProgramInfo,
  pushManagers,
  info,
  fakeAuth,
  nextRecordCall,
  finishedResult,
  dir,
  settings,
  history,
  manager,
  createManager,
  detectors,
} from '../helpers/recording-manager';
import path from 'node:path';
import { NicoLiveProgramStatus } from '../../src/main/vendor/nico-client/types';
import { waitFor } from '../helpers/fake-watch-server';

describe('RecordingManager: detection', () => {
  setupRecordingManager();

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

  test('無関係な設定で検知器を作り直さず、再接続後も手動停止を保持する', async () => {
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    settings.upsertTarget({ userId: '200', name: 'bob', enabled: true, addedAt: 'b' });
    await manager.start();
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    manager.stopRecording('lv1');
    first.resolve(finishedResult(first, { video: { reason: 'aborted', video: {} } }));
    await waitFor(() => !manager.hasActiveRecordings());
    const detectorCount = detectors.length;
    settings.moveTarget('200', '100');
    settings.update({ notificationsEnabled: false, outputDir: path.join(dir, 'other') });
    await vi.advanceTimersByTimeAsync(0);
    expect(detectors).toHaveLength(detectorCount);
    expect(detectors.at(-1)?.running).toBe(true);

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
  test('自動検知 poll は終了済み番組を開始せず、開始再試行も打ち切る', async () => {
    const source = 'poll' as const;
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
  });

  test('自動検知 push の重複通知でもライブ録画を一度だけ開始する', async () => {
    const source = 'push' as const;
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    const detector = detectors.at(-1)!;
    const program = { programId: 'lv1', providerId: '100', source, alreadyOnAir: false };
    detector.emit('program', program);
    detector.emit('program', { ...program, source: 'poll' });
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
  });

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
    expect(manager.stopRecording('lv2')).toBe(true);
    expect(manual.signal?.aborted).toBe(true);
    expect(automatic.signal?.aborted).toBe(false);
    manual.resolve(finishedResult(manual, { video: { reason: 'aborted', video: {} } }));
    await waitFor(() => history.get('lv2')?.state === 'done');
    expect(manager.stopRecording('lv2')).toBe(false);
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
});
