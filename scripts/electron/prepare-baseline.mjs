import { createRequire } from 'node:module';
import { mkdir, access } from 'node:fs/promises';
import {
  baselineVersion as version,
  baselineDirectory as directory,
  baselineBinary as binary,
} from './baseline.mjs';

// Electron自身のインストーラーと同じ、lockfileで固定した取得・検証・展開実装を使う。
const require = createRequire(import.meta.url);
const electronRequire = createRequire(require.resolve('electron/package.json'));
const { downloadArtifact } = electronRequire('@electron/get');
const { extract } = electronRequire('@electron-internal/extract-zip');
const installed = await access(binary).then(
  () => true,
  () => false,
);
if (!installed) {
  // ダウンロード時には公式SHASUMS256による整合性検証も行う。アプリの検証中には通信しない。
  const archive = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
  });
  await mkdir(directory, { recursive: true });
  await extract(archive, { dir: directory });
}
console.log(`Baseline Electron ${version}: ${binary}`);
