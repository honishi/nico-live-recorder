import { TimeshiftRemainingTime } from '../../../src/main/core/recorder/timeshift-remaining-time';

test('開始直後や未取得のトラックがある間は推定しない', () => {
  const estimate = new TimeshiftRemainingTime([100, 100], 0);
  expect(estimate.estimate([10, 10], 1000)).toBeUndefined();
  expect(estimate.estimate([20, 0], 3000)).toBeUndefined();
});

test('速い音声に引きずられず、遅い映像の完了までを推定する', () => {
  const estimate = new TimeshiftRemainingTime([100, 100], 0);
  expect(estimate.estimate([20, 80], 10_000)).toBe(40);
  expect(estimate.estimate([30, 100], 15_000)).toBe(35);
});

test('最近の速度変化を反映し、停滞後は古い残り時間を取り消す', () => {
  const estimate = new TimeshiftRemainingTime([1000], 0);
  estimate.estimate([100], 10_000);
  estimate.estimate([200], 20_000);
  expect(estimate.estimate([400], 30_000)).toBe(40);
  estimate.estimate([400], 40_000);
  expect(estimate.estimate([400], 50_000)).toBeUndefined();
  expect(estimate.estimate([500], 60_000)).toBe(100);
});

test('単一トラックと完了を扱い、別の録画へ速度を持ち越さない', () => {
  const estimate = new TimeshiftRemainingTime([100], 0);
  expect(estimate.estimate([25], 10_000)).toBe(30);
  expect(estimate.estimate([100], 20_000)).toBe(0);
  expect(new TimeshiftRemainingTime([100], 20_000).estimate([0], 21_000)).toBeUndefined();
});

test('同じ配列が更新されても、過去の観測値を保持する', () => {
  const estimate = new TimeshiftRemainingTime([1000], 0);
  const saved = [100];
  estimate.estimate(saved, 10_000);
  saved[0] = 400;
  expect(estimate.estimate(saved, 30_000)).toBe(40);
});
