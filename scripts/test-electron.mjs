import assert from 'node:assert/strict';
import path from 'node:path';
import { verifyPreloadEvents } from './electron/preload-events.mjs';
import { runElectronScenario } from './electron/scenario.mjs';

await runElectronScenario('smoke', async ({ work, launch }) => {
  const first = await launch();
  // 実preloadからmainへ到達し、隔離した設定と未ログイン状態を読めることを確認する。
  const settings = await first.evaluate('window.api.getSettings()');
  assert.equal(settings.outputDir, path.join(work, 'recordings'));
  assert.deepEqual(settings.targets, []);
  assert.equal((await first.evaluate('window.api.getStatus()')).auth.loggedIn, false);
  assert.equal(await first.evaluate('typeof window.require'), 'undefined');

  await verifyPreloadEvents(first);

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
