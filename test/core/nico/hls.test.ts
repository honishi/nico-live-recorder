import crypto from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import {
  cookieHeaderFor,
  HlsTrackDownloader,
  parseAttributes,
  parseMediaPlaylist,
  parseMultivariantPlaylist,
  selectBestVariant,
} from '../../../src/main/core/nico/hls';
import type { StreamCookie } from '../../../src/main/core/nico/watch-protocol';
import { silentLogger } from '../../../src/main/core/logger';

const BASE = 'https://example.test/hls/playlists/abc/def/multivariant/variant.m3u8';

// 実際のニコ生の multivariant playlist を短くしたもの
const MULTIVARIANT = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main-audio",NAME="Main Audio",DEFAULT=YES,URI="../media/main-audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=508800,CODECS="avc1.4D4015,mp4a.40.2",RESOLUTION=512x288,AUDIO="main-audio"
../media/main-video-480Kbps.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1630800,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=854x480,AUDIO="main-audio"
../media/main-video-1_5Mbps.m3u8
`;

// 実際の media playlist の構造 (LL-HLS の EXT-X-PART を含む)
const MEDIA = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:3
#EXT-X-MEDIA-SEQUENCE:41
#EXT-X-PART-INF:PART-TARGET=0.54000
#EXT-X-KEY:METHOD=NONE
#EXT-X-MAP:URI="https://cdn.test/hls/segments/abc/video/init.cmfv"
#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.test/hls/keys/abc/key1.key",IV=0x0000000000000000000000000000002A
#EXT-X-PROGRAM-DATE-TIME:2026-09-02T16:27:24.000Z
#EXTINF:3.00000,
https://cdn.test/hls/segments/abc/video/41.cmfv
#EXTINF:3.00000,
https://cdn.test/hls/segments/abc/video/42.cmfv
#EXT-X-PART:DURATION=0.54,URI="https://cdn.test/hls/segments/abc/video/43.0.cmfv"
#EXT-X-PART:DURATION=0.54,URI="https://cdn.test/hls/segments/abc/video/43.1.cmfv",INDEPENDENT=YES
`;

describe('parseAttributes', () => {
  test('引用符付きの値にカンマが含まれていても分割しない', () => {
    const attrs = parseAttributes('TYPE=AUDIO,NAME="Main, Audio",DEFAULT=YES,URI="a.m3u8"');
    expect(attrs).toEqual({ TYPE: 'AUDIO', NAME: 'Main, Audio', DEFAULT: 'YES', URI: 'a.m3u8' });
  });
});

describe('parseMediaPlaylist', () => {
  test('完成したセグメントだけを連番付きで取り出し、EXT-X-PART は無視する', () => {
    const playlist = parseMediaPlaylist(MEDIA, BASE);
    expect(playlist.targetDuration).toBe(3);
    expect(playlist.mediaSequence).toBe(41);
    expect(playlist.endList).toBe(false);
    expect(playlist.segments.map((s) => s.seq)).toEqual([41, 42]);
    expect(playlist.segments[0].uri).toBe('https://cdn.test/hls/segments/abc/video/41.cmfv');
    expect(playlist.segments[0].programDateTime).toBe('2026-09-02T16:27:24.000Z');
    expect(playlist.segments[1].programDateTime).toBeUndefined();
  });

  test('EXT-X-MAP と最後に宣言された EXT-X-KEY が各セグメントに紐づく', () => {
    const [first] = parseMediaPlaylist(MEDIA, BASE).segments;
    expect(first.mapUri).toBe('https://cdn.test/hls/segments/abc/video/init.cmfv');
    expect(first.key).toEqual({
      method: 'AES-128',
      uri: 'https://cdn.test/hls/keys/abc/key1.key',
      iv: '0000000000000000000000000000002A',
    });
  });

  test('相対 URI は playlist の URL を基準に解決し、ENDLIST を検出する', () => {
    const playlist = parseMediaPlaylist(
      '#EXTM3U\n#EXTINF:2,\nseg1.ts\n#EXTINF:2,\n../seg2.ts\n#EXT-X-ENDLIST\n',
      'https://cdn.test/a/b/media.m3u8',
    );
    expect(playlist.segments.map((s) => s.uri)).toEqual([
      'https://cdn.test/a/b/seg1.ts',
      'https://cdn.test/a/seg2.ts',
    ]);
    expect(playlist.endList).toBe(true);
  });
});

