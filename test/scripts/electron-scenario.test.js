import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, access, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runElectronScenario } from '../../scripts/electron/scenario.mjs';

let artifacts;
beforeEach(async () => {
  artifacts = await mkdtemp(path.join(os.tmpdir(), 'nlr-diagnostics-test-'));
  vi.stubEnv('NLR_TEST_ARTIFACTS', artifacts);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(artifacts, { recursive: true, force: true });
});

test('失敗とcleanup失敗を両方保持し、残りのcleanupと診断保存を続ける', async () => {
  let work;
  const order = [];
  await expect(
    runElectronScenario('failure-fixture', async (context) => {
      work = context.work;
      await mkdir(path.join(work, 'userdata/logs'), { recursive: true });
      await writeFile(path.join(work, 'userdata/logs/app.log'), 'diagnostic');
      await writeFile(path.join(work, 'userdata/Cookies'), 'must not export');
      context.defer(() => {
        order.push('first');
      });
      context.defer(() => {
        order.push('second');
        throw new Error('cleanup failure');
      });
      throw new Error('scenario failure');
    }),
  ).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: 'scenario failure' }),
      expect.objectContaining({ message: 'cleanup failure' }),
    ],
  });
  expect(order).toEqual(['second', 'first']);
  await expect(access(work)).rejects.toMatchObject({ code: 'ENOENT' });
  const directory = path.join(artifacts, path.basename(work));
  expect(await readFile(path.join(directory, 'failure.txt'), 'utf8')).toContain('scenario failure');
  expect(await readFile(path.join(directory, 'logs/app.log'), 'utf8')).toBe('diagnostic');
  await expect(access(path.join(directory, 'Cookies'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('成功時にもcleanupを実行し、一時ディレクトリを削除する', async () => {
  let work;
  const cleanup = vi.fn();
  await runElectronScenario('success-fixture', async (context) => {
    work = context.work;
    context.defer(cleanup);
  });
  expect(cleanup).toHaveBeenCalledOnce();
  await expect(access(work)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(path.join(artifacts, path.basename(work)))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
