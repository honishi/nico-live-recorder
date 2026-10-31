import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 取得側と実行側で、バージョン・OS別の配置先を揃える。
export const baselineVersion = JSON.parse(
  readFileSync(new URL('./baseline.json', import.meta.url), 'utf8'),
).version;
export const baselineDirectory = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  '.cache/electron-baseline',
  baselineVersion,
  `${process.platform}-${process.arch}`,
);
const executable =
  { darwin: 'Electron.app/Contents/MacOS/Electron', win32: 'electron.exe' }[process.platform] ??
  'electron';
export const baselineBinary = path.join(baselineDirectory, executable);
