import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  parseOptions,
  parsePage,
  errorSummary,
  ProbeError,
} from '../../scripts/timeshift-probe/common';
import { clipPlaylist, sampleVideo } from '../../scripts/timeshift-probe/video';
import { buildProbeViewUrl, sampleComments } from '../../scripts/timeshift-probe/comments';
import { getProtoRegistry } from '../../src/main/vendor/nico-client/internal/protoLoader';
import { HlsForbiddenError } from '../../src/main/core/nico/hls';
import { observeSession } from '../../scripts/timeshift-probe/session';
import { startFakeWatchServer } from '../helpers/fake-watch-server';
import { once } from 'node:events';

// ネットワークと ffmpeg は置換し、playlist・復号以降の取得判定と NDGR の巡回を実物で通す。
vi.mock('../../src/main/core/nico/ffmpeg', () => ({
  FfmpegMuxer: class {
    start() {
      return {
        video: new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      };
    }
    wait() {
      return Promise.resolve({ exitCode: 0 });
    }
    finish() {
      return this.wait();
    }
    kill() {}
  },
}));

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nlr-probe-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

function mockFetch(routes: Record<string, string | Uint8Array | number>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const value = routes[input];
      if (value === undefined) throw new Error('unexpected request');
      return Promise.resolve(
        typeof value === 'number'
          ? new Response(null, { status: value })
          : new Response(typeof value === 'string' ? value : Buffer.from(value)),
      );
    }),
  );
}

test('匿名指定は残っているセッションを無視し、無指定や不正な上限は拒否する', () => {
  expect(
    parseOptions(['lv1', '--anonymous'], { NICO_USER_SESSION: 'secret' })?.session,
  ).toBeUndefined();
  expect(() => parseOptions(['lv1'], {})).toThrow('NICO_USER_SESSION');
  expect(() => parseOptions(['lv1', '--anonymous', '--media-seconds', 'NaN'], {})).toThrow();
  expect(() => parseOptions(['lv1', '--anonymous', '--timeout', '0'], {})).toThrow();
  expect(
    parseOptions(['https://live.nicovideo.jp/watch/lv1?ref=test'], { NICO_USER_SESSION: 'secret' })
      ?.programId,
  ).toBe('lv1');
});

test('公開状態と認証状態を分け、ページのトークンや例外本文をレポートへ出さない', () => {
  const data = {
    program: { status: 'ENDED', title: 'secret-title' },
    programTimeshift: { publication: { status: 'Open' } },
    site: { frontendId: 9, relive: { webSocketUrl: 'wss://example.test/timeshift?token=secret' } },
  };
  const page = parsePage(
    `<script id="embedded-data" data-props='${JSON.stringify(data)}'></script>`,
  );
  expect(page.webSocketUrl).toContain('frontend_id=9');
  expect(page.summary).toMatchObject({
    status: 'ENDED',
    publication: 'Open',
    loginObserved: 'unknown',
  });
  expect(JSON.stringify(page.summary)).not.toContain('secret');
  expect(errorSummary(new Error('secret url'))).toEqual({ code: 'UNEXPECTED_ERROR' });
  expect(errorSummary(new HlsForbiddenError('https://example.test/secret'))).toEqual({
    code: 'HLS_HTTP_ERROR',
    httpStatus: 403,
  });
});

test('視聴情報を受信し、再接続指示では新しい接続を作らずに終了する', async () => {
  const server = await startFakeWatchServer({
    streamData: () => ({
      protocol: 'hls',
      uri: 'https://example.test/master?secret=token',
      cookies: [{ name: 'session', value: 'secret-cookie', domain: 'example.test', path: '/' }],
    }),
  });
  try {
    const session = await observeSession(
      server.url,
      'user_session=secret',
      new AbortController().signal,
    );
    expect(session.summary).toMatchObject({ opened: true, hasHls: true, hasComments: true });
    expect(session.stream?.cookies[0].value).toBe('secret-cookie');
    expect(JSON.stringify(session.summary)).not.toContain('secret');
    const closed = once(server.connections[0].socket, 'close');
    server.send(0, { type: 'reconnect', data: { waitTimeSec: 600, audienceToken: 'secret' } });
    await closed;
    expect(session.summary.serverCodes).toContain('RECONNECT_REQUESTED');
    expect(server.connections).toHaveLength(1);
    session.close();
  } finally {
    await server.close();
  }
});

