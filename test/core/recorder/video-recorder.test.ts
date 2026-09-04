import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { recordVideo } from '../../../src/main/core/recorder/video-recorder';
import {
  NicoLiveProgramStatus,
  type NicoLiveProgramInfo,
} from '../../../src/main/vendor/nico-client/types';
import {
  startFakeWatchServer,
  waitFor,
  type FakeWatchServer,
} from '../../helpers/fake-watch-server';

// 再接続を諦めたときの番組情報の確認は外に出さない (常に失敗させる)
vi.mock('../../../src/main/vendor/nico-client/NicoClient', () => ({
  NicoClient: class {
    async getProgramInfo(): Promise<never> {
      throw new Error('offline');
    }
  },
}));

// ---------------------------------------------------------------------------
// 偽の HLS 配信 (暗号化した CMAF もどき) と偽の ffmpeg で、録画の一連の流れを通す
// ---------------------------------------------------------------------------

const KEY = crypto.randomBytes(16);
const IV_HEX = '00000000000000000000000000000001';
const INIT_V = Buffer.from('init-video');
const INIT_A = Buffer.from('init-audio');
const SEG = (name: string): Buffer => Buffer.from(`segment-${name}`);

function encrypt(plain: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, Buffer.from(IV_HEX, 'hex'));
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

interface FakeHls {
  origin: string;
  requests: string[];
  /** 鍵の取得に必要な session cookie の値。stream の cookie がこれと一致しなければ 403 */
  requiredSession: string;
  live: boolean;
  close: () => Promise<void>;
}