describe('parseMultivariantPlaylist / selectBestVariant', () => {
  test('variant と音声 rendition を解析し、帯域最大の variant とその音声を選ぶ', () => {
    const parsed = parseMultivariantPlaylist(MULTIVARIANT, BASE);
    expect(parsed.variants).toHaveLength(2);
    expect(parsed.media[0]).toMatchObject({
      type: 'AUDIO',
      groupId: 'main-audio',
      isDefault: true,
    });

    const selected = selectBestVariant(parsed);
    expect(selected.video.resolution).toBe('854x480');
    expect(selected.video.uri).toBe(
      'https://example.test/hls/playlists/abc/def/media/main-video-1_5Mbps.m3u8',
    );
    expect(selected.audioUri).toBe(
      'https://example.test/hls/playlists/abc/def/media/main-audio.m3u8',
    );
  });

  test('音声グループが無い variant では audioUri を返さない', () => {
    const selected = selectBestVariant({
      variants: [{ uri: 'https://cdn.test/v.m3u8', bandwidth: 1000 }],
      media: [],
    });
    expect(selected.audioUri).toBeUndefined();
  });

  test('variant が無ければ例外', () => {
    expect(() => selectBestVariant({ variants: [], media: [] })).toThrow();
  });
});

describe('cookieHeaderFor', () => {
  const cookies: StreamCookie[] = [
    { name: 'session', value: 's', domain: 'nicovideo.jp', path: '/hls/keys/abc' },
    {
      name: 'CloudFront-Policy',
      value: 'p-playlists',
      domain: 'nicovideo.jp',
      path: '/hls/playlists/abc',
    },
    {
      name: 'CloudFront-Policy',
      value: 'p-video',
      domain: 'nicovideo.jp',
      path: '/hls/segments/abc/video',
    },
    { name: 'CloudFront-Policy', value: 'p-keys', domain: 'nicovideo.jp', path: '/hls/keys/abc' },
  ];

  test('リクエスト先のパスに一致する cookie だけを送る', () => {
    expect(cookieHeaderFor(cookies, 'https://cdn.test/hls/playlists/abc/media/v.m3u8')).toBe(
      'CloudFront-Policy=p-playlists',
    );
    expect(cookieHeaderFor(cookies, 'https://cdn.test/hls/segments/abc/video/1.cmfv')).toBe(
      'CloudFront-Policy=p-video',
    );
    expect(cookieHeaderFor(cookies, 'https://cdn.test/hls/keys/abc/k.key')).toBe(
      'session=s; CloudFront-Policy=p-keys',
    );
    expect(cookieHeaderFor(cookies, 'https://cdn.test/other')).toBe('');
  });
});

