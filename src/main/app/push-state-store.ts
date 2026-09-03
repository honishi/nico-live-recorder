import fs from 'node:fs/promises';
import path from 'node:path';
import type { PushStateStore, PushSubscriptionState } from '../core/push/web-push-manager';

/** push 購読状態を userData 配下の JSON に保存する */
export class FilePushStateStore implements PushStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PushSubscriptionState | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8')) as PushSubscriptionState;
    } catch {
      return undefined;
    }
  }

  async save(state: PushSubscriptionState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}
