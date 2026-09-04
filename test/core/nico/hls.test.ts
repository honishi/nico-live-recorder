import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  cookieHeaderFor,
  HlsTrackDownloader,
  parseAttributes,
  parseMediaPlaylist,
  parseMultivariantPlaylist,
  selectBestVariant,
} from '../../../src/main/core/nico/hls';
import type { StreamCookie } from '../../../src/main/core/nico/watch-session';

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

  const makeFetch = (deny: Set<string>) => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (deny.has(url)) {
        deny.delete(url);
        return new Response('forbidden', { status: 403 });
      }
      const body = responses[url];
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

  test('playlist の取り直しは取得開始から target duration (変化なしなら半分) 以上あける', async () => {
    vi.useFakeTimers();
    try {
      const live = (segments: number[], end = false): string =>
        `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:${segments[0]}\n` +
        segments.map((seq) => `#EXTINF:3,\nhttps://cdn.test/plain/${seq}.cmfv\n`).join('') +
        (end ? '#EXT-X-ENDLIST\n' : '');
      // 1 回目は新着あり、2 回目は変化なし、3 回目で終了
      const playlists = [live([10]), live([10]), live([10, 11], true)];
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
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await run;

      expect(result.reason).toBe('endlist');
      const start = fetchedAt[0];
      expect(fetchedAt.map((t) => t - start)).toEqual([0, 3000, 4500]);
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
