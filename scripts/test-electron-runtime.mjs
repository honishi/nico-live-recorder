import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runElectronScenario } from './electron/scenario.mjs';
import { runElectronProbe } from './electron/probe.mjs';

await runElectronScenario('runtime', async ({ work }) => {
  const output = await runElectronProbe(
    work,
    fileURLToPath(new URL('./electron/network-main.cjs', import.meta.url)),
  );
  assert.ok(output.includes('Electron network OK:'), '通信検証の完了前に終了しました');
});
