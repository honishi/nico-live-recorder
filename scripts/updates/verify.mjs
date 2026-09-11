import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'js-yaml';

/** 更新情報が、検証済みの配布ファイルそのものを指していることを確かめる。 */
export async function verifyUpdateArtifacts(directory, version, platform) {
  const name = platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
  const metadata = load(await readFile(path.join(directory, name), 'utf8'));
  assert.equal(metadata.version, version, `${name}: バージョンが一致しません`);
  assert.ok(Array.isArray(metadata.files) && metadata.files.length > 0, `${name}: files が空です`);
  assert.ok(
    metadata.files.some((file) => file.url.endsWith(platform === 'darwin' ? '.zip' : '.exe')),
  );
  for (const file of metadata.files) {
    const filename = decodeURIComponent(file.url);
    assert.equal(
      path.basename(filename),
      filename,
      '更新ファイルは同じディレクトリに置いてください',
    );
    const target = path.join(directory, filename);
    assert.equal((await stat(target)).size, file.size, `${filename}: サイズが一致しません`);
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    assert.equal(hash.digest('base64'), file.sha512, `${filename}: SHA-512 が一致しません`);
    assert.ok((await stat(`${target}.blockmap`)).size > 0, `${filename}: blockmap がありません`);
  }
}

/** 展開後のアプリが意図した公開リポジトリから更新を取得することを確かめる。 */
export async function verifyUpdateConfig(resources) {
  const config = load(await readFile(path.join(resources, 'app-update.yml'), 'utf8'));
  assert.equal(config.provider, 'github');
  assert.equal(config.owner, 'honishi');
  assert.equal(config.repo, 'nico-live-recorder-update-test');
  assert.equal(config.updaterCacheDirName, 'nico-live-recorder-update-test-updater');
}
