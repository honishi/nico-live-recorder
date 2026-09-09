import { RecordingPreviews } from '../../src/main/app/recording-preview';
import { silentLogger } from '../../src/main/core/logger';
import type { VideoSample } from '../../src/main/core/nico/video-sample';

const sample = { data: Buffer.from('segment'), init: Buffer.from('init') };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('録画プレビューの負荷制限', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => vi.useRealTimers());

  test('要求がある間だけ生成し、5秒未満の映像は処理しない', async () => {
    const extract = vi.fn().mockResolvedValue(jpeg);
    const previews = new RecordingPreviews(silentLogger, extract);
    previews.offer('lv1', sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(extract).not.toHaveBeenCalled();
    expect(previews.request('lv1')).toBeUndefined();
    previews.offer('lv1', sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(previews.request('lv1')).toEqual({
      dataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      capturedAt: 10_000,
    });
    await vi.advanceTimersByTimeAsync(2_500);
    previews.request('lv1');
    previews.offer('lv1', sample);
    expect(extract).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_500);
    previews.request('lv1');
    previews.offer('lv1', sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  test('全番組で1件だけ生成し、待ち行列を作らない', async () => {
    let finish!: (image: Buffer) => void;
    const extract = vi.fn(
      () =>
        new Promise<Buffer>((resolve) => {
          finish = resolve;
        }),
    );
    const previews = new RecordingPreviews(silentLogger, extract);
    previews.request('lv1');
    previews.request('lv2');
    previews.offer('lv1', sample);
    previews.offer('lv2', sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(extract).toHaveBeenCalledTimes(1);
    finish(jpeg);
    await vi.advanceTimersByTimeAsync(0);
    expect(extract).toHaveBeenCalledTimes(1);
    previews.offer('lv2', sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(extract).toHaveBeenCalledTimes(2);
    previews.clear();
    finish(jpeg);
    await vi.advanceTimersByTimeAsync(0);
  });

  test('非表示・パート切替で中断し、古い処理の結果を次の購読に混ぜない', async () => {
    let finish!: (image: Buffer) => void;
    const extract = vi.fn(
      (_sample: VideoSample, _signal: AbortSignal) =>
        new Promise<Buffer>((resolve) => {
          finish = resolve;
        }),
    );
    const previews = new RecordingPreviews(silentLogger, extract);
    previews.request('lv1');
    previews.offer('lv1', sample);
    await vi.advanceTimersByTimeAsync(0);
    previews.remove('lv1');
    expect(extract.mock.calls[0][1].aborted).toBe(true);
    previews.request('lv1');
    previews.offer('lv1', sample);
    expect(extract).toHaveBeenCalledTimes(1);
    finish(jpeg);
    await vi.advanceTimersByTimeAsync(0);
    expect(previews.request('lv1')).toBeUndefined();
    previews.offer('lv1', sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(extract).toHaveBeenCalledTimes(2);
    previews.clear();
    finish(jpeg);
    await vi.advanceTimersByTimeAsync(0);
  });

  test('画面からの要求が途絶えたら生成を止める', async () => {
    const extract = vi.fn().mockResolvedValue(jpeg);
    const previews = new RecordingPreviews(silentLogger, extract);
    previews.request('lv1');
    await vi.advanceTimersByTimeAsync(3_000);
    previews.offer('lv1', sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(extract).not.toHaveBeenCalled();
  });

  test('デコード失敗は録画へ伝えず、次のサンプルで回復する', async () => {
    const extract = vi
      .fn()
      .mockRejectedValueOnce(new Error('decode failed'))
      .mockResolvedValue(jpeg);
    const previews = new RecordingPreviews(silentLogger, extract);
    previews.request('lv1');
    expect(() => previews.offer('lv1', sample)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(previews.request('lv1')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    previews.request('lv1');
    previews.offer('lv1', sample);
    await vi.advanceTimersByTimeAsync(0);
    expect(previews.request('lv1')?.dataUrl).toContain('data:image/jpeg;base64,');
  });

  test('大きすぎるセグメントや初期化情報をデコーダへ渡さない', async () => {
    const extract = vi.fn().mockResolvedValue(jpeg);
    const previews = new RecordingPreviews(silentLogger, extract);
    previews.request('lv1');
    previews.request('lv2');
    previews.offer('lv1', { data: Buffer.alloc(16 * 1024 * 1024 + 1) });
    previews.offer('lv2', { data: sample.data, init: Buffer.alloc(1024 * 1024 + 1) });
    await vi.advanceTimersByTimeAsync(0);
    expect(extract).not.toHaveBeenCalled();
  });

  test('同期した3番組に順番を譲り、映像が途絶えた番組には待ち続けない', async () => {
    const extract = vi.fn().mockResolvedValue(jpeg);
    const previews = new RecordingPreviews(silentLogger, extract);
    const offerAll = (): void => {
      for (const id of ['lv1', 'lv2', 'lv3']) {
        previews.request(id);
        previews.offer(id, { data: Buffer.from(id) });
      }
    };
    offerAll();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    // 要求のリースを先に更新し、全番組のセグメントが同時に届く状況を再現する。
    for (const id of ['lv1', 'lv2', 'lv3']) previews.request(id);
    offerAll();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    for (const id of ['lv1', 'lv2', 'lv3']) previews.request(id);
    offerAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(extract.mock.calls.map(([value]) => (value as VideoSample).data.toString())).toEqual([
      'lv1',
      'lv2',
      'lv3',
    ]);
    // 更新の古いlv1/lv2の映像が途絶えても、lv3は一定時間後に再び生成できる。
    await vi.advanceTimersByTimeAsync(15_000);
    for (const id of ['lv1', 'lv2', 'lv3']) previews.request(id);
    previews.offer('lv3', { data: Buffer.from('lv3') });
    await vi.advanceTimersByTimeAsync(0);
    expect(extract).toHaveBeenCalledTimes(4);
  });
});
