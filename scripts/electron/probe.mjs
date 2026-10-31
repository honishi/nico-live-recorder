import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import electron from 'electron';
import { createOutputDiagnostics } from './diagnostics.mjs';

/** 専用mainだけを実行する検査も、環境・出力検査・診断保存を同じ方針にする。 */
export async function runElectronProbe(work, entry, args = [], extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
    NLR_USER_DATA: path.join(work, 'userdata'),
    NLR_OUTPUT_DIR: path.join(work, 'recordings'),
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'NICO_USER_SESSION'])
    delete env[key];
  let result;
  try {
    result = await promisify(execFile)(electron, [entry, ...args], {
      cwd: work,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    result = error;
    throw error;
  } finally {
    const logs = path.join(work, 'userdata/logs');
    await mkdir(logs, { recursive: true });
    await writeFile(
      path.join(logs, `probe-${args.includes('--restore') ? 'restore' : 'initial'}.log`),
      `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`,
    );
  }
  const errors = [];
  const diagnostics = createOutputDiagnostics(errors);
  diagnostics.append('stdout', result.stdout);
  diagnostics.append('stderr', result.stderr);
  diagnostics.finish();
  assert.deepEqual(errors, []);
  process.stdout.write(result.stdout);
  return result.stdout;
}
