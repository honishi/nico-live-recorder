import { parseMediaPlaylist } from './hls';
import { TimeshiftError } from './timeshift-common';

/** 元の ENDLIST とタグを検証する。sequence・MAP・鍵・IV は書き換えずに使う。 */
export function prepareTimeshiftPlaylist(text: string, url: string) {
  const parsed = parseMediaPlaylist(text, url);
  if (!parsed.endList) throw new TimeshiftError('ORIGINAL_ENDLIST_MISSING');
  if (!parsed.segments.length) throw new TimeshiftError('EMPTY_PLAYLIST');
  const firstSavedIndex = parsed.segments.findIndex((segment) => !segment.uri.includes('/blank/'));
  let segmentIndex = 0;
  let pendingSegment = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const tag = line.startsWith('#') ? line.slice(1).split(':', 1)[0] : '';
    // 先頭の blank 群から本編へ入る境界だけを許可する。
    if (tag === 'EXT-X-DISCONTINUITY' && !(firstSavedIndex > 0 && segmentIndex === firstSavedIndex))
      throw new TimeshiftError('UNSUPPORTED_PLAYLIST_TAG');
    if (
      tag === 'EXT-X-BYTERANGE' ||
      tag === 'EXT-X-GAP' ||
      (tag === 'EXT-X-MAP' && /BYTERANGE\s*=/.test(line))
    )
      throw new TimeshiftError('UNSUPPORTED_PLAYLIST_TAG');
    if (tag === 'EXTINF') pendingSegment = true;
    if (line && !line.startsWith('#') && pendingSegment) {
      segmentIndex += 1;
      pendingSegment = false;
    }
  }
  for (const segment of parsed.segments) {
    if (segment.key && segment.key.method !== 'AES-128')
      throw new TimeshiftError('UNSUPPORTED_ENCRYPTION');
    if (
      !Number.isFinite(segment.duration) ||
      segment.duration <= 0 ||
      !Number.isSafeInteger(segment.seq)
    )
      throw new TimeshiftError('INVALID_PLAYLIST');
  }
  return {
    text,
    summary: {
      expectedSavedSegments: parsed.segments.filter((segment) => !segment.uri.includes('/blank/'))
        .length,
      playlistDuration: parsed.segments.reduce((sum, segment) => sum + segment.duration, 0),
    },
  };
}
