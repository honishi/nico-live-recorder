import type { NicoLiveProgramInfo } from '../../src/main/vendor/nico-client/types';
import {
  setupRecordingManager,
  recordCalls,
  getProgramInfo,
  pushManagers,
  resetPush,
  info,
  deferred,
  nextRecordCall,
  finishedResult,
  settings,
  history,
  manager,
  auth,
  detectors,
} from '../helpers/recording-manager';
import { waitFor } from '../helpers/fake-watch-server';

describe('RecordingManager: logout', () => {
  setupRecordingManager();

  test('ログアウトは検知を止め、push 解除後に Cookie を削除する。重複要求と設定変更でも再開しない', async () => {
    const logoutAuth = vi.spyOn(auth, 'logout');
    settings.update({ pushEnabled: true });
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    const detector = detectors.at(-1)!;
    const push = pushManagers.at(-1)!;
    const gate = deferred<void>();
    resetPush.mockImplementation(async () => {
      expect(await auth.getCookieHeader()).toBe('user_session=x');
      expect(detector.running).toBe(false);
      await gate.promise;
    });

    const logout = manager.logout();
    expect(manager.logout()).toBe(logout);
    await waitFor(() => resetPush.mock.calls.length === 1);
    expect(logoutAuth).not.toHaveBeenCalled();
    const detectorCount = detectors.length;
    settings.update({ pollIntervalSec: 60 });
    await manager.restartDetection();
    expect(detectors).toHaveLength(detectorCount);
    // 停止前から取得中だった通知が遅れて届いても録画しない
    detector.emit('program', { programId: 'lv1', providerId: '100', source: 'push' });
    expect(getProgramInfo).not.toHaveBeenCalled();

    gate.resolve();
    await logout;
    expect(logoutAuth).toHaveBeenCalledOnce();
    expect(await auth.isLoggedIn()).toBe(false);
    expect(push.started).toBe(false);
    expect(manager.detectorRunning).toBe(false);
    await manager.restartDetection();
    expect(manager.detectorRunning).toBe(false);
  });

  test('push が未起動でも解除し、解除に失敗してもログアウトする', async () => {
    const logoutAuth = vi.spyOn(auth, 'logout');
    await manager.start();
    expect(pushManagers).toHaveLength(0);
    resetPush.mockRejectedValue(new Error('cleanup failed'));
    await manager.logout();
    expect(resetPush).toHaveBeenCalledOnce();
    expect(logoutAuth).toHaveBeenCalledOnce();
    expect(await auth.isLoggedIn()).toBe(false);
  });

  test('ログイン確認待ちの検知再起動はログアウトで再開せず、購読解除へ進む', async () => {
    const logoutAuth = vi.spyOn(auth, 'logout');
    const gate = deferred<boolean>();
    vi.spyOn(auth, 'isLoggedIn').mockReturnValueOnce(gate.promise);
    const restarting = manager.restartDetection();
    const logout = manager.logout();
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    gate.resolve(true);
    await Promise.all([restarting, logout]);
    expect(detectors).toHaveLength(0);
    expect(resetPush).toHaveBeenCalledOnce();
    expect(logoutAuth).toHaveBeenCalledOnce();
  });

  test('ログアウトは全録画の終了と履歴保存を待ってから push 解除と Cookie 削除へ進む', async () => {
    await manager.startRecording('lv1', 'manual');
    await manager.startRecording('lv2', 'manual');
    const first = await nextRecordCall(0);
    const second = await nextRecordCall(1);
    const logoutAuth = vi.spyOn(auth, 'logout');
    const flush = vi.spyOn(history, 'flush');
    expect(manager.getActiveRecordingCount()).toBe(2);
    resetPush.mockImplementation(async () => {
      expect(manager.hasActiveRecordings()).toBe(false);
      expect(flush).toHaveBeenCalled();
      expect(history.get('lv1')).toMatchObject({ state: 'done' });
      expect(history.get('lv2')).toMatchObject({ state: 'done' });
    });

    const logout = manager.logout();
    await waitFor(() => first.signal?.aborted === true && second.signal?.aborted === true);
    expect(resetPush).not.toHaveBeenCalled();
    expect(logoutAuth).not.toHaveBeenCalled();
    await expect(manager.startRecording('lv3', 'manual')).rejects.toThrow('ログアウト処理中');
    first.resolve(finishedResult(first, { video: { reason: 'aborted', video: {} } }));
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(logoutAuth).not.toHaveBeenCalled();
    second.resolve(finishedResult(second, { video: { reason: 'aborted', video: {} } }));
    await logout;
    expect(logoutAuth).toHaveBeenCalledOnce();
    expect(manager.getActiveRecordingCount()).toBe(0);
  });

  test('ログアウトは番組情報の取得中の録画開始を取り消す', async () => {
    const gate = deferred<NicoLiveProgramInfo>();
    getProgramInfo.mockReturnValue(gate.promise);
    const starting = manager.startRecording('lv1', 'manual');
    const cancelled = expect(starting).rejects.toThrow('ログアウトのため');
    await waitFor(() => getProgramInfo.mock.calls.length === 1);
    expect(manager.getActiveRecordingCount()).toBe(1);
    const logout = manager.logout();
    gate.resolve(info());
    await Promise.all([cancelled, logout]);
    expect(recordCalls).toHaveLength(0);
    expect(manager.getActiveRecordingCount()).toBe(0);
  });

  test('ログアウトは再開待ちの録画を終了し、次のパートを作らない', async () => {
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    call.resolve(finishedResult(call, { video: { reason: 'idle', video: {} } }));
    await waitFor(async () => (await manager.getRecordings())[0]?.state === 'starting');
    await manager.logout();
    expect(history.get('lv1')?.state).toBe('done');
    expect(recordCalls).toHaveLength(1);
  });

  test('ログアウトが再開前の番組情報取得と重なっても録画を再開しない', async () => {
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    const gate = deferred<NicoLiveProgramInfo>();
    getProgramInfo.mockReturnValue(gate.promise);
    call.resolve(finishedResult(call, { video: { reason: 'idle', video: {} } }));
    await waitFor(async () => (await manager.getRecordings())[0]?.state === 'starting');
    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => getProgramInfo.mock.calls.length === 2);
    const logout = manager.logout();
    await waitFor(() => call.signal?.aborted === true);
    gate.resolve(info());
    await logout;
    expect(history.get('lv1')?.state).toBe('done');
    expect(recordCalls).toHaveLength(1);
  });

  test('push 停止待ちの検知再起動もログアウトで再開しない', async () => {
    settings.update({ pushEnabled: true });
    settings.upsertTarget({ userId: '100', name: 'alice', enabled: true, addedAt: 'a' });
    await manager.start();
    const gate = deferred<void>();
    const stop = vi.spyOn(pushManagers.at(-1)!, 'stop').mockReturnValue(gate.promise);
    settings.update({ pushEnabled: false });
    await waitFor(() => stop.mock.calls.length === 1);
    const detectorCount = detectors.length;
    const logout = manager.logout();
    gate.resolve();
    await logout;
    expect(detectors).toHaveLength(detectorCount);
    expect(manager.detectorRunning).toBe(false);
    expect(resetPush).toHaveBeenCalledOnce();
  });
});
