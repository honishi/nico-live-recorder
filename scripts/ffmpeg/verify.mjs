import { extractPreviewImage } from '../../src/main/core/nico/preview-image.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listPackage } from '@electron/asar';
import { fileURLToPath } from 'node:url';
import { FfmpegMuxer } from '../../src/main/core/nico/ffmpeg.ts';
import { assertLicense, configureArgs, sha256, source, sourceName } from './config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const target = `${process.platform}-${process.arch}`;
const bundle = path.resolve(process.argv[2] ?? path.join(root, 'resources', 'ffmpeg', target));
const manifest = JSON.parse(readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
const suffix = process.platform === 'win32' ? '.exe' : '';
const ffmpeg = path.join(bundle, `ffmpeg${suffix}`);
const ffprobe = path.join(bundle, `ffprobe${suffix}`);

function run(command, args, cwd = root) {
  // 開発用ツールの DLL がたまたま PATH にあるだけで動作検証が通るのを防ぐ。
  const env = { ...process.env };
  if (process.platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') env[key] = `${process.env.SystemRoot}\\System32`;
    }
  }
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, env, cwd });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}\n${result.stdout}\n${result.stderr}`);
  return { stdout: result.stdout, output: result.stdout + result.stderr };
}

// 同梱ディレクトリ以外に従来の配布不可バイナリが残っていないことも確認する。
const resources = path.dirname(bundle);
const appArchive = path.join(resources, 'app.asar');
if (existsSync(appArchive)) {
  assert.ok(!listPackage(appArchive).some((name) => name.includes('/node_modules/ffmpeg-static/')));
  assert.ok(
    !existsSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static')),
  );
}

// 対象 OS/CPU、固定ソース、ビルド引数、全同梱ファイルを検査する。
assert.equal(manifest.target, target, '別 OS/CPU 向けの FFmpeg はパッケージできません');
assert.equal(manifest.version, source.version);
assert.deepEqual(manifest.source, source);
assert.deepEqual(manifest.configure, configureArgs());
const required = [
  `ffmpeg${suffix}`,
  `ffprobe${suffix}`,
  'COPYING.LGPLv2.1',
  'LICENSE.md',
  'NOTICE.txt',
  `source/${sourceName}`,
  'source/rebuild.sh',
  'source/packaging/build.mjs',
  'source/packaging/config.mjs',
  'source/packaging/source.json',
  'source/packaging/NOTICE.txt',
  'source/packaging/COPYING.build-scripts',
  'source/config.h',
  'source/config_components.h',
  'source/config.mak',
  'source/config.log',
  'source/toolchain.txt',
];
if (process.platform === 'win32') {
  required.push(
    'toolchain-licenses/gcc-libs/COPYING.RUNTIME',
    'toolchain-licenses/gcc-libs/COPYING3',
    'toolchain-licenses/crt/COPYING.MinGW-w64-runtime.txt',
    'toolchain-licenses/headers/COPYING.MinGW-w64.txt',
    'toolchain-licenses/winpthreads/COPYING',
  );
}
for (const name of required) assert.ok(manifest.files[name], `同梱資料が不足しています: ${name}`);
function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), `${name}/`) : [name];
  });
}
assert.deepEqual(
  listFiles(bundle).sort(),
  ['manifest.json', ...Object.keys(manifest.files)].sort(),
);
for (const [name, hash] of Object.entries(manifest.files)) {
  assert.equal(
    sha256(readFileSync(path.join(bundle, name))),
    hash,
    `同梱ファイルの不一致: ${name}`,
  );
}
assert.equal(sha256(readFileSync(path.join(bundle, 'source', sourceName))), source.sha256);
assert.equal(
  readFileSync(path.join(bundle, 'NOTICE.txt'), 'utf8'),
  readFileSync(new URL('./NOTICE.txt', import.meta.url), 'utf8'),
);
for (const name of ['COPYING.LGPLv2.1', 'LICENSE.md']) {
  const original = run(
    'tar',
    ['-xOf', sourceName, `ffmpeg-${source.version}/${name}`],
    path.join(bundle, 'source'),
  ).stdout;
  assert.equal(
    readFileSync(path.join(bundle, name), 'utf8'),
    original,
    `ライセンス本文が一致しません: ${name}`,
  );
}
const config = readFileSync(path.join(bundle, 'source', 'config.h'), 'utf8');
for (const name of ['GPL', 'NONFREE', 'VERSION3']) {
  assert.match(config, new RegExp(`^#define CONFIG_${name} 0$`, 'm'));
}

