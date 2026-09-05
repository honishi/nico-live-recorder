import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const release = path.join(root, 'release');
const extensions = process.platform === 'darwin' ? ['.zip', '.dmg'] : ['.exe'];
assert.ok(['darwin', 'win32'].includes(process.platform), '配布対象の OS 上で実行してください');
const artifacts = readdirSync(release).filter(
  (name) =>
    name.startsWith('NicoLiveRecorder') &&
    name.includes(version) &&
    extensions.includes(path.extname(name)),
);
for (const extension of extensions) {
  assert.ok(
    artifacts.some((name) => name.endsWith(extension)),
    `${extension} の成果物がありません`,
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

// インストーラは実行せず、一時領域に展開する。設定・録画・インストール先には触らない。
for (const name of artifacts) {
  const artifact = path.join(release, name);
  const work = mkdtempSync(path.join(tmpdir(), 'nlr-package-verify-'));
  let mounted = false;
  try {
    let resources;
    if (process.platform === 'darwin') {
      const unpacked = path.join(work, 'app');
      mkdirSync(unpacked);
      if (name.endsWith('.dmg')) {
        run('/usr/bin/hdiutil', [
          'attach',
          '-readonly',
          '-nobrowse',
          '-mountpoint',
          unpacked,
          artifact,
        ]);
        mounted = true;
      } else {
        run('/usr/bin/ditto', ['-x', '-k', artifact, unpacked]);
      }
      resources = path.join(unpacked, 'NicoLiveRecorder.app', 'Contents', 'Resources');
    } else {
      // GitHub の Windows ランナーにある 7-Zip を使って NSIS 内の payload を展開する。
      const sevenZip = path.join(process.env.ProgramFiles, '7-Zip', '7z.exe');
      const installer = path.join(work, 'installer');
      run(sevenZip, ['x', '-y', `-o${installer}`, artifact]);
      const payload = path.join(installer, '$PLUGINSDIR', 'app-64.7z');
      const unpacked = path.join(work, 'app');
      run(sevenZip, ['x', '-y', `-o${unpacked}`, payload]);
      resources = path.join(unpacked, 'resources');
    }
    console.log(
      run(process.execPath, [
        '--import',
        'tsx',
        path.join(root, 'scripts', 'ffmpeg', 'verify.mjs'),
        path.join(resources, 'ffmpeg'),
      ]),
    );
    console.log(`Artifact verified: ${artifact}`);
  } finally {
    // detach 失敗時にはマウント先を削除しない。
    if (mounted) run('/usr/bin/hdiutil', ['detach', path.join(work, 'app')]);
    rmSync(work, { recursive: true, force: true });
  }
}
