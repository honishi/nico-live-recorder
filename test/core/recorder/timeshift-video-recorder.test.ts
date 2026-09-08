import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordTimeshiftVideo } from '../../../src/main/core/recorder/timeshift-video-recorder';
import type { TimeshiftVideoReport } from '../../../src/main/core/recorder/timeshift-video-recorder';
import type { TimeshiftProgress } from '../../../src/shared/types';

function writeFakeFfmpeg(dir: string): string {
  const script = path.join(dir, 'fake-ffmpeg.cjs');
  fs.writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "const net = require('node:net');",
      'const out = process.argv[process.argv.length - 1];',
      'const copy = (fd, file) =>',
      '  new Promise((resolve) => {',
      '    let input;',
      '    try {',
      '      input = new net.Socket({ fd, readable: true, writable: false });',
      '    } catch {',
      '      resolve(); // その fd が渡されていない (音声なし) ときは何もしない',
      '      return;',
      '    }',
      '    const output = fs.createWriteStream(file);',
      '    input.pipe(output);',
      "    output.on('close', resolve);",
      "    input.on('error', () => output.end());",
      '  });',
      "Promise.all([copy(3, out), copy(4, out + '.audio')]).then(() => {",
      '  process.exit(Number(process.env.FAKE_FFMPEG_EXIT || 0));',
      '});',
      '',
    ].join('\n'),
  );
  return script;
}

let dir: string;
let binary: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-ts-video-'));
  binary = writeFakeFfmpeg(dir);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
const origin = 'https://example.test';
const stream = {
  uri: origin + '/master',
  quality: '',
  availableQualities: [],
  receivedAt: new Date(),
  cookies: [{ name: 'session', value: 'cookie', path: '/', domain: 'example.test' }],
};
function media(options: { missing?: boolean; forbidden?: boolean; live?: boolean } = {}) {
  const key = Buffer.alloc(16, 9);
  const routes: Record<string, string | Buffer | number> = {
    '/master':
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",DEFAULT=YES,URI="/audio"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"\n/video\n',
    '/key': key,
  };
  for (const track of ['video', 'audio']) {
    routes['/' + track] =
      `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:1,\n/blank/1\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="/init-${track}"\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:6,\n/${track}-11\n#EXTINF:6,\n/${track}-12\n${options.live ? '' : '#EXT-X-ENDLIST'}\n`;
    routes['/init-' + track] = 'init-' + track;
    for (const seq of [11, 12]) {
      const iv = Buffer.alloc(16);
      iv.writeBigUInt64BE(BigInt(seq), 8);
      const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
      routes[`/${track}-${seq}`] = Buffer.concat([
        cipher.update(`${track}-${seq}`),
        cipher.final(),
      ]);
    }
  }
  if (options.missing) routes['/audio-12'] = 404;
  if (options.forbidden) routes['/key'] = 403;
  const mocked = vi.fn((url: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>).cookie).toBe('session=cookie');
    const body = routes[new URL(url).pathname];
    if (body === undefined) throw new Error('unexpected request');
    return Promise.resolve(
      typeof body === 'number' ? new Response(null, { status: body }) : new Response(body),
    );
  });
  vi.stubGlobal('fetch', mocked);
  return mocked;
}

test('2トラックを並列取得・復号し、両方の保存数・FFmpeg・ファイルの成功を確認する', async () => {
  media();
  const outputPath = path.join(dir, 'video.ts');
  const progress: Partial<TimeshiftProgress>[] = [];
  let report: TimeshiftVideoReport | undefined;
  const result = await recordTimeshiftVideo(
    stream,
    {
      outputPath,
      ffmpegPath: binary,
      onProgress: (value) => progress.push(value),
      onReport: (value) => {
        report = value;
      },
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    reason: 'endlist',
    video: { segments: 2, firstSeq: 11, lastSeq: 12 },
    audio: { segments: 2 },
    ffmpegExitCode: 0,
  });
  expect(fs.readFileSync(outputPath, 'utf8')).toBe('init-videovideo-11video-12');
  expect(fs.readFileSync(outputPath + '.audio', 'utf8')).toBe('init-audioaudio-11audio-12');
  expect(progress).toContainEqual({ phase: 'downloading', totalSegments: 4, savedSegments: 0 });
  expect(progress).toContainEqual({ savedSegments: 4 });
  expect(report?.tracks).toEqual([
    { expected: 2, saved: 2, missing: 0, httpErrors: [] },
    { expected: 2, saved: 2, missing: 0, httpErrors: [] },
  ]);
});

test.each(['missing', 'forbidden', 'live', 'ffmpeg', 'early-exit'] as const)(
  '%s を取得完了にせずFFmpegも終了させる',
  async (failure) => {
    media({
      missing: failure === 'missing',
      forbidden: failure === 'forbidden',
      live: failure === 'live',
    });
    if (failure === 'ffmpeg') vi.stubEnv('FAKE_FFMPEG_EXIT', '1');
    if (failure === 'early-exit') fs.writeFileSync(binary, 'process.exit(0)');
    let report: TimeshiftVideoReport | undefined;
    await expect(
      recordTimeshiftVideo(
        stream,
        {
          outputPath: path.join(dir, 'video.ts'),
          ffmpegPath: binary,
          onReport: (value) => {
            report = value;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    if (failure === 'missing') expect(report?.tracks[1].missing).toBe(1);
  },
);
