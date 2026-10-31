import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyScenarioDiagnostics } from './diagnostics.mjs';

/** 途中の失敗でも全資源を片付け、削除前に今回の一時環境の診断情報だけを保存する。 */
export async function runElectronScenario(name, run) {
  const work = await mkdtemp(path.join(os.tmpdir(), `nlr 日本語 テスト ${name}-`));
  const apps = [];
  const cleanups = [];
  const failures = [];
  try {
    await run({
      work,
      defer: (cleanup) => cleanups.push(cleanup),
      launch: async (options = {}) => {
        const { launchElectron } = await import('./driver.mjs');
        const app = await launchElectron({ ...options, work, label: name });
        apps.push(app);
        return app;
      },
    });
  } catch (error) {
    failures.push(error);
  } finally {
    // アプリを先に止め、まだ使っている偽サーバーや出力を先に消さない。
    for (const cleanup of [...apps.map((app) => () => app.dispose()), ...cleanups.reverse()]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await verifyScenarioDiagnostics(apps, work);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      try {
        const artifacts = path.resolve(
          process.env.NLR_TEST_ARTIFACTS ?? 'artifacts/electron',
          path.basename(work),
        );
        await mkdir(artifacts, { recursive: true });
        await writeFile(
          path.join(artifacts, 'failure.txt'),
          failures.map((error) => error.stack ?? String(error)).join('\n\n'),
        );
        for (const [index, app] of apps.entries()) {
          await writeFile(path.join(artifacts, `electron-${index}.log`), app.output());
          await writeFile(
            path.join(artifacts, `errors-${index}.json`),
            JSON.stringify(app.errors, null, 2),
          );
        }
        // Cookie DBや録画本体は持ち出さず、限定した診断ファイルを残す。
        for (const file of ['logs', 'settings.json', 'recording-history.json']) {
          await cp(path.join(work, 'userdata', file), path.join(artifacts, file), {
            recursive: true,
          }).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
        console.error(`Electron diagnostics: ${artifacts}`);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `${name}: ${failures.map((error) => error.message).join('; ')}`,
    );
}
