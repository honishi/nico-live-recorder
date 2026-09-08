interface Sample {
  at: number;
  saved: number[];
}

/** 直近約20秒の書き込み速度から、遅い方のトラックが終わるまでを推定する。 */
export class TimeshiftRemainingTime {
  private samples: Sample[];

  constructor(
    private readonly totals: number[],
    startedAt = performance.now(),
  ) {
    this.samples = [{ at: startedAt, saved: totals.map(() => 0) }];
  }

  estimate(saved: number[], now = performance.now()): number | undefined {
    // 1秒に1点だけ保持し、20秒窓の直前にある観測値を比較の基点に残す。
    while (this.samples.length > 1 && this.samples[1].at <= now - 20_000) this.samples.shift();
    const baseline = this.samples[0];
    const elapsed = (now - baseline.at) / 1000;
    if (now - this.samples.at(-1)!.at >= 1000) this.samples.push({ at: now, saved: [...saved] });

    // 接続直後の少量のデータからは推定しない。未取得・停滞中も数値を出さない。
    if (elapsed < 3) return undefined;
    let remaining = 0;
    for (let index = 0; index < this.totals.length; index += 1) {
      const pending = this.totals[index] - saved[index];
      if (pending <= 0) continue;
      const advanced = saved[index] - baseline.saved[index];
      if (advanced <= 0) return undefined;
      remaining = Math.max(remaining, (pending * elapsed) / advanced);
    }
    return Math.ceil(remaining);
  }
}
