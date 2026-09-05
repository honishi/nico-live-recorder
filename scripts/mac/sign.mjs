import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { signAsync } from '@electron/osx-sign';

function fileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// electron-builder が選んだ証明書・一時キーチェーン・ファイル別設定を引き継ぐ。
export default async function sign(options, packager) {
  // カスタム署名フックは証明書なしでも呼ばれるため、通常の CI はここでスキップする。
  if (!options.identity) {
    assert.ok(!packager.forceCodeSigning, 'macOS の署名用証明書が見つかりません');
    console.log('macOS signing skipped: no signing identity');
    return;
  }

  const bundle = path.resolve(options.app, 'Contents', 'Resources', 'ffmpeg');
  const manifestPath = path.join(bundle, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const binaries = ['ffmpeg', 'ffprobe'].map((name) => path.join(bundle, name));
  const visitedBinaries = new Set();
  let manifestUpdated = false;

  // afterPack の実行検証を通った実体が、署名の直前にも一致することを確認する。
  for (const [name, hash] of Object.entries(manifest.files)) {
    assert.equal(fileHash(path.join(bundle, name)), hash, `署名前の同梱ファイル不一致: ${name}`);
  }

  await signAsync({
    ...options,
    optionsForFile(file) {
      const settings = options.optionsForFile(file);
      const resolvedFile = path.resolve(file);
      if (binaries.includes(resolvedFile)) {
        visitedBinaries.add(resolvedFile);
        // FFmpeg / ffprobe は JIT を使わない独立した実行ファイル。
        return { ...settings, entitlements: [] };
      }

      // osx-sign は内側から順に署名し、最後にトップレベルの .app を署名する。
      // その直前にだけ manifest を更新し、署名後の Resources は書き換えない。
      if (file === options.app) {
        for (const binary of binaries) {
          assert.ok(visitedBinaries.has(binary), `署名対象に含まれていません: ${binary}`);
          execFileSync('/usr/bin/codesign', ['--verify', '--strict', binary], {
            stdio: 'pipe',
            timeout: 30_000,
          });
        }
        for (const [name, hash] of Object.entries(manifest.files)) {
          const filePath = path.join(bundle, name);
          const actual = fileHash(filePath);
          if (binaries.includes(filePath)) {
            manifest.files[name] = actual;
          } else {
            assert.equal(actual, hash, `署名中に同梱資料が変更されました: ${name}`);
          }
        }
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        manifestUpdated = true;
      }
      return settings;
    },
  });
  assert.ok(manifestUpdated, 'アプリ全体の署名前に manifest を確定できませんでした');
}