async function startFakeHls(): Promise<FakeHls> {
  const state: FakeHls = {
    origin: '',
    requests: [],
    requiredSession: 's1',
    live: false,
    close: async () => undefined,
  };
  const playlist = (track: 'video' | 'audio'): string =>
    [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:1',
      '#EXT-X-MEDIA-SEQUENCE:1',
      `#EXT-X-MAP:URI="/init-${track}"`,
      `#EXT-X-KEY:METHOD=AES-128,URI="/keys/k.key",IV=0x${IV_HEX}`,
      '#EXTINF:1,',
      `/seg/${track}-1`,
      '#EXTINF:1,',
      `/seg/${track}-2`,
      ...(state.live ? [] : ['#EXT-X-ENDLIST']),
      '',
    ].join('\n');
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    state.requests.push(url);
    const cookie = req.headers.cookie ?? '';
    const send = (body: Buffer | string, status = 200): void => {
      res.writeHead(status);
      res.end(body);
    };
    if (url === '/mv.m3u8') {
      send(
        [
          '#EXTM3U',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",DEFAULT=YES,URI="/audio.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360,AUDIO="a"',
          '/video.m3u8',
          '',
        ].join('\n'),
      );
    } else if (url === '/video.m3u8') {
      send(playlist('video'));
    } else if (url === '/audio.m3u8') {
      send(playlist('audio'));
    } else if (url === '/keys/k.key') {
      // 鍵はパス限定の session cookie が正しいときだけ返す (ニコ生と同じ振る舞い)
      if (!cookie.includes(`session=${state.requiredSession}`)) {
        send('forbidden', 403);
      } else {
        send(KEY);
      }
    } else if (url === '/init-video') {
      send(INIT_V);
    } else if (url === '/init-audio') {
      send(INIT_A);
    } else if (url.startsWith('/seg/')) {
      send(encrypt(SEG(url.slice('/seg/'.length))));
    } else {
      send('not found', 404);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}

/** fd3 (映像) と fd4 (音声) を読んでファイルに書くだけの ffmpeg の代わり */
/**
 * 偽の ffmpeg。fd 3 (映像) と fd 4 (音声) を最後の引数のファイルに書き出し、
 * FAKE_FFMPEG_EXIT の終了コードで終わる。Node スクリプトなので Windows でも動く
 */
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

function programInfo(webSocketUrl: string): NicoLiveProgramInfo {
  return {
    nicoliveProgramId: 'lv1',
    title: 't',
    description: '',
    status: NicoLiveProgramStatus.onAir,
    openTime: 0,
    beginTime: 0,
    vposBaseTime: 0,
    endTime: 0,
    scheduledEndTime: 0,
    webSocketUrl,
    hasTimeshift: false,
    supplierIntroduction: '',
    commentCount: 0,
    watchCount: 0,
  };
}

describe('recordVideo', () => {
  let dir: string;
  let hls: FakeHls;
  let watch: FakeWatchServer;
  let ffmpegPath: string;
  let sessionValues: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-video-'));
    ffmpegPath = writeFakeFfmpeg(dir);
    hls = await startFakeHls();
    sessionValues = ['s1'];
    watch = await startFakeWatchServer({
      streamData: (index) => ({
        protocol: 'hls',
        uri: `${hls.origin}/mv.m3u8`,
        quality: 'abr',
        availableQualities: ['abr'],
        cookies: [
          {
            name: 'session',
            value: sessionValues[index] ?? 's1',
            domain: '127.0.0.1',
            path: '/keys',
          },
          { name: 'CloudFront-Policy', value: 'p', domain: '127.0.0.1', path: '/' },
        ],
      }),
    });
  });

  afterEach(async () => {
    await watch.close();
    await hls.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env['FAKE_FFMPEG_EXIT'];
  });

  test('映像と音声を復号して ffmpeg に流し、ENDLIST で完了する', async () => {
    const outputPath = path.join(dir, 'out.ts');
    const result = await recordVideo({
      programId: 'lv1',
      outputPath,
      ffmpegPath,
      programInfo: programInfo(watch.url),
    });

    expect(result.reason).toBe('endlist');
    expect(result.video.segments).toBe(2);
    expect(result.audio?.segments).toBe(2);
    expect(result.ffmpegExitCode).toBe(0);
    expect(fs.readFileSync(outputPath)).toEqual(
      Buffer.concat([INIT_V, SEG('video-1'), SEG('video-2')]),
    );
    expect(fs.readFileSync(`${outputPath}.audio`)).toEqual(
      Buffer.concat([INIT_A, SEG('audio-1'), SEG('audio-2')]),
    );
    // 鍵はトラックごとに 1 回だけ取りに行く (映像・音声で 2 回)
    expect(hls.requests.filter((u) => u === '/keys/k.key')).toHaveLength(2);
  });

  test('鍵の取得が 403 なら視聴セッションを張り直し、新しい cookie で続行する', async () => {
    hls.requiredSession = 's2';
    sessionValues = ['s1', 's2'];
    const outputPath = path.join(dir, 'out.ts');
    const result = await recordVideo({
      programId: 'lv1',
      outputPath,
      ffmpegPath,
      programInfo: programInfo(watch.url),
    });

    expect(result.reason).toBe('endlist');
    expect(watch.connections).toHaveLength(2);
    expect(fs.readFileSync(outputPath)).toEqual(
      Buffer.concat([INIT_V, SEG('video-1'), SEG('video-2')]),
    );
  });

  test('ffmpeg が 0 以外で終わったら失敗として扱う', async () => {
    process.env['FAKE_FFMPEG_EXIT'] = '3';
    await expect(
      recordVideo({
        programId: 'lv1',
        outputPath: path.join(dir, 'out.ts'),
        ffmpegPath,
        programInfo: programInfo(watch.url),
      }),
    ).rejects.toThrow(/ffmpeg exited with code 3/);
  });

  test('ライブ中に abort すると aborted で終わり、ffmpeg は正常終了する', async () => {
    hls.live = true;
    const controller = new AbortController();
    const outputPath = path.join(dir, 'out.ts');
    const promise = recordVideo(
      { programId: 'lv1', outputPath, ffmpegPath, programInfo: programInfo(watch.url) },
      controller.signal,
    );
    // 最初のセグメントが流れてから止める
    await new Promise((resolve) => setTimeout(resolve, 600));
    controller.abort();
    const result = await promise;

    expect(result.reason).toBe('aborted');
    expect(result.ffmpegExitCode).toBe(0);
    expect(result.video.segments).toBe(2);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  test('視聴 WebSocket の再接続は 1 つだけ動かし、上限に達したら増やさない', async () => {
    // 最初の接続だけ通し、再接続はすべて即座に切る
    const streamData = (index: number): Record<string, unknown> => ({
      protocol: 'hls',
      uri: `${hls.origin}/mv.m3u8`,
      quality: 'abr',
      availableQualities: ['abr'],
      cookies: [
        {
          name: 'session',
          value: sessionValues[index] ?? 's1',
          domain: '127.0.0.1',
          path: '/keys',
        },
      ],
    });
    await watch.close();
    watch = await startFakeWatchServer({ streamData, dropConnection: (index) => index > 0 });
    hls.live = true;
    const controller = new AbortController();
    const warn = vi.fn();
    const promise = recordVideo(
      {
        programId: 'lv1',
        outputPath: path.join(dir, 'out.ts'),
        ffmpegPath,
        programInfo: programInfo(watch.url),
        reconnectBaseDelayMs: 10,
        logger: { debug() {}, info() {}, warn, error() {} },
      },
      controller.signal,
    );
    try {
      // 録画が始まってからサーバー側で切る
      await waitFor(() => watch.connections[0]?.received.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      watch.connections[0].socket.terminate();

      // 5 回試して諦める。切られた再接続が別のループを起こしていれば接続数が 6 を超える
      await waitFor(() =>
        warn.mock.calls.some((args) => String(args[0]).includes('reconnect 5/5 failed')),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(watch.connections).toHaveLength(6);
    } finally {
      controller.abort();
      await promise;
    }
  });

  test('番組が終了済みなら開始しない', async () => {
    await expect(
      recordVideo({
        programId: 'lv1',
        outputPath: path.join(dir, 'out.ts'),
        ffmpegPath,
        programInfo: { ...programInfo(watch.url), status: NicoLiveProgramStatus.ended },
      }),
    ).rejects.toThrow(/終了済み/);
  });
});
