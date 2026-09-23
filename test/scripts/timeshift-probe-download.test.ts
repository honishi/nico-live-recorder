import { downloadMetrics, downloadProbeTrack } from '../../scripts/timeshift-probe/download';
import { parseOptions, ProbeError } from '../../scripts/timeshift-probe/common';
import { testTrackDownload } from '../helpers/track-download-contract';

afterEach(() => vi.unstubAllGlobals());

testTrackDownload({ downloadTrack: downloadProbeTrack, downloadMetrics, ErrorType: ProbeError });

test('並列取得オプションは video 専用で1〜5、未指定なら既存方式', () => {
  expect(
    parseOptions(['lv1', '--anonymous', '--mode', 'video'], {})?.segmentThreads,
  ).toBeUndefined();
  expect(
    parseOptions(['lv1', '--anonymous', '--mode', 'video', '--segment-threads', '5'], {})
      ?.segmentThreads,
  ).toBe(5);
  for (const threads of ['0', '6', '1.5'])
    expect(() =>
      parseOptions(['lv1', '--anonymous', '--mode', 'video', '--segment-threads', threads], {}),
    ).toThrow();
  expect(() => parseOptions(['lv1', '--anonymous', '--segment-threads', '1'], {})).toThrow();
});