const playlist =
  '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:3,\n1.ts\n#EXTINF:3,\n2.ts\n#EXTINF:3,\n3.ts\n';

test('短区間は境界に切り上げ、合成した ENDLIST と元の全編末尾を区別する', () => {
  const clipped = clipPlaylist(playlist, 'https://example.test/media.m3u8', 4);
  expect(clipped.summary).toMatchObject({
    selectedDuration: 6,
    expectedSavedSegments: 2,
    originalEndList: false,
  });
  expect(clipped.text).toContain('#EXT-X-ENDLIST');
  expect(clipped.text).not.toContain('3.ts');
  const later = clipPlaylist(
    playlist + '#EXT-X-DISCONTINUITY\n',
    'https://example.test/media.m3u8',
    4,
  );
  expect(later.summary.tags.counts['EXT-X-DISCONTINUITY']).toBe(1);
  expect(later.summary.unsupportedTags).toEqual([]);
});

test('DISCONTINUITY-SEQUENCE を不連続境界と誤認しない', () => {
  const result = clipPlaylist(
    playlist.replace('#EXTM3U', '#EXTM3U\n#EXT-X-DISCONTINUITY-SEQUENCE:3'),
    'https://example.test/media.m3u8',
    4,
  );
  expect(result.summary.selectedTagCounts['EXT-X-DISCONTINUITY-SEQUENCE']).toBe(1);
  expect(result.summary.unsupportedTags).toEqual([]);
});

test('対象区間内の不連続は拒否し、両トラックの診断を URL 抜きで残す', async () => {
  const unsafe = playlist.replace('2.ts', '#EXT-X-DISCONTINUITY\n2.ts');
  mockFetch({
    'https://example.test/master.m3u8':
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="a"\nmedia.m3u8\n',
    'https://example.test/media.m3u8': unsafe,
    'https://example.test/audio.m3u8': playlist,
  });
  const progress = vi.fn<(summary: Record<string, unknown>) => void>();
  await expect(
    sampleVideo(
      {
        uri: 'https://example.test/master.m3u8',
        quality: 'abr',
        availableQualities: [],
        cookies: [],
        receivedAt: new Date(),
      },
      dir,
      4,
      new AbortController().signal,
      progress,
    ),
  ).rejects.toThrow(ProbeError);
  expect(progress.mock.calls[0]?.[0]).toMatchObject({
    tracks: [
      {
        label: 'video',
        unsupportedTags: ['EXT-X-DISCONTINUITY'],
        tags: {
          firstUnsupportedPositions: [
            { tag: 'EXT-X-DISCONTINUITY', segmentIndex: 1, atSeconds: 3 },
          ],
        },
      },
      { label: 'audio', unsupportedTags: [] },
    ],
  });
  expect(JSON.stringify(progress.mock.calls)).not.toContain('https://');
});

test('コメント開始位置を省略・now・数値で正確に切り替える', () => {
  expect(buildProbeViewUrl('https://example.test/view?at=now&token=secret', 'beginning')).toBe(
    'https://example.test/view?token=secret',
  );
  expect(buildProbeViewUrl('https://example.test/view?at=1', 'now')).toBe(
    'https://example.test/view?at=now',
  );
  expect(buildProbeViewUrl('https://example.test/view', '1788692366')).toBe(
    'https://example.test/view?at=1788692366',
  );
  expect(parseOptions(['lv1', '--anonymous', '--view-at', '1788692366'], {})?.viewAt).toBe(
    '1788692366',
  );
  expect(() => parseOptions(['lv1', '--anonymous', '--view-at', '123&token=secret'], {})).toThrow();
});

