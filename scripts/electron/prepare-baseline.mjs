import { createRequire } from 'node:module';
import { mkdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Electron自身のインストーラーと同じ、lockfileで固定した取得・検証・展開実装を使う。
const require = createRequire(import.meta.url);
const electronRequire = createRequire(require.resolve('electron/package.json'));
const { downloadArtifact } = electronRequire('@electron/get');
const { extract } = electronRequire('@electron-internal/extract-zip');
const { version } = JSON.parse(await readFile(new URL('./baseline.json', import.meta.url), 'utf8'));
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = path.join(
  root,
  '.cache/electron-baseline',
  version,
  `${process.platform}-${process.arch}`,
);
const binary = path.join(
  directory,
  process.platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron',
);
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