// 記録済みの出力だけでなく、パッケージに入った実体を実行して確かめる。
for (const binary of [ffmpeg, ffprobe]) {
  const license = run(binary, ['-L']).output;
  const configuration = run(binary, ['-buildconf']).output;
  assertLicense(license, configuration);
  assert.match(
    run(binary, ['-version']).output,
    new RegExp(`version ${source.version.replaceAll('.', '\\.')} `),
  );
  if (process.platform === 'darwin') {
    const dependencies = run('/usr/bin/otool', ['-L', binary])
      .stdout.split('\n')
      .slice(1)
      .filter((line) => line.trim());
    assert.ok(dependencies.length > 0);
    for (const dependency of dependencies) {
      assert.match(
        dependency.trim(),
        /^(\/usr\/lib\/|\/System\/Library\/)/,
        `外部 dylib: ${dependency}`,
      );
    }
  }
}

function probe(file) {
  return JSON.parse(
    run(ffprobe, ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', file]).stdout,
  );
}

// 合成した fMP4 を本番と同じ FfmpegMuxer に渡す。別音声・音声込み両経路を検証する。
const fixtures = path.join(root, 'test', 'fixtures', 'ffmpeg');
const work = mkdtempSync(path.join(tmpdir(), 'nlr-ffmpeg-verify-'));
try {
  for (const separateAudio of [true, false]) {
    // 配布する実体で JPEG 出力まで通す。縮小フィルタ・エンコーダの入れ忘れも検出する。
    const image = await extractPreviewImage(
      { data: readFileSync(path.join(fixtures, separateAudio ? 'video.mp4' : 'combined.mp4')) },
      new AbortController().signal,
      ffmpeg,
    );
    assert.equal(image.subarray(0, 2).toString('hex'), 'ffd8');
    assert.equal(image.subarray(-2).toString('hex'), 'ffd9');
    console.log(`Preview OK: ${image.length} bytes`);
    const outputPath = path.join(work, `mux-${separateAudio}.ts`);
    const muxer = new FfmpegMuxer({ ffmpegPath: ffmpeg, outputPath, separateAudio });
    const streams = muxer.start();
    const timer = setTimeout(() => muxer.kill(), 30_000);
    let exit;
    try {
      streams.video.end(
        readFileSync(path.join(fixtures, separateAudio ? 'video.mp4' : 'combined.mp4')),
      );
      streams.audio?.end(readFileSync(path.join(fixtures, 'audio.mp4')));
      exit = await muxer.finish();
    } finally {
      clearTimeout(timer);
      muxer.kill();
    }
    assert.equal(exit.exitCode, 0, '映像・音声の多重化に失敗しました');
    const data = readFileSync(outputPath);
    assert.ok(data.length > 0);
    assert.equal(data.length % 188, 0, 'MPEG-TS パケット長');
    for (let offset = 0; offset < data.length; offset += 188) assert.equal(data[offset], 0x47);
    const result = probe(outputPath);
    assert.deepEqual(result.streams.map((stream) => stream.codec_name).sort(), ['aac', 'h264']);
    for (const codecType of ['video', 'audio']) {
      const input = probe(path.join(fixtures, `${codecType}.mp4`));
      const expected = input.packets.filter((packet) => packet.codec_type === codecType).length;
      const packets = result.packets.filter((packet) => packet.codec_type === codecType);
      assert.ok(expected > 0);
      assert.equal(packets.length, expected, `${codecType} のパケットを取りこぼしています`);
      assert.ok(packets.every((packet) => Number.isFinite(Number(packet.pts))));
    }
    console.log(
      `Mux OK (${separateAudio ? 'separate audio' : 'combined'}): H.264 + AAC, ${data.length} bytes`,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`FFmpeg verified: ${bundle} (LGPL-2.1-or-later, source ${source.sha256})`);
