import { FollowRequests, type FollowView } from '../../src/shared/follow-requests';
import type { FollowStatus } from '../../src/shared/types';

function done(): FollowStatus {
  return { result: 'following', state: 'done', stale: false, retryAt: Date.now() + 300_000 };
}

function setup() {
  const request = vi
    .fn<(id: string, manual: boolean) => Promise<FollowStatus>>()
    .mockImplementation(async () => done());
  let view: FollowView = { entries: {} };
  const changed = vi.fn((next: FollowView) => {
    view = next;
  });
  const controller = new FollowRequests(request, changed);
  return { request, changed, controller, view: () => view };
}

describe('表示行のフォロー確認', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  test('200ms表示された行だけを取得し、高速スクロールで通過した行を除外する', async () => {
    const { request, controller } = setup();
    controller.setVisible('1', true);
    await vi.advanceTimersByTimeAsync(100);
    controller.setVisible('1', false);
    controller.setVisible('2', true);
    await vi.advanceTimersByTimeAsync(199);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request.mock.calls).toEqual([['2', false]]);
    controller.dispose();
  });

  test('同時に見えた複数行も通信は順番に行い、待っている間に隠れた行は送信しない', async () => {
    const { request, controller } = setup();
    let finish!: (status: FollowStatus) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    controller.setVisible('1', true);
    controller.setVisible('2', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    controller.setVisible('2', false);
    finish(done());
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  test('ウィンドウ非表示中は送信せず、復帰時は200ms待つ', async () => {
    const { request, controller } = setup();
    controller.setVisible('1', true);
    controller.setActive(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).not.toHaveBeenCalled();
    controller.setActive(true);
    await vi.advanceTimersByTimeAsync(199);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  test('スクロールで戻ったときは有効な結果を再利用し、期限後は表示中だけ再確認する', async () => {
    const { request, controller } = setup();
    controller.setVisible('1', true);
    await vi.advanceTimersByTimeAsync(200);
    controller.setVisible('1', false);
    await vi.advanceTimersByTimeAsync(1000);
    controller.setVisible('1', true);
    await vi.advanceTimersByTimeAsync(200);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(298_800);
    expect(request).toHaveBeenCalledTimes(2);
    controller.setVisible('1', false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  test('休止期限まで別の表示行も送信せず、復帰時には現在見えている行だけを試す', async () => {
    const { request, controller, view } = setup();
    request.mockResolvedValueOnce({
      result: 'unknown',
      state: 'paused',
      stale: false,
      retryAt: 30_200,
      servicePaused: true,
    });
    controller.setVisible('1', true);
    controller.setVisible('2', true);
    await vi.advanceTimersByTimeAsync(200);
    expect(view().service?.state).toBe('paused');
    controller.setVisible('1', false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request.mock.calls).toEqual([
      ['1', false],
      ['2', false],
    ]);
    expect(view().service).toBeUndefined();
    controller.dispose();
  });

  test('停止後は自動再試行せず、手動でも休止期限を飛ばさない', async () => {
    const { request, controller } = setup();
    request.mockResolvedValueOnce({
      result: 'unknown',
      state: 'stopped',
      stale: false,
      retryAt: 30_200,
      servicePaused: true,
    });
    controller.setVisible('1', true);
    await vi.advanceTimersByTimeAsync(200);
    controller.retryVisible();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request.mock.calls[1]).toEqual(['1', true]);
    controller.dispose();
  });

  test('停止後に表示行が増えても自動再試行を再開しない', async () => {
    const { request, controller } = setup();
    request.mockResolvedValueOnce({
      result: 'unknown',
      state: 'stopped',
      stale: false,
      retryAt: 30_200,
      servicePaused: true,
    });
    controller.setVisible('1', true);
    await vi.advanceTimersByTimeAsync(200);
    controller.setVisible('1', false);
    controller.setVisible('2', true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(1);
    controller.retryVisible();
    await vi.advanceTimersByTimeAsync(1);
    expect(request.mock.calls[1]).toEqual(['2', true]);
    controller.dispose();
  });

  test('対象追加の結果を取り込み、再取得を省く', async () => {
    const { request, controller } = setup();
    controller.accept('1', done());
    controller.setVisible('1', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).not.toHaveBeenCalled();
    controller.dispose();
  });

  test('IPC例外は手動再確認待ちにし、破棄後の応答では画面更新も次の送信もしない', async () => {
    const { request, controller, view, changed } = setup();
    request.mockRejectedValueOnce(new Error('IPC failed'));
    controller.setVisible('1', true);
    await vi.advanceTimersByTimeAsync(200);
    expect(view().entries['1'].state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);
    let finish!: (status: FollowStatus) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    controller.retry('1');
    await vi.advanceTimersByTimeAsync(1);
    controller.setVisible('2', true);
    controller.dispose();
    changed.mockClear();
    finish(done());
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('別経路のキャッシュ済み成功結果でサービス全体の停止を解除しない', async () => {
    const { request, controller, view } = setup();
    controller.accept('1', {
      result: 'unknown',
      state: 'stopped',
      stale: false,
      retryAt: 30_000,
      servicePaused: true,
    });
    controller.accept('2', done());
    controller.setVisible('1', true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(view().service?.state).toBe('stopped');
    expect(request).not.toHaveBeenCalled();
    controller.dispose();
  });
});
