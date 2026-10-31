import type { NicoLiveProgramInfo } from '../../src/main/vendor/nico-client/types';
import {
  setupRecordingManager,
  recordCalls,
  getProgramInfo,
  info,
  settings,
  manager,
  logger,
  detectors,
} from '../helpers/recording-manager';
import { waitFor } from '../helpers/fake-watch-server';

describe('RecordingManager: shutdown', () => {
  setupRecordingManager();

  test('更新準備後は手動録画と自動検知の開始を受け付けない', async () => {
    expect(manager.prepareForUpdate()).toBe(true);
    await expect(manager.startRecording('lv1', 'manual')).rejects.toThrow('終了・更新処理中');
    await expect(manager.startRecording('lv2', 'push')).rejects.toThrow('終了・更新処理中');
    expect(getProgramInfo).not.toHaveBeenCalled();
    expect(recordCalls).toHaveLength(0);
  });

  test('更新受付後の push 検知は警告・再試行を発生させない', async () => {
    const source = 'push' as const;
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    const start = vi.spyOn(manager, 'startRecording');
    const detector = detectors.at(-1)!;
    expect(manager.prepareForUpdate()).toBe(true);
    detector.emit('program', { programId: 'lv1', providerId: '100', source });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(start).not.toHaveBeenCalled();
    expect(getProgramInfo).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(recordCalls).toHaveLength(0);
  });

  test('再試行の待機中に更新を受け付けたら、次の開始と失敗通知を止める', async () => {
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    getProgramInfo.mockRejectedValue(new Error('offline'));
    const start = vi.spyOn(manager, 'startRecording');
    const detector = detectors.at(-1)!;
    const unmark = vi.spyOn(detector, 'unmarkSeen');
    detector.emit('program', { programId: 'lv1', providerId: '100', source: 'push' });
    await expect(start.mock.results[0].value).rejects.toThrow('offline');
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(manager.prepareForUpdate()).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(start).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
    expect(unmark).not.toHaveBeenCalled();
  });

  test('開始失敗の確定直後に更新を受け付けても、検知側で警告しない', async () => {
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    getProgramInfo.mockRejectedValue(new Error('offline'));
    // starting の解除通知で更新を受け付け、handleDetected の catch より先に受付を閉じる。
    const prepare = vi.fn(() => {
      if (manager.getActiveRecordingCount() === 0) manager.prepareForUpdate();
    });
    manager.on('change', prepare);
    const start = vi.spyOn(manager, 'startRecording');
    detectors.at(-1)!.emit('program', { programId: 'lv1', providerId: '100', source: 'push' });
    await expect(start.mock.results[0].value).rejects.toThrow('offline');
    await vi.advanceTimersByTimeAsync(120_000);
    manager.off('change', prepare);
    expect(prepare).toHaveBeenCalled();
    await expect(manager.startRecording('lv2', 'manual')).rejects.toThrow('終了・更新処理中');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(getProgramInfo).toHaveBeenCalledOnce();
  });

  test('更新していなければ検知失敗を3回試し、次回検知のため既知扱いを解除する', async () => {
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    getProgramInfo.mockRejectedValue(new Error('offline'));
    const start = vi.spyOn(manager, 'startRecording');
    const detector = detectors.at(-1)!;
    const unmark = vi.spyOn(detector, 'unmarkSeen');
    detector.emit('program', { programId: 'lv1', providerId: '100', source: 'push' });
    await expect(start.mock.results[0].value).rejects.toThrow('offline');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(start).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(unmark).toHaveBeenCalledExactlyOnceWith('lv1');
  });

  test('番組情報の取得中も更新を保留し、失敗して空いた後は準備できる', async () => {
    let fail!: (error: Error) => void;
    getProgramInfo.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const pending = manager.startRecording('lv1', 'manual');
    expect(manager.getActiveRecordingCount()).toBe(1);
    expect(manager.prepareForUpdate()).toBe(false);
    await vi.waitFor(() => expect(getProgramInfo).toHaveBeenCalled());
    fail(new Error('unavailable'));
    await expect(pending).rejects.toThrow();
    expect(manager.prepareForUpdate()).toBe(true);
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
