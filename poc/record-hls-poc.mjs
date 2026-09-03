// PoC v2: Node で HLS セグメントを取得・AES-128 復号し、ffmpeg にパイプで渡して ts に多重化する
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const WebSocket = require('/Users/honishi/dev/honishi/stream-journal/packages/nico-client/node_modules/ws');

const programId = process.argv[2];
const seconds = Number(process.argv[3] ?? 20);
const outPath = process.argv[4] ?? `./${programId}.ts`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 視聴ページ → WebSocket → stream (HLS URI + cookies)
const html = await (
  await fetch(`https://live.nicovideo.jp/watch/${programId}`, { headers: { 'user-agent': UA } })
).text();
const m = html.match(/<script[^>]*id="embedded-data"[^>]*data-props="([^"]+)"/);
const props = JSON.parse(
  m[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'"),
);
const wsUrl = props.site.relive.webSocketUrl + `&frontend_id=${props.site.frontendId}`;
console.log('title:', props.program.title, '| status:', props.program.status);
const ws = new WebSocket(wsUrl, {
  headers: { 'User-Agent': UA, Origin: 'https://live.nicovideo.jp' },
});
const stream = await new Promise((resolve, reject) => {
  ws.on('open', () =>
    ws.send(
      JSON.stringify({
        type: 'startWatching',
        data: {
          stream: { quality: 'abr', protocol: 'hls', latency: 'high', chasePlay: false },
          room: { protocol: 'webSocket', commentable: true },
          reconnect: false,
        },
      }),
    ),
  );
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ping') {
      ws.send('{"type":"pong"}');
      ws.send('{"type":"keepSeat"}');
      console.log('[ws] ping -> pong/keepSeat');
    } else if (msg.type === 'stream') resolve(msg.data);
    else if (msg.type === 'disconnect') console.log('[ws] disconnect', JSON.stringify(msg.data));
  });
  ws.on('error', reject);
});
const cookieFor = (url) => {
  const p = new URL(url).pathname;
  return stream.cookies
    .filter((c) => p.startsWith(c.path))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
};
const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': UA, cookie: cookieFor(url) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
};

// ---- multivariant から最高画質の video playlist と audio playlist を選ぶ
const mv = (await get(stream.uri)).toString();
const videoUrl = mv.split('\n').find((l) => l.startsWith('https://') && l.includes('video'));
const audioUrl = mv.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*URI="([^"]+)"/)[1];
console.log('video:', videoUrl.split('/').at(-1), '| audio:', audioUrl.split('/').at(-1));

// ---- ffmpeg: fd3 = video, fd4 = audio
const args = [
  '-hide_banner',
  '-loglevel',
  'warning',
  '-nostdin',
  '-copyts',
  '-i',
  'pipe:3',
  '-i',
  'pipe:4',
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-c',
  'copy',
  '-f',
  'mpegts',
  '-y',
  outPath,
];
const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'] });
const ffExit = new Promise((r) => ff.on('close', r));

// ---- media playlist を追跡し、セグメントを復号してパイプへ流す
function parsePlaylist(text) {
  const lines = text.split('\n').map((l) => l.trim());
  const out = { map: undefined, key: undefined, segments: [], targetDuration: 3, mediaSequence: 0 };
  let seq = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-TARGETDURATION:')) out.targetDuration = Number(l.split(':')[1]);
    else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      out.mediaSequence = Number(l.split(':')[1]);
      seq = out.mediaSequence;
    } else if (l.startsWith('#EXT-X-MAP:')) out.map = l.match(/URI="([^"]+)"/)[1];
    else if (l.startsWith('#EXT-X-KEY:')) {
      const method = l.match(/METHOD=([^,]+)/)[1];
      out.key =
        method === 'NONE'
          ? undefined
          : { uri: l.match(/URI="([^"]+)"/)[1], iv: l.match(/IV=0x([0-9A-Fa-f]+)/)?.[1] };
    } else if (l.startsWith('#EXTINF:')) {
      // 次の非コメント行が URL (EXT-X-PART 等は無視)
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j < lines.length && lines[j])
        out.segments.push({ seq: seq++, url: lines[j], key: out.key, map: out.map });
      i = j;
    }
  }
  return out;
}

async function pump(label, playlistUrl, pipe, deadline) {
  let lastSeq = -1;
  let sentMap;
  const keyCache = new Map();
  let bytes = 0,
    count = 0;
  const write = (buf) => new Promise((r) => (pipe.write(buf) ? r() : pipe.once('drain', r)));
  while (Date.now() < deadline) {
    const pl = parsePlaylist((await get(playlistUrl)).toString());
    const fresh = pl.segments.filter((s) => s.seq > lastSeq);
    // 初回は末尾 2 セグメントだけ (ライブエッジ付近から開始)
    const todo = lastSeq < 0 ? fresh.slice(-2) : fresh;
    for (const s of todo) {
      if (s.map && s.map !== sentMap) {
        await write(await get(s.map));
        sentMap = s.map;
      }
      let data = await get(s.url);
      if (s.key) {
        if (!keyCache.has(s.key.uri)) keyCache.set(s.key.uri, await get(s.key.uri));
        const iv = s.key.iv
          ? Buffer.from(s.key.iv.padStart(32, '0'), 'hex')
          : Buffer.alloc(16)
              .fill(0)
              .map((_, i) => (i >= 12 ? (s.seq >> ((15 - i) * 8)) & 0xff : 0));
        const d = crypto.createDecipheriv('aes-128-cbc', keyCache.get(s.key.uri), iv);
        data = Buffer.concat([d.update(data), d.final()]);
      }
      await write(data);
      bytes += data.length;
      count++;
      lastSeq = s.seq;
    }
    if (todo.length) console.log(`[${label}] seq=${lastSeq} segs=${count} bytes=${bytes}`);
    await sleep(pl.targetDuration * 500);
  }
  pipe.end();
}

const deadline = Date.now() + seconds * 1000;
await Promise.all([
  pump('video', videoUrl, ff.stdio[3], deadline),
  pump('audio', audioUrl, ff.stdio[4], deadline),
]);
console.log('ffmpeg exit:', await ffExit);
ws.close();
console.log('size:', fs.statSync(outPath).size);
