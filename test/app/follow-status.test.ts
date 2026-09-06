import { FollowStatusCache } from '../../src/main/app/follow-status';
import type { FollowingResponse } from '../../src/main/app/nico-user';

// 時間だけを進めて通信開始と休止を検証し、実ネットワークや実時間には依存しない
function setup() {
  let now = 0;
  const check = vi
    .fn<(...args: string[]) => Promise<FollowingResponse>>()
    .mockResolvedValue({ result: 'following' });
  const cache = new FollowStatusCache({ check, now: () => now });
  return {
    check,
    cache,
    time: (at: number) => {
      now = at;
    },
  };
}

describe('FollowStatusCache', () => {
  test('1秒未満の連続開始を防ぎ、待機中の対象を勝手に送信しない', async () => {
    const { check, cache, time } = setup();
    await cache.get('1', 'cookie');
    time(999);
    expect(await cache.get('2', 'cookie')).toMatchObject({ state: 'waiting', result: undefined });
    time(10_000);
    expect(check).toHaveBeenCalledTimes(1);
    await cache.get('3', 'cookie');
    expect(check.mock.calls.map(([id]) => id)).toEqual(['1', '3']);
  });

  test('実行は1件だけで、同じユーザーは合流する', async () => {
    const { check, cache, time } = setup();
    let finish!: (response: FollowingResponse) => void;
    check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = cache.get('1', 'cookie');
    expect(cache.get('1', 'cookie')).toBe(first);
    time(10_000);
    expect(await cache.get('2', 'cookie')).toMatchObject({ state: 'waiting' });
    expect(check).toHaveBeenCalledTimes(1);
    finish({ result: 'following' });
    await first;
    await cache.get('2', 'cookie');
    expect(check).toHaveBeenCalledTimes(2);
  });

  test('成功結果は5分保持し、再取得失敗では前回の値を残す', async () => {
    const { check, cache, time } = setup();
    expect(await cache.get('1', 'cookie')).toEqual({
      result: 'following',
      stale: false,
      state: 'done',
      retryAt: 300_000,
    });
    time(299_999);
    await cache.get('1', 'cookie');
    expect(check).toHaveBeenCalledTimes(1);
    time(300_000);
    check.mockResolvedValueOnce({ result: 'unknown', retryable: true });
    expect(await cache.get('1', 'cookie')).toMatchObject({
      result: 'following',
      stale: true,
      state: 'paused',
    });
    time(330_000);
    expect(await cache.get('1', 'cookie')).toMatchObject({
      result: 'following',
      stale: false,
      state: 'done',
    });
  });

  test('503相当の失敗で全対象を休止し、3回再試行したら停止する', async () => {
    const { check, cache, time } = setup();
    check.mockResolvedValue({ result: 'unknown', retryable: true });
    expect(await cache.get('1', 'cookie')).toMatchObject({
      state: 'paused',
      retryAt: 30_000,
      servicePaused: true,
    });
    time(29_999);
    expect(await cache.get('2', 'cookie', true)).toMatchObject({ state: 'paused' });
    expect(check).toHaveBeenCalledTimes(1);
    time(30_000);
    expect(await cache.get('2', 'cookie')).toMatchObject({ state: 'paused', retryAt: 90_000 });
    time(90_000);
    expect(await cache.get('3', 'cookie')).toMatchObject({ state: 'paused', retryAt: 210_000 });
    time(210_000);
    expect(await cache.get('4', 'cookie')).toMatchObject({ state: 'stopped', retryAt: 330_000 });
    time(329_999);
    await cache.get('5', 'cookie', true);
    time(1_000_000);
    expect(await cache.get('6', 'cookie')).toMatchObject({ state: 'stopped' });
    expect(check).toHaveBeenCalledTimes(4);
    check.mockResolvedValue({ result: 'following' });
    expect(await cache.get('6', 'cookie', true)).toMatchObject({ state: 'done' });
    expect(check).toHaveBeenCalledTimes(5);
  });

  test('Retry-Afterを守り、成功後は別の失敗済み対象も自動再確認できる', async () => {
    const { check, cache, time } = setup();
    check.mockResolvedValueOnce({ result: 'unknown', retryable: true, retryAt: 600_000 });
    await cache.get('1', 'cookie');
    time(599_999);
    await cache.get('2', 'cookie', true);
    expect(check).toHaveBeenCalledTimes(1);
    time(600_000);
    await cache.get('2', 'cookie');
    time(601_000);
    expect(await cache.get('1', 'cookie')).toMatchObject({ state: 'done' });
    expect(check).toHaveBeenCalledTimes(3);
  });

  test('認証エラーや不正応答は自動再試行せず、手動操作も30秒待つ', async () => {
    const { check, cache, time } = setup();
    check.mockResolvedValueOnce({ result: 'unknown', retryable: false });
    expect(await cache.get('1', 'cookie')).toMatchObject({ state: 'stopped', retryAt: 30_000 });
    time(29_999);
    await cache.get('1', 'cookie', true);
    time(30_000);
    await cache.get('1', 'cookie');
    expect(check).toHaveBeenCalledTimes(1);
    expect(await cache.get('1', 'cookie', true)).toMatchObject({ state: 'done' });
  });

  test('ログイン切替で旧結果を採用せず、古い通信の終了までは次を開始しない', async () => {
    const { check, cache, time } = setup();
    let finish!: (response: FollowingResponse) => void;
    check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = cache.get('1', 'old-cookie');
    cache.clear();
    time(2000);
    expect(await cache.get('1', 'new-cookie')).toMatchObject({
      state: 'waiting',
      result: undefined,
    });
    finish({ result: 'following' });
    const obsolete = await old;
    expect(obsolete.state).toBe('waiting');
    expect(obsolete.result).toBeUndefined();
    expect(await cache.get('1', 'new-cookie')).toMatchObject({ state: 'done' });
    expect(check.mock.calls).toEqual([
      ['1', 'old-cookie'],
      ['1', 'new-cookie'],
    ]);
  });

  test('キャッシュ破棄でも開始間隔は飛ばさず、旧アカウントの休止は解除する', async () => {
    const { check, cache, time } = setup();
    check.mockResolvedValueOnce({ result: 'unknown', retryable: true });
    await cache.get('1', 'old-cookie');
    cache.clear();
    expect(await cache.get('1', 'new-cookie')).toMatchObject({
      state: 'waiting',
      result: undefined,
    });
    time(1000);
    expect(await cache.get('1', 'new-cookie')).toMatchObject({ state: 'done' });
  });
});
