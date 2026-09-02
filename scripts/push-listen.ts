// 開発用: push 通知の購読と受信を試す (録画はしない)
//   NICO_USER_SESSION=... npx tsx scripts/push-listen.ts [状態ファイル]
// 購読状態はファイルに保存し、次回はそれを再利用する。Ctrl-C で終了。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createConsoleLogger } from '../src/main/core/logger';
import { ProgramDetector } from '../src/main/core/detector/program-detector';
import { setPushLogger } from '../src/main/push/push-diagnostics';
import {
  WebPushManager,
  type PushStateStore,
  type PushSubscriptionState,
} from '../src/main/push/web-push-manager';

const statePath = path.resolve(process.argv[2] ?? './recordings/push-state.json');
const userSession = process.env['NICO_USER_SESSION'];
if (!userSession) {
  console.error('NICO_USER_SESSION 環境変数に user_session cookie の値を設定してください');
  process.exit(1);
}

const logger = createConsoleLogger('push');
setPushLogger({
  debug: (...args) => logger.debug('[autopush]', ...args),
  warn: (...args) => logger.warn('[autopush]', ...args),
  error: (...args) => logger.error('[autopush]', ...args),
});

const store: PushStateStore = {
  async load() {
    try {
      return JSON.parse(await fs.readFile(statePath, 'utf8')) as PushSubscriptionState;
    } catch {
      return undefined;
    }
  },
  async save(state) {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  },
  async clear() {
    await fs.rm(statePath, { force: true });
  },
};

const cookieHeader = async (): Promise<string | undefined> => `user_session=${userSession}`;

async function main(): Promise<void> {
  const push = new WebPushManager({ store, cookieHeader, logger });
  push.on('status', (status) => logger.info('status', status));
  push.on('error', (error) => logger.error('push error', error));

  const detector = new ProgramDetector({ push, cookieHeader, logger });
  detector.on('program', (program) => logger.info('DETECTED', program));
  detector.on('pollError', (error) => logger.warn('poll error', error.message));

  await push.start();
  detector.start();
  logger.info('listening... (Ctrl-C to stop)');

  process.on('SIGINT', () => {
    detector.stop();
    void push.stop().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  logger.error('failed', error);
  process.exit(1);
});