describe('HlsTrackDownloader', () => {
  const KEY = crypto.randomBytes(16);
  const IV_HEX = '000000000000000000000000000000ff';
  const INIT = Buffer.from('init-segment');
  const SEG1 = Buffer.from('segment-one-plain');
  const SEG2 = Buffer.from('segment-two-plain');

  const encrypt = (plain: Buffer): Buffer => {
    const cipher = crypto.createCipheriv('aes-128-cbc', KEY, Buffer.from(IV_HEX, 'hex'));
    return Buffer.concat([cipher.update(plain), cipher.final()]);
  };

  const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:3
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI="https://cdn.test/init.cmfv"
#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.test/keys/k.key",IV=0x${IV_HEX}
#EXTINF:3,
https://cdn.test/seg/10.cmfv
#EXTINF:3,
https://cdn.test/seg/11.cmfv
#EXT-X-ENDLIST
`;

  const responses: Record<string, Buffer | string> = {
    'https://cdn.test/media.m3u8': playlist,
    'https://cdn.test/init.cmfv': INIT,
    'https://cdn.test/keys/k.key': KEY,
    'https://cdn.test/seg/10.cmfv': encrypt(SEG1),
    'https://cdn.test/seg/11.cmfv': encrypt(SEG2),
  };

  const makeFetch = (deny: Set<string>, overrides: Record<string, Buffer | string> = {}) => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (deny.has(url)) {
        deny.delete(url);
        return new Response('forbidden', { status: 403 });
      }
      const body = overrides[url] ?? responses[url];
      return body === undefined
        ? new Response('not found', { status: 404 })
        : new Response(body, { status: 200 });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
  };

  const collect = () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    return { sink, output: () => Buffer.concat(chunks) };
  };

  test('init セグメントと復号したセグメントを順に流し、ENDLIST で終わる', async () => {
    const { fetchImpl, calls } = makeFetch(new Set());
    const { sink, output } = collect();
    const downloader = new HlsTrackDownloader({
      label: 'video',
      playlistUrl: 'https://cdn.test/media.m3u8',
      cookies: () => [],
      fetchImpl,
    });

    const result = await downloader.run(sink);

    expect(result).toMatchObject({ reason: 'endlist', segments: 2, firstSeq: 10, lastSeq: 11 });
    expect(output()).toEqual(Buffer.concat([INIT, SEG1, SEG2]));
    // 鍵は 1 回だけ取得する
    expect(calls.filter((u) => u.endsWith('.key'))).toHaveLength(1);
  });

  test('プレビューへ復号済み映像と初期化情報を渡し、失敗しても録画と取得回数を維持する', async () => {
    const { fetchImpl, calls } = makeFetch(new Set());
    const { sink, output } = collect();
    const onVideoSample = vi.fn(() => {
      throw new Error('preview failed');
    });
    const downloader = new HlsTrackDownloader({
      label: 'video',
      playlistUrl: 'https://cdn.test/media.m3u8',
      cookies: () => [],
      fetchImpl,
      onVideoSample,
    });
    expect((await downloader.run(sink)).segments).toBe(2);
    expect(onVideoSample).toHaveBeenNthCalledWith(1, { data: SEG1, init: INIT });
    expect(onVideoSample).toHaveBeenNthCalledWith(2, { data: SEG2, init: INIT });
    expect(output()).toEqual(Buffer.concat([INIT, SEG1, SEG2]));
    expect(calls.filter((url) => url.endsWith('init.cmfv'))).toHaveLength(1);
  });

  test.each([true, false])(
    '初期化情報の上限ログはプレビュー観測先がある場合だけ1回出す（%s）',
    async (observe) => {
      const debug = vi.fn();
      const oversized = Buffer.alloc(1024 * 1024 + 1);
      const changedInitPlaylist = playlist.replace(
        '#EXTINF:3,\nhttps://cdn.test/seg/11.cmfv',
        '#EXT-X-MAP:URI="https://cdn.test/init2.cmfv"\n#EXTINF:3,\nhttps://cdn.test/seg/11.cmfv',
      );
      const { fetchImpl } = makeFetch(new Set(), {
        'https://cdn.test/media.m3u8': changedInitPlaylist,
        'https://cdn.test/init.cmfv': oversized,
        'https://cdn.test/init2.cmfv': oversized,
      });
      const { sink, output } = collect();
      const downloader = new HlsTrackDownloader({
        label: 'video',
        playlistUrl: 'https://cdn.test/media.m3u8',
        cookies: () => [],
        fetchImpl,
        onVideoSample: observe ? vi.fn() : undefined,
        logger: { ...silentLogger, debug },
      });
      expect((await downloader.run(sink)).segments).toBe(2);
      expect(output()).toEqual(Buffer.concat([oversized, SEG1, oversized, SEG2]));
      const diagnostic =
        'video: preview skipped: initialization size 1048577 exceeds 1048576 bytes';
      expect(debug.mock.calls.filter(([message]) => message === diagnostic)).toHaveLength(
        observe ? 1 : 0,
      );
    },
  );

  test.each([1024 * 1024, 1024 * 1024 + 1])(
    '初期化情報が %i bytes のとき上限内だけプレビューへ渡し、録画は全量保存する',
    async (size) => {
      const init = Buffer.alloc(size);
      const { fetchImpl } = makeFetch(new Set(), { 'https://cdn.test/init.cmfv': init });
      const { sink, output } = collect();
      const onVideoSample = vi.fn();
      const downloader = new HlsTrackDownloader({
        label: 'video',
        playlistUrl: 'https://cdn.test/media.m3u8',
        cookies: () => [],
        fetchImpl,
        onVideoSample,
      });

      // 上限超過で表示用の通知を省いても、録画用データや完了結果は変えない。
      expect(await downloader.run(sink)).toMatchObject({ reason: 'endlist', segments: 2 });
      expect(output()).toEqual(Buffer.concat([init, SEG1, SEG2]));
      if (size === 1024 * 1024) {
        expect(onVideoSample).toHaveBeenCalledTimes(2);
        expect(onVideoSample).toHaveBeenNthCalledWith(1, { data: SEG1, init });
        expect(onVideoSample).toHaveBeenNthCalledWith(2, { data: SEG2, init });
      } else {
        expect(onVideoSample).not.toHaveBeenCalled();
      }
    },
  );

  test('ffmpeg への書き込みが詰まっていても abort で終了する', async () => {
    const { fetchImpl, calls } = makeFetch(new Set());
    let onWrite: () => void = () => {};
    const writing = new Promise<void>((resolve) => {
      onWrite = resolve;
    });
    let completeWrite: (() => void) | undefined;
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        // 書き込み完了を保留し、実時間の待機なしで backpressure を再現する
        completeWrite = () => callback();
        onWrite();
      },
    });
    const controller = new AbortController();
    const downloader = new HlsTrackDownloader({
      label: 'video',
      playlistUrl: 'https://cdn.test/media.m3u8',
      cookies: () => [],
      fetchImpl,
    });
    const task = downloader.run(sink, controller.signal);
    try {
      await writing;
      controller.abort();
      expect(await task).toMatchObject({ reason: 'aborted', segments: 0 });
      expect(calls).toEqual(['https://cdn.test/media.m3u8', 'https://cdn.test/init.cmfv']);
      expect(sink.listenerCount('drain')).toBe(0);
      expect(sink.listenerCount('error')).toBe(0);
    } finally {
      completeWrite?.();
      sink.destroy();
    }
  });

  test('403 のときは onForbidden で認証情報を更新してから再試行する', async () => {
    const { fetchImpl } = makeFetch(new Set(['https://cdn.test/keys/k.key']));
    const { sink, output } = collect();
    const onForbidden = vi.fn(async () => undefined);
    const downloader = new HlsTrackDownloader({
      label: 'video',
      playlistUrl: 'https://cdn.test/media.m3u8',
      cookies: () => [],
      fetchImpl,
      onForbidden,
    });

    const result = await downloader.run(sink);

    expect(onForbidden).toHaveBeenCalledTimes(1);
    expect(result.segments).toBe(2);
    expect(output()).toEqual(Buffer.concat([INIT, SEG1, SEG2]));
  });

  test.each(['media.m3u8', 'seg/10.cmfv', 'keys/k.key'])(
    '%s の 403 で URL が変わったら新しい playlist から取り直す',
    async (denied) => {
      const calls: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push(url);
        if (url === `https://cdn.test/${denied}`) {
          return new Response('expired', { status: 403 });
        }
        let body = responses[url.replace('new.test', 'cdn.test')];
        if (url === 'https://new.test/media.m3u8') {
          // init は共通のまま、セグメントと鍵の配信先だけが変わる
          body = playlist
            .replaceAll('cdn.test/seg/', 'new.test/seg/')
            .replaceAll('cdn.test/keys/', 'new.test/keys/');
        }
        return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
      };
      const { sink, output } = collect();
      const downloader: HlsTrackDownloader = new HlsTrackDownloader({
        label: 'video',
        playlistUrl: 'https://cdn.test/media.m3u8',
        cookies: () => [],
        fetchImpl,
        onForbidden: async (): Promise<void> =>
          downloader.updateSource('https://new.test/media.m3u8'),
      });
      const result = await downloader.run(sink);
      expect(result).toMatchObject({ reason: 'endlist', segments: 2 });
      expect(calls.filter((url) => url === `https://cdn.test/${denied}`)).toHaveLength(1);
      expect(calls).toContain('https://new.test/media.m3u8');
      expect(output()).toEqual(Buffer.concat([INIT, SEG1, SEG2]));
    },
  );

  test('playlist の取り直しは取得開始から target duration (変化なしなら半分) 以上あける', async () => {
    vi.useFakeTimers();
    try {
      const live = (segments: number[], end = false): string =>
        `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:${segments[0]}\n` +
        segments.map((seq) => `#EXTINF:3,\nhttps://cdn.test/plain/${seq}.cmfv\n`).join('') +
        (end ? '#EXT-X-ENDLIST\n' : '');
      // 1 回目は初回、2 回目は古いセグメントが消えただけ (新着なしでも本文は変化)、3 回目は変化なし、
      // 4 回目は URL が変わっただけ (本文は同じ)、5 回目で終了
      const playlists = [live([9, 10]), live([10]), live([10]), live([10]), live([10, 11], true)];
      const fetchedAt: number[] = [];
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('.m3u8')) {
          fetchedAt.push(Date.now());
          return new Response(playlists.shift() ?? live([10, 11], true), { status: 200 });
        }
        return new Response(Buffer.from('seg'), { status: 200 });
      }) as unknown as typeof fetch;
      const { sink } = collect();
      const downloader = new HlsTrackDownloader({
        label: 'video',
        playlistUrl: 'https://cdn.test/media.m3u8',
        cookies: () => [],
        fetchImpl,
      });

      const run = downloader.run(sink);
      await vi.advanceTimersByTimeAsync(7_000);
      downloader.updateSource('https://cdn.test/media2.m3u8');
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await run;

      expect(result.reason).toBe('endlist');
      const start = fetchedAt[0];
      expect(fetchedAt.map((t) => t - start)).toEqual([0, 3000, 6000, 7500, 10500]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('abort されたら aborted で終わる', async () => {
    const { fetchImpl } = makeFetch(new Set());
    const { sink } = collect();
    const controller = new AbortController();
    controller.abort();
    const downloader = new HlsTrackDownloader({
      label: 'video',
      playlistUrl: 'https://cdn.test/media.m3u8',
      cookies: () => [],
      fetchImpl,
    });

    const result = await downloader.run(sink, controller.signal);

    expect(result.reason).toBe('aborted');
    expect(result.segments).toBe(0);
  });
});
