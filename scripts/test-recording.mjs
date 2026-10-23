import { spawnSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 通常テストと同じシナリオを同梱FFmpegで実行する。未ビルドなら省略せず失敗する。
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = path.join(root, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`);
const suffix = process.platform === 'win32' ? '.exe' : '';
const ffmpeg = path.join(bundle, `ffmpeg${suffix}`);
const ffprobe = path.join(bundle, `ffprobe${suffix}`);
accessSync(ffmpeg);
accessSync(ffprobe);
const result = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    'test/core/recorder/program-recorder-integration.test.ts',
    '--testTimeout=30000',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NLR_TEST_FFMPEG: ffmpeg, NLR_TEST_FFPROBE: ffprobe },
    timeout: 120_000,
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
