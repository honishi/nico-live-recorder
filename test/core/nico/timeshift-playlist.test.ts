import { prepareTimeshiftPlaylist } from '../../../src/main/core/nico/timeshift-playlist';
import { parseMediaPlaylist } from '../../../src/main/core/nico/hls';
const playlist =
  '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-MAP:URI="/blank/init"\n#EXTINF:1,\n/blank/1\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="/init"\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:6,\n/real\n#EXT-X-ENDLIST\n';
test('先頭のblank境界を許可し、暗黙IV用のsequenceとMAPを保持する', () => {
  const prepared = prepareTimeshiftPlaylist(playlist, 'https://example.test/media');
  expect(prepared.summary.expectedSavedSegments).toBe(1);
  expect(parseMediaPlaylist(prepared.text, 'https://example.test/media').segments[1]).toMatchObject(
    {
      seq: 11,
      mapUri: 'https://example.test/init',
      key: { method: 'AES-128', uri: 'https://example.test/key' },
    },
  );
});
test.each([
  '#EXT-X-DISCONTINUITY',
  '#EXT-X-BYTERANGE:10',
  '#EXT-X-GAP',
  '#EXT-X-MAP:URI="/map",BYTERANGE="10"',
])('本編の未対応タグ %s を成功扱いにしない', (tag) => {
  expect(() =>
    prepareTimeshiftPlaylist(
      playlist.replace('#EXT-X-ENDLIST', `${tag}\n#EXTINF:6,\n/next\n#EXT-X-ENDLIST`),
      'https://example.test/media',
    ),
  ).toThrow('UNSUPPORTED_PLAYLIST_TAG');
});
test('元のENDLISTの欠落と空playlistを拒否する', () => {
  expect(() =>
    prepareTimeshiftPlaylist(playlist.replace('#EXT-X-ENDLIST', ''), 'https://example.test/media'),
  ).toThrow('ORIGINAL_ENDLIST_MISSING');
  expect(() =>
    prepareTimeshiftPlaylist('#EXTM3U\n#EXT-X-ENDLIST', 'https://example.test/media'),
  ).toThrow('EMPTY_PLAYLIST');
});
