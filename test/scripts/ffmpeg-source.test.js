import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

let work;
let archive;
const payload = Buffer.from('offline source fixture');
beforeEach(() => {
  // 本物のキャッシュには触れず、スクリプトと入力だけを隔離した配置で実行する。
  work = mkdtempSync(path.join(os.tmpdir(), 'nlr-ffmpeg-source-'));
  const scripts = path.join(work, 'scripts/ffmpeg');
  mkdirSync(scripts, { recursive: true });
  for (const file of ['build.mjs', 'config.mjs']) {
    copyFileSync(
      new URL(`../../scripts/ffmpeg/${file}`, import.meta.url),
      path.join(scripts, file),
    );
  }
  writeFileSync(
    path.join(scripts, 'source.json'),
    JSON.stringify({
      version: 'test',
      url: 'http://127.0.0.1:1/must-not-fetch',
      sha256: createHash('sha256').update(payload).digest('hex'),
    }),
  );
  mkdirSync(path.join(work, '.cache/ffmpeg'), { recursive: true });
  archive = path.join(work, '.cache/ffmpeg/ffmpeg-test.tar.xz');
  writeFileSync(archive, payload);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function prepareSource() {
  return execFileSync(
    process.execPath,
    [path.join(work, 'scripts/ffmpeg/build.mjs'), '--download-only'],
    {
      cwd: work,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

test('共有ソースを再検証し、通信・展開・コンパイルをせずに完了する', () => {
  expect(prepareSource()).toContain('FFmpeg source verified:');
  expect(readFileSync(archive)).toEqual(payload);
  expect(existsSync(path.join(work, 'resources'))).toBe(false);
});

test('共有ソースのハッシュが違えば、書き換えずに失敗する', () => {
  writeFileSync(archive, 'corrupted');
  expect(prepareSource).toThrow('キャッシュ済み FFmpeg ソースの SHA-256 が一致しません');
  expect(readFileSync(archive, 'utf8')).toBe('corrupted');
});

// 外部サイトへは接続せず、取得失敗と内容検証の境界を実子プロセスで確認する。
test.each(['http', 'disconnect', 'exhausted', 'checksum'])(
  '%s: 再試行を制限し、検証に成功したソースだけ保存する',
  async (failure) => {
    const { startFakeHttp } = await import('../helpers/fake-http');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    let requests = 0;
    const server = await startFakeHttp((_request, response) => {
      requests++;
      if (failure === 'exhausted' || (failure === 'http' && requests === 1)) {
        response.writeHead(503);
        response.end('retry later');
      } else if (failure === 'disconnect' && requests === 1) response.destroy();
      else response.end(failure === 'checksum' ? 'corrupted' : payload);
    });
    try {
      const sourceFile = path.join(work, 'scripts/ffmpeg/source.json');
      const config = JSON.parse(readFileSync(sourceFile, 'utf8'));
      writeFileSync(sourceFile, JSON.stringify({ ...config, url: server.url }));
      rmSync(archive);
      const run = promisify(execFile)(
        process.execPath,
        [path.join(work, 'scripts/ffmpeg/build.mjs'), '--download-only'],
        { cwd: work, timeout: 10_000 },
      );
      if (failure === 'exhausted' || failure === 'checksum') {
        await expect(run).rejects.toThrow(failure === 'checksum' ? 'SHA-256' : 'HTTP 503');
        expect(requests).toBe(failure === 'checksum' ? 1 : 3);
        expect(existsSync(archive)).toBe(false);
      } else {
        const result = await run;
        expect(result.stdout).toContain('FFmpeg source verified:');
        expect(result.stderr).toContain('download failed (1/3)');
        expect(requests).toBe(2);
        expect(readFileSync(archive)).toEqual(payload);
      }
    } finally {
      await server.close();
    }
  },
  15_000,
);
