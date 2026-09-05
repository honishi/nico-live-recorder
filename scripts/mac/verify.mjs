import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `${command} による署名・公証の検証に失敗しました\n${output}`);
  return output;
}

export function verifyNotarizedApp(app, teamId) {
  assert.match(teamId ?? '', /^[A-Z0-9]{10}$/, '検証する Apple Team ID が必要です');

  // アプリ全体の署名と、Resources 配下にある独立したバイナリの署名を検証する。
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const binaries = ['ffmpeg', 'ffprobe'].map((name) =>
    path.join(app, 'Contents', 'Resources', 'ffmpeg', name),
  );
  for (const binary of binaries) run('/usr/bin/codesign', ['--verify', '--strict', binary]);
  for (const file of [app, ...binaries]) {
    const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', file]);
    assert.match(
      signature,
      /^Authority=Developer ID Application:/m,
      `Developer ID 署名なし: ${file}`,
    );
    assert.match(signature, new RegExp(`^TeamIdentifier=${teamId}$`, 'm'), `チーム不一致: ${file}`);
    assert.match(
      signature,
      /^CodeDirectory .*flags=.*\bruntime\b/m,
      `Hardened Runtime なし: ${file}`,
    );
    assert.match(signature, /^Timestamp=.+/m, `タイムスタンプなし: ${file}`);
    if (file === app) {
      assert.match(
        signature,
        /^Identifier=com\.honishi\.nico-live-recorder$/m,
        'Bundle ID が不一致です',
      );
    }
  }

  // 公証がスキップされたビルドや、ZIP への格納でチケットが失われた成果物を拒否する。
  run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  const assessment = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  assert.match(assessment, /: accepted\r?$/m, 'Gatekeeper に受け入れられていません');
  assert.match(
    assessment,
    /^source=Notarized Developer ID\r?$/m,
    'Developer ID の公証がありません',
  );
  console.log(`Notarized app verified: ${app}`);
}
