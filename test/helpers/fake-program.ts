import { createCipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { getProtoRegistry } from '../../src/main/vendor/nico-client/internal/protoLoader';
import { startFakeHttp } from './fake-http';
import { startFakeWatchServer, type FakeWatchServer } from './fake-watch-server';
import { ndgrFixture } from './ndgr-fixture';

export interface FakeProgramOptions {
  mode?: 'live' | 'timeshift';
  separateAudio?: boolean;
  commentsStatus?: number;
  missingSegment?: boolean;
  openEnded?: boolean;
  refreshKey?: boolean;
  /** backward 保存後のコメント取得を止め、終了処理の検証で使う。 */
  holdForward?: boolean;
}

/** 番組HTMLから暗号化HLS・NDGRまで、外部通信なしで本体の取得経路を通す。 */
export async function startFakeProgram(options: FakeProgramOptions = {}) {
  const registry = await getProtoRegistry();
  const key = Buffer.alloc(16, 7);
  const iv = Buffer.alloc(16);
  iv[15] = 1;
  const media = new Map<string, Buffer>();
  for (const track of options.separateAudio ? ['video', 'audio'] : ['combined']) {
    const input = readFileSync(new URL(`../fixtures/ffmpeg/${track}.mp4`, import.meta.url));
    const split = input.indexOf(Buffer.from('moof')) - 4;
    if (split < 0) throw new Error(`fragment not found: ${track}`);
    media.set(`/init-${track}`, input.subarray(0, split));
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    media.set(
      `/segment-${track}`,
      Buffer.concat([cipher.update(input.subarray(split)), cipher.final()]),
    );
  }
  const requests: { path: string; cookie?: string }[] = [];
  let watch: FakeWatchServer;
  let credential = 's1';
  const http = await startFakeHttp((request, response) => {
    const requestPath = request.url ?? '/';
    requests.push({ path: requestPath, cookie: request.headers.cookie });
    const url = new URL(requestPath, http.url);
    const send = (body: Buffer | string, status = 200): void => {
      response.writeHead(status);
      response.end(body);
    };
    if (url.pathname === '/watch') {
      const html = readFileSync(new URL('../fixtures/nico/watch.html', import.meta.url), 'utf8')
        .replace(
          'ws://127.0.0.1:1/watch?token=dummy&amp;quality=high',
          watch.url.replaceAll('&', '&amp;'),
        )
        .replace('ON_AIR', options.mode === 'timeshift' ? 'ENDED' : 'ON_AIR');
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.end(gzipSync(html));
      return;
    }
    if (url.pathname === '/view') {
      if (options.commentsStatus) return send('comment unavailable', options.commentsStatus);
      const entries = [
        { backward: { segment: { uri: `${http.url}/packed` } } },
        { segment: { uri: `${http.url}/forward` } },
        { next: { at: 100 } },
      ];
      // 可変のローカルURLを持つ索引だけを生成し、コメント本文は固定wireデータを使う。
      const body = Buffer.concat(
        entries.map((entry) => registry.ChunkedEntry.encodeDelimited(entry).finish()),
      );
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.end(gzipSync(body));
      return;
    }
    if (url.pathname === '/packed' || url.pathname === '/forward') {
      if (url.pathname === '/forward' && options.holdForward) return;
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.end(gzipSync(ndgrFixture(url.pathname === '/packed' ? 'packed' : 'forward')));
      return;
    }
    // 視聴接続から受け取ったCookieを鍵・playlist・セグメントの全てで検査する。
    if (request.headers.cookie !== `session=${credential}`) return send('forbidden', 403);
    if (url.pathname === '/master') {
      const audio = options.separateAudio
        ? '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="main",URI="/audio.m3u8"\n'
        : '';
      return send(
        `#EXTM3U\n${audio}#EXT-X-STREAM-INF:BANDWIDTH=1000${options.separateAudio ? ',AUDIO="a"' : ''}\n/${options.separateAudio ? 'video' : 'combined'}.m3u8\n`,
      );
    }
    if (url.pathname.endsWith('.m3u8')) {
      const track = url.pathname.slice(1, -'.m3u8'.length);
      return send(
        [
          '#EXTM3U',
          '#EXT-X-TARGETDURATION:2',
          '#EXT-X-MEDIA-SEQUENCE:1',
          `#EXT-X-MAP:URI="/init-${track}"`,
          '#EXT-X-KEY:METHOD=AES-128,URI="/key",IV=0x00000000000000000000000000000001',
          '#EXTINF:2,',
          `/segment-${track}`,
          ...(options.missingSegment ? ['#EXTINF:2,', '/missing'] : []),
          ...(options.openEnded ? [] : ['#EXT-X-ENDLIST']),
          '',
        ].join('\n'),
      );
    }
    if (url.pathname === '/key') {
      if (options.refreshKey && credential === 's1') {
        credential = 's2';
        return send('expired', 403);
      }
      return send(key);
    }
    const body = media.get(url.pathname);
    send(body ?? 'missing', body ? 200 : 404);
  });
  const originalDispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  try {
    watch = await startFakeWatchServer({
      viewUri: `${http.url}/view`,
      streamData: () => ({
        protocol: 'hls',
        uri: `${http.url}/master`,
        quality: 'high',
        cookies: [{ name: 'session', value: credential, domain: '127.0.0.1', path: '/' }],
      }),
    });
    // 固定の公式URLだけローカルへ誘導し、他の外部HTTP通信は失敗させる。
    agent.disableNetConnect();
    agent.enableNetConnect(new URL(http.url).host);
    agent
      .get('https://live.nicovideo.jp')
      .intercept({ path: '/watch/lv42', method: 'GET' })
      .reply(302, '', { headers: { location: `${http.url}/watch` } })
      .persist();
    setGlobalDispatcher(agent);
    return {
      url: http.url,
      requests,
      watch,
      close: async () => {
        setGlobalDispatcher(originalDispatcher);
        await watch.close();
        await http.close();
        await agent.close();
      },
    };
  } catch (error) {
    await http.close();
    await agent.close();
    throw error;
  }
}
