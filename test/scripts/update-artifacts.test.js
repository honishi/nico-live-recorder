import { beforeEach, afterEach, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dump } from 'js-yaml';
import { verifyUpdateArtifacts, verifyUpdateConfig } from '../../scripts/updates/verify.mjs';

let directory;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'nlr-update-artifacts-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function metadata(platform) {
  const file = platform === 'darwin' ? 'app.zip' : 'setup.exe';
  const contents = Buffer.from('installer');
  writeFileSync(path.join(directory, file), contents);
  writeFileSync(path.join(directory, `${file}.blockmap`), 'blockmap');
  writeFileSync(
    path.join(directory, platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'),
    dump({
      version: '1.0.0',
      files: [
        {
          url: file,
          size: contents.length,
          sha512: createHash('sha512').update(contents).digest('base64'),
        },
      ],
    }),
  );
  return path.join(directory, file);
}

test.each(['darwin', 'win32'])(
  '%s の更新情報はバージョンと実体のハッシュを検証する',
  async (platform) => {
    const file = metadata(platform);
    await verifyUpdateArtifacts(directory, '1.0.0', platform);
    await expect(verifyUpdateArtifacts(directory, '2.0.0', platform)).rejects.toThrow('バージョン');
    writeFileSync(file, 'corrupted');
    await expect(verifyUpdateArtifacts(directory, '1.0.0', platform)).rejects.toThrow('SHA-512');
  },
);

test('差分更新ファイルが欠けた成果物を公開させない', async () => {
  const file = metadata('darwin');
  rmSync(`${file}.blockmap`);
  await expect(verifyUpdateArtifacts(directory, '1.0.0', 'darwin')).rejects.toThrow();
});

test('アプリ内の配信元が意図した公開リポジトリと異なる場合は失敗する', async () => {
  const config = {
    provider: 'github',
    owner: 'honishi',
    repo: 'nico-live-recorder-update-test',
    updaterCacheDirName: 'nico-live-recorder-update-test-updater',
  };
  const file = path.join(directory, 'app-update.yml');
  writeFileSync(file, dump(config));
  await verifyUpdateConfig(directory);
  writeFileSync(file, dump({ ...config, owner: 'other' }));
  await expect(verifyUpdateConfig(directory)).rejects.toThrow();
  writeFileSync(file, dump({ ...config, repo: 'nico-live-recorder' }));
  await expect(verifyUpdateConfig(directory)).rejects.toThrow();
  writeFileSync(file, dump({ ...config, updaterCacheDirName: 'nico-live-recorder-updater' }));
  await expect(verifyUpdateConfig(directory)).rejects.toThrow();
});
