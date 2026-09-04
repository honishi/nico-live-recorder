/** 数値設定の許容範囲と、範囲外や壊れた値のときに戻す既定値 */
export interface NumberRange {
  min: number;
  max: number;
  default: number;
}

/** フォロー中番組のポーリング間隔 (秒)。短すぎる値はニコニコの API を叩き続けることになる */
export const POLL_INTERVAL_SEC: NumberRange = { min: 15, max: 300, default: 30 };

/** 保存先の空き容量の警告しきい値 (GB)。0 は確認しない */
export const MIN_FREE_SPACE_GB: NumberRange = { min: 0, max: 10_000, default: 5 };

/** 有限の数値で範囲内ならその値、そうでなければ undefined */
export function numberInRange(value: unknown, range: NumberRange): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= range.min &&
    value <= range.max
    ? value
    : undefined;
}
