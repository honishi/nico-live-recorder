import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import electron from 'electron';

const work = await mkdtemp(path.join(os.tmpdir(), 'nlr-auth-test-'));
const env = {
  ...process.env,
  NLR_USER_DATA: path.join(work, 'userdata'),
  NLR_OUTPUT_DIR: path.join(work, 'recordings'),
};
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NICO_USER_SESSION']) delete env[key];
try {
  // 本体のNicoAuthをそのままbundleし、ElectronのCookie実装で検証する。
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      ssr: fileURLToPath(new URL('./electron/auth-main.ts', import.meta.url)),
      outDir: work,
      emptyOutDir: false,
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'auth-main.cjs' },
      },
    },
  });
  for (const args of [[], ['--restore']]) {
    const result = spawnSync(electron, [path.join(work, 'auth-main.cjs'), ...args], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes('Electron auth OK:'));
    process.stdout.write(result.stdout);
  }
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
