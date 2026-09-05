/* electron-builder のフックは CommonJS で読み込まれる。 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// extraResources のコピーが完了した時点で、配布する実体を検証する。
module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch];
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('FFmpeg の実行検証のため、配布対象と同じ OS/CPU 上でパッケージしてください');
  }
  const resources =
    platform === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : path.join(context.appOutDir, 'resources');
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(__dirname, 'verify.mjs'), path.join(resources, 'ffmpeg')],
    {
      cwd: context.packager.projectDir,
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error('同梱 FFmpeg のライセンス / ソース / 多重化検証に失敗しました');
};
