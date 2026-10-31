import type { NicoLiveProgramInfo } from '../../src/main/vendor/nico-client/types';
import {
  setupRecordingManager,
  notifications,
  notificationSupported,
  recordCalls,
  extractPreview,
  getProgramInfo,
  info,
  nextRecordCall,
  sendPaths,
  finishedResult,
  dir,
  settings,
  history,
  manager,
} from '../helpers/recording-manager';
import fs from 'node:fs';
import path from 'node:path';
import { NicoLiveProgramStatus } from '../../src/main/vendor/nico-client/types';
import { waitFor } from '../helpers/fake-watch-server';

describe('RecordingManager: recording', () => {
  setupRecordingManager();

  test.each(['live', 'timeshift'] as const)(
    '%s でコメントをまとめ、映像が増えない場合と終了直前の最後の1件も通知する',
    async (mode) => {
      // 自動で時計を進めず、進捗周期と終了の順序を固定する。
      vi.useRealTimers();
      vi.useFakeTimers();
      if (mode === 'timeshift')
        getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
      const recording = await manager.startRecording('lv1', 'manual');
      const call = recordCalls[0];
      const changed = vi.fn();
      manager.on('change', changed);
      const videoPath = path.join(dir, 'new.ts');
      const commentsPath = path.join(dir, 'new.comments.csv');
      fs.writeFileSync(videoPath, 'video');
      fs.writeFileSync(commentsPath, 'comments');
      sendPaths(call, 1, videoPath, commentsPath);
      expect(changed).toHaveBeenCalledTimes(1);
      expect((await manager.getRecordings())[0].videoPath).toBe(videoPath);
      // サイズの初回反映を済ませ、以後は映像もログも増やさない。
      const sizeReady = new Promise<void>((resolve) => {
        const onSize = (): void => {
          if (recording.videoBytes !== 5) return;
          manager.off('change', onSize);
          resolve();
        };
        manager.on('change', onSize);
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await sizeReady;
      changed.mockClear();
      for (let count = 1; count <= 1_000; count += 1) call.options.onComment?.({} as never, count);
      expect(changed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(changed).toHaveBeenCalledTimes(1);
      expect((await manager.getRecordings())[0].commentCount).toBe(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(changed).toHaveBeenCalledTimes(1);
      // 次の周期より前に最後のコメントを受けて終了しても、最終通知と履歴に残る。
      call.options.onComment?.({} as never, 1_001);
      const finalCounts: number[] = [];
      const completed = new Promise<void>((resolve) => {
        manager.on('change', () => {
          const finished = history.get('lv1');
          if (finished?.endedAt) {
            finalCounts.push(finished.commentCount);
            resolve();
          }
        });
      });
      call.resolve(
        finishedResult(call, mode === 'timeshift' ? { timeshift: { completion: 'complete' } } : {}),
      );
      await completed;
      expect(finalCounts).toEqual([1_001]);
      expect(history.get('lv1')?.commentCount).toBe(1_001);
    },
  );

  test('画面からの再確認で保存先のキャッシュを更新する', async () => {
    fs.mkdirSync(settings.get().outputDir, { recursive: true });
    expect(await manager.getAlerts(true)).toEqual([]);
    // OS や実行ユーザーの権限に依存せず、外部の権限変更を再現する。
    const promises = await import('node:fs/promises');
    const access = vi
      .spyOn(promises.default, 'access')
      .mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    try {
      expect(await manager.getAlerts(true)).toEqual([]);
      const changed = vi.fn();
      manager.on('change', changed);
      manager.refreshExternalState();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(await manager.getAlerts(true)).toContainEqual(
        expect.objectContaining({ kind: 'output-dir' }),
      );
    } finally {
      access.mockRestore();
    }
  });

  test('live のプレビューを録画と結線し、履歴へ保存せず停止時に解放する', async () => {
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    const sample = { data: Buffer.from('video'), init: Buffer.from('init') };
    // 他番組の要求ではこの番組の画像生成を有効にしない。
    expect(manager.getRecordingPreview('lv999', true)).toBeUndefined();
    call.options.onVideoSample?.(sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(extractPreview).not.toHaveBeenCalled();
    manager.getRecordingPreview('lv1', true);
    call.options.onVideoSample?.(sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(extractPreview).toHaveBeenCalledTimes(1);
    const image = manager.getRecordingPreview('lv1', true);
    expect(image?.dataUrl).toBe('data:image/jpeg;base64,anBlZw==');
    expect(manager.getRecordingPreview('lv1', true, image?.capturedAt)).toBeUndefined();
    expect(JSON.stringify(history.get('lv1'))).not.toContain('data:image');
    manager.pausePreviews();
    expect(manager.getRecordingPreview('lv1', true)).toBeUndefined();
    manager.stopRecording('lv1');
    call.options.onVideoSample?.(sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getRecordingPreview('lv1', true)).toBeUndefined();
    expect(extractPreview).toHaveBeenCalledTimes(1);
  });

  test('タイムシフトの例外終了も開始と失敗を一度ずつ通知する', async () => {
    settings.update({ notificationsEnabled: true });
    getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    call.reject(new Error('failed'));
    await waitFor(() => !manager.hasActiveRecordings());
    expect(notifications).toEqual([
      { title: 'タイムシフト録画を開始しました', body: 'alice タイトル' },
      {
        title: 'タイムシフト録画に失敗しました',
        body: expect.stringContaining('タイトル') as string,
      },
    ]);
  });

  test.each(['disabled', 'unsupported'] as const)(
    '通知が%sならタイムシフトも通知しない',
    async (reason) => {
      settings.update({ notificationsEnabled: reason !== 'disabled' });
      notificationSupported.mockReturnValue(reason !== 'unsupported');
      getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
      await manager.startRecording('lv1', 'manual');
      const call = await nextRecordCall(0);
      call.resolve(finishedResult(call, { timeshift: { completion: 'complete' } }));
      await waitFor(() => !manager.hasActiveRecordings());
      expect(notifications).toEqual([]);
    },
  );

  test('録画を始めて完了すると、履歴に配信者フォルダとファイルが残る', async () => {
    settings.update({ notificationsEnabled: true });
    const started = await manager.startRecording('lv1', 'manual');
    expect(started).toMatchObject({ providerName: 'alice', title: 'タイトル' });
    expect(['starting', 'recording']).toContain(started.state);
    expect(started.outputDir).toBe(path.join(dir, 'out', '100_alice'));

    const call = await nextRecordCall(0);
    expect(call.options.outputDir).toBe(started.outputDir);
    expect(manager.prepareForUpdate()).toBe(false);
    expect(call.signal?.aborted).toBe(false);
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
    expect(notifications).toEqual([
      { title: '録画を開始しました', body: 'alice タイトル' },
      { title: '録画が終了しました', body: 'alice タイトル' },
    ]);
    // 同名の配信者でも ID が違えば別の保存先になる。
    getProgramInfo.mockResolvedValueOnce(info({ nicoliveProgramId: 'lv2', providerId: '200' }));
    const second = await manager.startRecording('lv2', 'manual');
    expect(second.outputDir).toBe(path.join(dir, 'out', '200_alice'));
  });

  test.each([
    ['100', '配信者/名:*?. ', '100_配信者_名___'],
    ['../100', 'alice', '.._100_alice'],
    ['100', '   ', '100'],
    [undefined, 'alice', 'unknown_alice'],
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
});
