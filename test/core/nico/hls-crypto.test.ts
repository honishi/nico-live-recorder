import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import { decryptHlsSegment } from '../../../src/main/core/nico/hls-crypto';
import { HlsTrackDownloader, parseMediaPlaylist } from '../../../src/main/core/nico/hls';
import {
  downloadMetrics,
  downloadTimeshiftTrack,
} from '../../../src/main/core/nico/timeshift-download';

const key = Buffer.alloc(16, 7);
const plain = Buffer.from('映像セグメントのテスト');
function encrypt(iv: string): Buffer {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.from(iv, 'hex'));
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

test.each([
  [0, undefined, '00000000000000000000000000000000'],
  [4294967297, undefined, '00000000000000000000000100000001'],
  [42, '', '0000000000000000000000000000002a'],
  [42, 'AbC', '00000000000000000000000000000abc'.padStart(32, '0')],
  [42, 'gg', '00000000000000000000000000000000'],
  [42, '11'.repeat(17), '11'.repeat(16)],
] as const)('seq=%s IV=%sの従来の解釈を保つ', (seq, iv, expectedIv) => {
  const encrypted = encrypt(expectedIv);
  const original = Buffer.from(encrypted);
  expect(decryptHlsSegment(encrypted, key, seq, iv)).toEqual(plain);
  expect(encrypted).toEqual(original);
});

test('壊れた暗号文を平文として返さない', () => {
  expect(() => decryptHlsSegment(Buffer.alloc(1), key, 1)).toThrow();
});

test('ライブの不正IV解釈とタイムシフトの拒否を共通化後も変えない', async () => {
  const playlist =
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/key",IV=0xgg\n#EXTINF:6,\n/segment\n#EXT-X-ENDLIST\n';
  const origin = 'https://example.test';
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const name = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
      .pathname;
    return new Response(
      name === '/media' ? playlist : name === '/key' ? key : encrypt('00'.repeat(16)),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  try {
    const live = new HlsTrackDownloader({
      label: 'video',
      playlistUrl: origin + '/media',
      cookies: () => [],
      fetchImpl: fetcher,
    });
    expect((await live.run(sink)).segments).toBe(1);
    expect(Buffer.concat(chunks)).toEqual(plain);
    await expect(
      downloadTimeshiftTrack(
        parseMediaPlaylist(playlist, origin + '/media').segments,
        sink,
        [],
        1,
        new AbortController().signal,
        downloadMetrics(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ENCRYPTION_IV' });
    expect(chunks).toHaveLength(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