test('next だけの応答を空の履歴と断定せず、int64 カーソルを丸めずに保存する', async () => {
  const registry = await getProtoRegistry();
  mockFetch({
    'https://example.test/view': registry.ChunkedEntry.encodeDelimited(
      registry.ChunkedEntry.fromObject({ next: { at: '9223372036854775807' } }),
    ).finish(),
  });
  const result = await sampleComments(
    'https://example.test/view?at=now',
    dir,
    1000,
    'beginning',
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    count: 0,
    requestedAt: 'omitted',
    nextAt: '9223372036854775807',
    historyExhausted: false,
    fullCoverage: 'not-verified',
    viewEntries: { total: 1, next: 1, backward: 0, previous: 0, segment: 0 },
  });
});

test.each([false, true])('セグメント欠落=%s を短区間の保存成功と区別する', async (missing) => {
  mockFetch({
    'https://example.test/master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nmedia.m3u8\n',
    'https://example.test/media.m3u8': playlist,
    'https://example.test/1.ts': 'first',
    'https://example.test/2.ts': missing ? 404 : 'second',
  });
  const result = await sampleVideo(
    {
      uri: 'https://example.test/master.m3u8',
      quality: 'abr',
      availableQualities: [],
      cookies: [],
      receivedAt: new Date(),
    },
    dir,
    4,
    new AbortController().signal,
  );
  expect(result.status).toBe(missing ? 'incomplete' : 'sample-saved');
  expect(result.missingSegments).toBe(missing ? 1 : 0);
  expect(result.fullCoverage).toBe('not-verified');
});

test.each([1, 10])('NDGR の履歴と直近分を辿り、重複と件数上限=%s を扱う', async (limit) => {
  const registry = await getProtoRegistry();
  const message = (id: string, no: number) => ({
    meta: { id, at: { seconds: 1000 + no } },
    message: { chat: { content: `comment-${no}`, no, vpos: no * 100 } },
  });
  const view = Buffer.concat([
    registry.ChunkedEntry.encodeDelimited(
      registry.ChunkedEntry.create({ backward: { segment: { uri: 'https://example.test/back' } } }),
    ).finish(),
    registry.ChunkedEntry.encodeDelimited(
      registry.ChunkedEntry.create({ segment: { uri: 'https://example.test/forward' } }),
    ).finish(),
    registry.ChunkedEntry.encodeDelimited(
      registry.ChunkedEntry.create({ next: { at: 1234 } }),
    ).finish(),
  ]);
  const pack = (messages: unknown[], next?: string) =>
    registry.PackedSegment.encode(
      registry.PackedSegment.create({ messages, ...(next ? { next: { uri: next } } : {}) }),
    ).finish();
  mockFetch({
    'https://example.test/view?at=now': view,
    'https://example.test/back': pack([message('a', 1)], 'https://example.test/back2'),
    'https://example.test/back2': pack([message('b', 2)]),
    'https://example.test/forward': Buffer.concat(
      [message('b', 2), message('c', 3)].map((m) =>
        registry.ChunkedMessage.encodeDelimited(registry.ChunkedMessage.create(m)).finish(),
      ),
    ),
  });
  const result = await sampleComments(
    'https://example.test/view',
    dir,
    limit,
    'now',
    new AbortController().signal,
  );
  expect(result.count).toBe(limit === 1 ? 1 : 3);
  expect(result.duplicates).toBe(limit === 1 ? 0 : 1);
  expect(result.reason).toBe(limit === 1 ? 'comment-limit' : 'view-exhausted');
  expect(result.historyExhausted).toBe(limit !== 1);
  const lines = (await fs.readFile(path.join(dir, 'comments.jsonl'), 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(result.count);
  expect(JSON.stringify(result)).not.toContain('comment-1');
});
