import assert from 'node:assert/strict';
import path from 'node:path';
import { verifyPreloadEvents } from './electron/preload-events.mjs';
import { runElectronScenario } from './electron/scenario.mjs';
import { verifyPaint } from './electron/paint.mjs';

await runElectronScenario('smoke', async ({ work, launch }) => {
  const first = await launch();
  // 実preloadからmainへ到達し、隔離した設定と未ログイン状態を読めることを確認する。
  const settings = await first.evaluate('window.api.getSettings()');
  assert.equal(settings.outputDir, path.join(work, 'recordings'));
  assert.deepEqual(settings.targets, []);
  assert.equal((await first.evaluate('window.api.getStatus()')).auth.loggedIn, false);
  assert.equal(await first.evaluate('typeof window.require'), 'undefined');

  await verifyPreloadEvents(first);
  await verifyPaint(first);

  // Reactの操作・再描画と、main→preload→rendererの変更通知を確認する。
  for (const label of ['録画対象', '履歴', 'ログ', '設定']) {
    await first.evaluate(
      `[...document.querySelectorAll('.tab-bar button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`,
    );
    await first.waitForDom(
      `document.querySelector('.tab.active')?.textContent.trim() === ${JSON.stringify(label)}`,
    );
  }
  const changed = await first.evaluate(`new Promise((resolve, reject) => {
    const unsubscribe = window.api.onSettingsChanged(() => {
      unsubscribe();
      window.api.getSettings().then(resolve, reject);
    });
    window.api.updateSettings({ pollIntervalSec: 45 }).catch(reject);
  })`);
  assert.equal(changed.pollIntervalSec, 45);
  await first.waitForDom('document.querySelector(".settings input[type=number]")?.value === "45"');
  assert.deepEqual(first.errors, []);
  assert.deepEqual(
    await first.evaluate(
      'window.api.getLogs().then(logs => logs.filter(log => log.level === "error"))',
    ),
    [],
  );
  await first.quit();

  // 同じ一時userDataで起動し直し、ディスク保存と復元を実際のアプリで確認する。
  const second = await launch();
  const restored = await second.evaluate('window.api.getSettings()');
  assert.equal(restored.pollIntervalSec, 45);
  assert.equal(restored.ui.tab, 'settings');
  await second.waitForDom('document.querySelector(".settings input[type=number]")?.value === "45"');
  assert.deepEqual(second.errors, []);
  assert.deepEqual(
    await second.evaluate(
      'window.api.getLogs().then(logs => logs.filter(log => log.level === "error"))',
    ),
    [],
  );
  await second.quit();
  console.log(
    'Electron smoke OK: startup, preload/IPC, React tabs, settings events, restart persistence',
  );
});

// 本物のElectronが警告だけで継続しても、検査器が終了後に失敗扱いにできることを確認する。
await runElectronScenario('diagnostics-check', async ({ work }) => {
  const previous = process.env.NLR_TEST_ARTIFACTS;
  process.env.NLR_TEST_ARTIFACTS = path.join(work, 'expected-diagnostics');
  let quitCompleted = false;
  try {
    await assert.rejects(
      runElectronScenario('expected-errors', async ({ launch }) => {
        const app = await launch();
        await app.mainEvaluate(`(() => {
        setImmediate(() => {
          void Promise.reject(new Error('NLR sentinel rejection'));
          process.emitWarning('NLR sentinel deprecation', 'DeprecationWarning');
        });
        __nlrTest.require('electron').app.on('will-quit', () => {
          process.stderr.write(new Date().toISOString() + ' ERROR NLR sentinel shutdown\\n');
        });
        return true;
      })()`);
        // 復旧検査用の除外を設定せず、本物のrendererクラッシュが検出されることを確かめる。
        await app.mainEvaluate(`new Promise(resolve => {
          const contents = __nlrTest.require('electron').BrowserWindow.getAllWindows()[0].webContents;
          contents.once('render-process-gone', () => resolve(true));
          contents.forcefullyCrashRenderer();
        })`);
        await app.reloadRenderer();
        await app.quit();
        quitCompleted = true;
      }),
      (error) => {
        assert.match(error.message, /UnhandledPromiseRejectionWarning/);
        assert.match(error.message, /NLR sentinel deprecation/);
        assert.match(error.message, /NLR sentinel shutdown/);
        assert.match(error.message, /Electron render-process-gone.*(?:crashed|killed)/);
        return true;
      },
    );
    assert.equal(quitCompleted, true);
  } finally {
    if (previous === undefined) delete process.env.NLR_TEST_ARTIFACTS;
    else process.env.NLR_TEST_ARTIFACTS = previous;
  }
  console.log('Electron diagnostics OK: rejection, deprecation, renderer crash, shutdown error');
});
