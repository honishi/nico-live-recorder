import {
  inspectFragmentTiming,
  requireContinuousFragments,
} from '../../../src/main/core/nico/timeshift-continuity';
import { fragment, fragmentInit, mp4Box } from '../../helpers/fmp4';

test.each(['tfhd', 'trex', 'trun'] as const)(
  '%s のdurationから境界の時刻連続性を検証する',
  (source) => {
    const init = fragmentInit();
    const first = inspectFragmentTiming(fragment(0n, source), init);
    const next = inspectFragmentTiming(fragment(6n, source), init);
    expect(first.tracks.get(1)).toEqual({ start: 0n, end: 6n });
    expect(() => requireContinuousFragments(first, next)).not.toThrow();
  },
);

test('1セグメント内の複数moofを集計し、int64の精度を保つ', () => {
  const at = 9007199254740993n;
  const result = inspectFragmentTiming(
    Buffer.concat([fragment(at), fragment(at + 6n)]),
    fragmentInit(),
  );
  expect(result.tracks.get(1)).toEqual({ start: at, end: at + 12n });
});

test.each([0n, 5n, 7n])('リセット・重複・飛び (次の開始=%s) を無条件に通さない', (next) => {
  const init = fragmentInit();
  expect(() =>
    requireContinuousFragments(
      inspectFragmentTiming(fragment(0n), init),
      inspectFragmentTiming(fragment(next), init),
    ),
  ).toThrow('DISCONTINUITY_TIMESTAMP_CHANGED');
});

test('初期化情報・トラック構成の変更を拒否する', () => {
  const first = inspectFragmentTiming(fragment(0n), fragmentInit());
  expect(() =>
    requireContinuousFragments(first, inspectFragmentTiming(fragment(6n), fragmentInit(2))),
  ).toThrow('DISCONTINUITY_FORMAT_CHANGED');
  expect(() =>
    requireContinuousFragments(
      first,
      inspectFragmentTiming(fragment(6n, 'tfhd', 2), fragmentInit()),
    ),
  ).toThrow('DISCONTINUITY_TIMESTAMP_CHANGED');
});

test('境界前の欠落やセグメント内の時刻飛びを成功扱いにしない', () => {
  expect(() =>
    requireContinuousFragments(undefined, inspectFragmentTiming(fragment(6n), fragmentInit())),
  ).toThrow();
  expect(() =>
    inspectFragmentTiming(Buffer.concat([fragment(0n), fragment(7n)]), fragmentInit()),
  ).toThrow('DISCONTINUITY_TIMING_UNSUPPORTED');
});

test.each([
  Buffer.from('broken'),
  mp4Box('moof'),
  Buffer.from([0, 0, 0, 1, 109, 111, 111, 102]),
  mp4Box('moof', mp4Box('traf')),
])('不完全・未対応のboxは推測で結合しない', (data) => {
  expect(() => inspectFragmentTiming(data, fragmentInit())).toThrow(
    'DISCONTINUITY_TIMING_UNSUPPORTED',
  );
});
