import { Writable } from 'node:stream';
import {
  downloadMetrics,
  downloadTimeshiftTrack,
} from '../../../src/main/core/nico/timeshift-download';
import { TimeshiftError } from '../../../src/main/core/nico/timeshift-common';
import {
  testTrackDownload,
  trackSegments,
  trackOutput,
} from '../../helpers/track-download-contract';

afterEach(() => vi.unstubAllGlobals());

testTrackDownload({
  downloadTrack: downloadTimeshiftTrack,
  downloadMetrics,
  ErrorType: TimeshiftError,
});

test.each(['continuous', 'reset', 'format'] as const)(
  '不連続タグの%sを実データで判定し、失敗した区間は出力しない',
  async (scenario) => {
    const { fragment, fragmentInit } = await import('../../helpers/fmp4');
    const init = fragmentInit();
    const first = fragment(0n);
    const second = fragment(scenario === 'reset' ? 0n : 6n);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const data = url.endsWith('/map0')
          ? init
          : url.endsWith('/map1')
            ? fragmentInit(2)
            : url.endsWith('/0')
              ? first
              : second;
        return Promise.resolve(new Response(data));
      }),
    );
    const tracks = trackSegments(2).map((item, index) => ({
      ...item,
      mapUri: `https://example.test/map${scenario === 'format' ? index : 0}`,
    }));
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    const task = downloadTimeshiftTrack(
      tracks,
      sink,
      [],
      5,
      new AbortController().signal,
      downloadMetrics(),
      undefined,
      new Set([11]),
    );
    if (scenario === 'continuous') {
      expect((await task).segments).toBe(2);
      expect(Buffer.concat(chunks)).toEqual(Buffer.concat([init, first, second]));
    } else {
      await expect(task).rejects.toThrow(
        scenario === 'reset' ? 'DISCONTINUITY_TIMESTAMP_CHANGED' : 'DISCONTINUITY_FORMAT_CHANGED',
      );
      expect(Buffer.concat(chunks)).toEqual(Buffer.concat([init, first]));
    }
  },
);

test('プレビュー失敗でもタイムシフトを最後まで保存し、初期化情報を渡す', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => Promise.resolve(new Response(url.endsWith('/init') ? 'init' : 'video'))),
  );
  const { sink, chunks } = trackOutput();
  const onVideoSample = vi.fn(() => {
    throw new Error('preview failed');
  });
  const tracks = trackSegments(2).map((segment) => ({
    ...segment,
    mapUri: 'https://example.test/init',
  }));
  const result = await downloadTimeshiftTrack(
    tracks,
    sink,
    [],
    2,
    new AbortController().signal,
    downloadMetrics(),
    undefined,
    undefined,
    onVideoSample,
  );
  expect(result.segments).toBe(2);
  expect(chunks).toEqual(['init', 'video', 'video']);
  expect(onVideoSample).toHaveBeenCalledTimes(2);
  expect(onVideoSample).toHaveBeenCalledWith({
    data: Buffer.from('video'),
    init: Buffer.from('init'),
  });
});
