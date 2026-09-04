import { FollowStatusCache } from '../../src/main/app/follow-status';
import type { FollowCheckResult } from '../../src/shared/types';

describe('FollowStatusCache', () => {
  /** 呼び出しを記録し、resolve を外から制御できる偽の問い合わせ */
  function fakeCheck(): {
    check: (userId: string, cookie: string) => Promise<FollowCheckResult>;
    calls: string[];
    inFlight: () => number;
    maxInFlight: () => number;
    resolveAll: (result?: FollowCheckResult) => void;
  } {
    const calls: string[] = [];
    const pending: Array<(result: FollowCheckResult) => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    return {
      check: (userId) => {
        calls.push(userId);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          pending.push((result) => {
            inFlight -= 1;
            resolve(result);
          });
        });
      },
      calls,
      inFlight: () => inFlight,
      maxInFlight: () => maxInFlight,
      resolveAll: (result = 'following') => {
        for (const resolve of pending.splice(0)) {
          resolve(result);
        }
      },
    };
  }

  test('結果はしばらく保持し、同じユーザーの問い合わせはまとめる', async () => {
    let now = 0;
    const fake = fakeCheck();
    const cache = new FollowStatusCache({ check: fake.check, now: () => now, resultTtlMs: 1000 });

    const first = cache.get('1', 'c');
    const second = cache.get('1', 'c');
    expect(fake.calls).toEqual(['1']);
    fake.resolveAll('following');
    expect(await Promise.all([first, second])).toEqual(['following', 'following']);

    // 期限内はキャッシュ、期限が切れたら取り直す
    now = 999;
    expect(await cache.get('1', 'c')).toBe('following');
    expect(fake.calls).toHaveLength(1);
    now = 1000;
    const again = cache.get('1', 'c');
    expect(fake.calls).toHaveLength(2);
    fake.resolveAll('not-following');
    expect(await again).toBe('not-following');
  });

  test('unknown は短くしか保持せず、clear で全部捨てる', async () => {
    let now = 0;
    const fake = fakeCheck();
    const cache = new FollowStatusCache({
      check: fake.check,
      now: () => now,
      resultTtlMs: 1000,
      unknownTtlMs: 100,
    });
    const first = cache.get('1', 'c');
    fake.resolveAll('unknown');
    expect(await first).toBe('unknown');
    now = 100;
    const second = cache.get('1', 'c');
    expect(fake.calls).toHaveLength(2);
    fake.resolveAll('following');
    expect(await second).toBe('following');

    cache.clear();
    void cache.get('1', 'c');
    expect(fake.calls).toHaveLength(3);
    fake.resolveAll();
  });

  test('同時に問い合わせるのは上限までで、残りは順番待ちする', async () => {
    const fake = fakeCheck();
    const cache = new FollowStatusCache({ check: fake.check, maxConcurrent: 3 });
    const results = Array.from({ length: 10 }, (_, i) => cache.get(String(i), 'c'));
    await Promise.resolve();
    expect(fake.inFlight()).toBe(3);

    // 枠が空くたびに次が始まり、最大でも上限を超えない
    while (fake.inFlight() > 0) {
      fake.resolveAll();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await Promise.all(results)).toHaveLength(10);
    expect(fake.calls).toHaveLength(10);
    expect(fake.maxInFlight()).toBe(3);
  });
});
