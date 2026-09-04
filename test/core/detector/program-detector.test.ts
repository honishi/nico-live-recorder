import { EventEmitter } from 'node:events';
import {
  ProgramDetector,
  type DetectedProgram,
} from '../../../src/main/core/detector/program-detector';
import type { FollowingProgram } from '../../../src/main/core/nico/follow-programs';
import type { WebPushManager } from '../../../src/main/core/push/web-push-manager';
import { NicoLiveProgramStatus } from '../../../src/main/vendor/nico-client/types';

// ネットワークに出る 2 つの依存を差し替える
const fetchFollowing = vi.hoisted(() => vi.fn<() => Promise<FollowingProgram[]>>());
const getProgramInfo = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/core/nico/follow-programs', () => ({
  fetchFollowingOnAirPrograms: fetchFollowing,
  NotAuthenticatedError: class extends Error {},
}));
vi.mock('../../../src/main/vendor/nico-client/NicoClient', () => ({
  NicoClient: class {
    getProgramInfo = getProgramInfo;
  },
}));

const following = (id: string, providerId: string): FollowingProgram => ({
  id,
  title: `title-${id}`,
  watchPageUrl: `https://live.nicovideo.jp/watch/${id}`,
  providerId,
  providerName: `provider-${providerId}`,
  isFollowerOnly: false,
});

function createDetector(push?: EventEmitter): {
  detector: ProgramDetector;
  detected: DetectedProgram[];
} {
  const detected: DetectedProgram[] = [];
  const detector = new ProgramDetector({
    push: push as unknown as WebPushManager,
    cookieHeader: async () => 'user_session=dummy',
    pollIntervalMs: 30_000,
  });
  detector.on('program', (program) => detected.push(program));
  return { detector, detected };
}

describe('ProgramDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchFollowing.mockReset();
    getProgramInfo.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('初回ポーリングは alreadyOnAir 付きで通知し、2 回目以降は新着だけを通知する', async () => {
    fetchFollowing
      .mockResolvedValueOnce([following('lv1', '100'), following('lv2', '200')])
      .mockResolvedValueOnce([following('lv2', '200'), following('lv3', '300')]);
    const { detector, detected } = createDetector();

    detector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(detected.map((p) => [p.programId, p.alreadyOnAir, p.source])).toEqual([
      ['lv1', true, 'poll'],
      ['lv2', true, 'poll'],
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(detected.map((p) => p.programId)).toEqual(['lv1', 'lv2', 'lv3']);
    expect(detected[2].alreadyOnAir).toBe(false);
    detector.stop();
  });

  test('ポーリング間隔が NaN や短すぎるときは 30 秒に戻す', async () => {
    for (const pollIntervalMs of [Number.NaN, 1_000, 0, 10 * 60 * 1000]) {
      fetchFollowing.mockReset();
      fetchFollowing.mockResolvedValue([]);
      const warn = vi.fn();
      const detector = new ProgramDetector({
        cookieHeader: async () => 'user_session=dummy',
        pollIntervalMs,
        logger: { debug() {}, info() {}, warn, error() {} },
      });
      detector.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFollowing).toHaveBeenCalledTimes(1);
      // 1ms 間隔に丸められていれば、ここで何千回も呼ばれる
      await vi.advanceTimersByTimeAsync(29_000);
      expect(fetchFollowing, String(pollIntervalMs)).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchFollowing, String(pollIntervalMs)).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      detector.stop();
    }
  });

  test('markSeen した番組はポーリングで通知しない', async () => {
    fetchFollowing.mockResolvedValue([following('lv1', '100')]);
    const { detector, detected } = createDetector();
    detector.markSeen('lv1');

    detector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(detected).toHaveLength(0);
    detector.stop();
  });

  test('unmarkSeen した番組は次のポーリングで再度通知する', async () => {
    fetchFollowing.mockResolvedValue([following('lv1', '100')]);
    const { detector, detected } = createDetector();
    detector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(detected).toHaveLength(1);

    detector.unmarkSeen('lv1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(detected).toHaveLength(2);
    detector.stop();
  });

  test('未ログインならポーリングしない', async () => {
    const detector = new ProgramDetector({ cookieHeader: async () => undefined });
    detector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFollowing).not.toHaveBeenCalled();
    detector.stop();
  });

  test('push は番組情報を解決して通知し、同じ番組の 2 回目や古い通知は捨てる', async () => {
    fetchFollowing.mockResolvedValue([]);
    getProgramInfo.mockResolvedValue({
      title: 'pushed',
      providerId: '100',
      providerName: 'provider-100',
      status: NicoLiveProgramStatus.onAir,
      beginTime: 1_700_000_000,
    });
    const push = new EventEmitter();
    const { detector, detected } = createDetector(push);
    detector.start();
    await vi.advanceTimersByTimeAsync(0);

    const now = new Date();
    push.emit('program', { programId: 'lv9', createdAt: now.toISOString(), receivedAt: now });
    await vi.advanceTimersByTimeAsync(0);
    push.emit('program', { programId: 'lv9', createdAt: now.toISOString(), receivedAt: now });
    push.emit('program', {
      programId: 'lv10',
      createdAt: new Date(now.getTime() - 11 * 60 * 1000).toISOString(),
      receivedAt: now,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      programId: 'lv9',
      source: 'push',
      title: 'pushed',
      providerId: '100',
      alreadyOnAir: false,
    });
    expect(getProgramInfo).toHaveBeenCalledTimes(1);
    detector.stop();
  });

  test('push で解決に失敗した番組は、後のポーリングで拾える', async () => {
    getProgramInfo.mockRejectedValue(new Error('network'));
    fetchFollowing.mockResolvedValueOnce([]).mockResolvedValueOnce([following('lv9', '100')]);
    const push = new EventEmitter();
    const { detector, detected } = createDetector(push);
    detector.start();
    await vi.advanceTimersByTimeAsync(0);

    push.emit('program', { programId: 'lv9', receivedAt: new Date() });
    await vi.advanceTimersByTimeAsync(0);
    expect(detected).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(detected.map((p) => [p.programId, p.source])).toEqual([['lv9', 'poll']]);
    detector.stop();
  });
});
