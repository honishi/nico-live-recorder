import { silentLogger } from '../../src/main/core/logger';
import { EventEmitter } from 'node:events';
import { registerIpcHandlers, type IpcContext } from '../../src/main/app/ipc';

// 各ケースで使う部分だけを明記し、指定したメソッド名と引数は本体の型で検査する。
type Fixture<T> = T extends EventEmitter
  ? Partial<EventEmitter> & Fixture<Omit<T, keyof EventEmitter>>
  : T extends Promise<infer U>
    ? Promise<Fixture<U>>
    : T extends (...args: infer A) => infer R
      ? (...args: A) => Fixture<R>
      : T extends readonly (infer U)[]
        ? Fixture<U>[]
        : T extends object
          ? { [K in keyof T]?: Fixture<T[K]> }
          : T;

export function registerTestIpc(overrides: Fixture<IpcContext>): void {
  const context = {
    auth: new EventEmitter(),
    logger: silentLogger,
    getMainWindow: () => undefined,
    ...overrides,
  };
  // 未指定の依存を使うケースは、その場で原因が分かる例外にする。
  registerIpcHandlers(
    new Proxy(context, {
      get(target, key) {
        if (!(key in target)) throw new Error(`IPC fixture dependency missing: ${String(key)}`);
        return Reflect.get(target, key) as unknown;
      },
    }) as unknown as IpcContext,
  );
}

/** 検証するチャネルを1件に限定し、未登録・二重登録もその場で検出する。 */
export function ipcHandler<T extends (...args: never[]) => unknown>(
  calls: [string, unknown][],
  channel: string,
): T {
  const matches = calls.filter(([name]) => name === channel);
  expect(matches).toHaveLength(1);
  return matches[0][1] as T;
}
