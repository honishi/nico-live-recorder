import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { verifyNotarizedApp } from '../mac/verify.mjs';
import { verifyUpdateArtifacts, verifyUpdateConfig } from '../updates/verify.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const release = path.join(root, 'release');
const extensions = process.platform === 'darwin' ? ['.zip', '.dmg'] : ['.exe'];
const requireNotarization = process.argv.includes('--require-notarization');
assert.ok(['darwin', 'win32'].includes(process.platform), '配布対象の OS 上で実行してください');
if (requireNotarization) {
  assert.equal(process.platform, 'darwin', '公証の検証は macOS 上で実行してください');
  assert.match(process.env.APPLE_TEAM_ID ?? '', /^[A-Z0-9]{10}$/, 'APPLE_TEAM_ID が必要です');
}
const artifacts = readdirSync(release).filter(
  (name) =>
    name.startsWith('NicoLiveRecorderUpdateTest') &&
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

// 公開前に更新情報のバージョン・サイズ・ハッシュと差分更新ファイルも検証する。
await verifyUpdateArtifacts(release, version, process.platform);

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
      const app = path.join(unpacked, 'NicoLiveRecorderUpdateTest.app');
      // 圧縮・展開を経た最終成果物で、署名と公証チケットが残っていることを確かめる。
      if (requireNotarization) verifyNotarizedApp(app, process.env.APPLE_TEAM_ID);
      resources = path.join(app, 'Contents', 'Resources');
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
    await verifyUpdateConfig(resources);
    // 展開後の実体でも、版と保存先が試験用になっていることを確かめる。
    const asar = path.join(resources, 'app.asar');
    const metadata = JSON.parse(extractFile(asar, 'package.json').toString('utf8'));
    assert.equal(metadata.name, 'nico-live-recorder-update-test');
    assert.equal(metadata.version, version);
    // asar の内部検索も OS の区切り文字でパスを分解する。
    const main = extractFile(asar, path.join('out', 'main', 'index.js')).toString('utf8');
    assert.ok(main.includes('NicoLiveRecorderUpdateTest'));
    assert.ok(main.includes('nico-live-recorder-update-test'));
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
