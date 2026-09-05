import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLicense, configureArgs, sha256, source, sourceName } from './config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const target = `${process.platform}-${process.arch}`;
if (!['darwin-arm64', 'win32-x64', 'linux-x64'].includes(target)) {
  throw new Error(`未対応の FFmpeg ビルド環境: ${target}`);
}
if (process.platform === 'win32' && process.env.MSYSTEM !== 'UCRT64') {
  throw new Error('Windows のビルドは MSYS2 UCRT64 シェルで実行してください');
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} が失敗しました\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout + result.stderr;
}

// ソースは固定 URL と SHA-256 で取得する。再ビルドも必ず未変更のアーカイブから始める。
const cache = path.join(root, '.cache', 'ffmpeg');
mkdirSync(cache, { recursive: true });
const archive = path.join(cache, sourceName);
if (!existsSync(archive)) {
  console.log(`Downloading ${source.url}`);
  const response = await fetch(source.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`FFmpeg source: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (sha256(data) !== source.sha256) throw new Error('FFmpeg ソースの SHA-256 が一致しません');
  writeFileSync(archive, data);
}
if (sha256(readFileSync(archive)) !== source.sha256) {
  throw new Error('キャッシュ済み FFmpeg ソースの SHA-256 が一致しません');
}
const work = mkdtempSync(path.join(cache, 'build-'));
run('tar', ['-xf', sourceName, '-C', path.basename(work)], cache);
const sourceDir = path.join(work, `ffmpeg-${source.version}`);
const args = configureArgs();
// Windows の make ターゲットにも .exe が必要。コピー対象・再ビルド手順と同じ名前を使う。
const binaries = ['ffmpeg', 'ffprobe'].map(
  (name) => name + (process.platform === 'win32' ? '.exe' : ''),
);
console.log(`Building FFmpeg ${source.version} for ${target}`);
run('bash', ['./configure', ...args], sourceDir);
run('make', [`-j${Math.min(availableParallelism(), 8)}`, ...binaries], sourceDir);

// バイナリとその対応ソース・許諾文を一組として作り、途中失敗した組を配布しない。
const staging = path.join(work, 'bundle');
const sourceOut = path.join(staging, 'source');
mkdirSync(sourceOut, { recursive: true });
copyFileSync(archive, path.join(sourceOut, sourceName));
// 実際に使用したビルド制御スクリプトも、その許諾文と一緒に対応ソースへ添付する。
const packaging = path.join(sourceOut, 'packaging');
mkdirSync(packaging);
for (const name of [
  'build.mjs',
  'config.mjs',
  'source.json',
  'NOTICE.txt',
  'COPYING.build-scripts',
]) {
  copyFileSync(new URL(`./${name}`, import.meta.url), path.join(packaging, name));
}

copyFileSync(new URL('./NOTICE.txt', import.meta.url), path.join(staging, 'NOTICE.txt'));
for (const name of ['COPYING.LGPLv2.1', 'LICENSE.md']) {
  copyFileSync(path.join(sourceDir, name), path.join(staging, name));
}
for (const name of [
  'config.h',
  'config_components.h',
  'ffbuild/config.mak',
  'ffbuild/config.log',
]) {
  copyFileSync(path.join(sourceDir, name), path.join(sourceOut, path.basename(name)));
}
for (const name of binaries) {
  copyFileSync(path.join(sourceDir, name), path.join(staging, name));
  chmodSync(path.join(staging, name), 0o755);
  const license = run(path.join(staging, name), ['-L']);
  const configuration = run(path.join(staging, name), ['-buildconf']);
  assertLicense(license, configuration);
  writeFileSync(path.join(sourceOut, `${name}.license.txt`), license);
  writeFileSync(path.join(sourceOut, `${name}.buildconf.txt`), configuration);
}

// 再ビルドには Node やこのリポジトリを必要としない。実際の引数とツールを残す。
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(
  path.join(sourceOut, 'rebuild.sh'),
  `#!/usr/bin/env bash\n# SPDX-License-Identifier: MIT (see packaging/COPYING.build-scripts)\nset -eu\ncd "$(dirname "$0")"\ntar -xf ${quote(sourceName)}\ncd ${quote(`ffmpeg-${source.version}`)}\nbash ./configure ${args.map(quote).join(' ')}\nmake -j2 ${binaries.map(quote).join(' ')}\n`,
);
let toolchain = `Target: ${target}\n${run(args.includes('--cc=clang') ? 'clang' : 'gcc', ['--version'])}\n${run('make', ['--version'])}`;
if (process.platform === 'darwin') {
  toolchain += run('xcrun', ['--show-sdk-version']);
}
if (process.platform === 'win32') {
  // UCRT と OS DLL 以外は静的にする。ランタイムに適用される例外・著作権表示も同梱する。
  const prefix = run('cygpath', ['-w', '/ucrt64']).trim();
  for (const name of ['gcc-libs', 'crt', 'headers', 'winpthreads']) {
    cpSync(
      path.join(prefix, 'share', 'licenses', name),
      path.join(staging, 'toolchain-licenses', name),
      {
        recursive: true,
      },
    );
  }
  toolchain += run('pacman', ['-Q']);
}
writeFileSync(path.join(sourceOut, 'toolchain.txt'), toolchain);

// 配布時に資料の欠落や差し替えを検出できるよう、全ファイルのハッシュを記録する。
function fileHashes(dir, prefix = '') {
  const hashes = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory())
      Object.assign(hashes, fileHashes(path.join(dir, entry.name), `${name}/`));
    else hashes[name] = sha256(readFileSync(path.join(dir, entry.name)));
  }
  return hashes;
}
writeFileSync(
  path.join(staging, 'manifest.json'),
  JSON.stringify(
    { version: source.version, target, source, configure: args, files: fileHashes(staging) },
    null,
    2,
  ) + '\n',
);
const destination = path.join(root, 'resources', 'ffmpeg', target);
mkdirSync(path.dirname(destination), { recursive: true });
rmSync(destination, { recursive: true, force: true });
renameSync(staging, destination);
rmSync(work, { recursive: true, force: true });
console.log(`FFmpeg bundle: ${destination}`);
