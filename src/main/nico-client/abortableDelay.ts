import { setTimeout as sleep } from 'node:timers/promises';

// abort 時はタイマーを解除して即座に resolve する。中断の判定は呼び出し側の signal チェックに委ねる
export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) {
      return;
    }
    throw error;
  }
}
