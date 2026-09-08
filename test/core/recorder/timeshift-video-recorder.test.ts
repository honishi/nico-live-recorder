import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordTimeshiftVideo } from '../../../src/main/core/recorder/timeshift-video-recorder';
import type { TimeshiftVideoReport } from '../../../src/main/core/recorder/timeshift-video-recorder';
import type { TimeshiftProgress } from '../../../src/shared/types';
import { fragment, fragmentInit } from '../../helpers/fmp4';

// バックオフの時間はHTTP層の仮想タイマーテストで検証し、ここでは結線を確認する。
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));

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

test.each([false, true])(
  '映像だけが本編途中の境界でも復号後に時刻を検査する（巻き戻り=%s）',
  async (reset) => {
    const key = Buffer.alloc(16, 9);
    const init = fragmentInit();
    const first = fragment(0n);
    const second = fragment(reset ? 0n : 6n);
    const audio = fragment(6n);
    const routes: Record<string, string | Buffer> = {
      '/master':
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",DEFAULT=YES,URI="/audio"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"\n/video\n',
      '/key': key,
      '/init': init,
    };
    // 映像は0秒から本編、音声だけ冒頭6秒がblankの実例を再現する。
    for (const track of ['video', 'audio']) {
      routes['/' + track] =
        `#EXTM3U\n#EXT-X-MAP:URI="/init"\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:6,\n${track === 'video' ? '/first' : '/blank/0'}\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\n/${track}-1\n#EXT-X-ENDLIST\n`;
    }
    for (const [url, data, seq] of [
      ['/first', first, 0],
      ['/video-1', second, 1],
      ['/audio-1', audio, 1],
    ] as const) {
      const iv = Buffer.alloc(16);
      iv.writeBigUInt64BE(BigInt(seq), 8);
      const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
      routes[url] = Buffer.concat([cipher.update(data), cipher.final()]);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = routes[new URL(url).pathname];
        if (body === undefined) throw new Error('unexpected request');
        return new Response(body);
      }),
    );
    const outputPath = path.join(dir, 'video.ts');
    let report: TimeshiftVideoReport | undefined;
    const recording = recordTimeshiftVideo(
      stream,
      {
        outputPath,
        ffmpegPath: binary,
        onReport: (value) => {
          report = value;
        },
      },
      new AbortController().signal,
    );
    if (reset) {
      await expect(recording).rejects.toThrow('DISCONTINUITY_TIMESTAMP_CHANGED');
    } else {
      await expect(recording).resolves.toMatchObject({
        video: { segments: 2 },
        audio: { segments: 1 },
        reason: 'endlist',
      });
      expect(fs.readFileSync(outputPath)).toEqual(Buffer.concat([init, first, second]));
      expect(fs.readFileSync(outputPath + '.audio')).toEqual(Buffer.concat([init, audio]));
    }
    expect(report?.playlists).toMatchObject([
      { label: 'video', diagnostic: { blankSegments: 0, continuityCheckCount: 1 } },
      { label: 'audio', diagnostic: { blankSegments: 1, continuityCheckCount: 0 } },
    ]);
  },
);

test('一方に欠落があっても両方の保存を閉じてから一部失敗にする', async () => {
  media({ missing: true });
  const outputPath = path.join(dir, 'partial.ts');
  let report: TimeshiftVideoReport | undefined;
  await expect(
    recordTimeshiftVideo(
      stream,
      {
        outputPath,
        ffmpegPath: binary,
        onReport: (value) => {
          report = value;
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('SEGMENTS_INCOMPLETE');
  expect(report?.ffmpegExitCode).toBe(0);
  expect(report?.tracks.map((track) => track.saved)).toEqual([2, 1]);
  expect(fs.readFileSync(outputPath, 'utf8')).toBe('init-videovideo-11video-12');
  expect(fs.readFileSync(outputPath + '.audio', 'utf8')).toBe('init-audioaudio-11');
});

test('手動停止でも渡したデータを排出しFFmpegを自然終了させる', async () => {
  media();
  const stop = new AbortController();
  const outputPath = path.join(dir, 'stopped.ts');
  let report: TimeshiftVideoReport | undefined;
  await expect(
    recordTimeshiftVideo(
      stream,
      {
        outputPath,
        ffmpegPath: binary,
        onProgress: (value) => {
          if ((value.savedSegments ?? 0) >= 1) stop.abort();
        },
        onReport: (value) => {
          report = value;
        },
      },
      stop.signal,
    ),
  ).rejects.toThrow();
  expect(report?.ffmpegExitCode).toBe(0);
  const saved =
    fs.readFileSync(outputPath, 'utf8') + fs.readFileSync(outputPath + '.audio', 'utf8');
  expect(saved).toMatch(/(?:video|audio)-11/);
});

test.each(['/master', '/video', '/audio'])(
  'プレイリスト%sの一時失敗を再試行して保存する',
  async (target) => {
    const mocked = media();
    const respond = mocked.getMockImplementation()!;
    let calls = 0;
    mocked.mockImplementation((url, init) => {
      if (new URL(url).pathname === target && calls++ === 0)
        return Promise.resolve(new Response(null, { status: 503 }));
      return respond(url, init);
    });
    const result = await recordTimeshiftVideo(
      stream,
      { outputPath: path.join(dir, 'retried.ts'), ffmpegPath: binary },
      new AbortController().signal,
    );
    expect(result.reason).toBe('endlist');
    expect(calls).toBe(2);
  },
);
