import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const work = await mkdtemp(path.join(os.tmpdir(), 'nlr-runtime-test-'));
const env = {
  ...process.env,
  NLR_USER_DATA: path.join(work, 'userdata'),
  NLR_OUTPUT_DIR: path.join(work, 'recordings'),
};
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NICO_USER_SESSION']) delete env[key];
const child = spawn(
  electron,
  [fileURLToPath(new URL('./electron/network-main.cjs', import.meta.url))],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
child.stdout.on('data', (data) => {
  output += data;
  process.stdout.write(data);
});
child.stderr.on('data', (data) => process.stderr.write(data));
// 未処理例外とハングも失敗にする。タイマーは成功判定や通信のタイミングには使わない。
const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
try {
  const [code, signal] = await once(child, 'close');
  assert.equal(code, 0, `Electron runtime exited: ${code}/${signal}`);
  assert.ok(output.includes('Electron network OK:'), '通信検証の完了前に終了しました');
} finally {
  clearTimeout(timer);
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
