import { parseMediaPlaylist } from './hls';
import { TimeshiftError } from './timeshift-common';

const OBSERVED_TAGS = [
  'EXT-X-DISCONTINUITY',
  'EXT-X-DISCONTINUITY-SEQUENCE',
  'EXT-X-BYTERANGE',
  'EXT-X-GAP',
  'EXT-X-MAP',
  'EXT-X-KEY',
  'EXT-X-ENDLIST',
] as const;
interface PlaylistTagPosition {
  tag: string;
  segmentIndex: number;
  atSeconds: number;
  previous: 'none' | 'blank' | 'media';
  next: 'none' | 'blank' | 'media';
  position: 'leading' | 'internal' | 'trailing';
}
export interface TimeshiftPlaylistDiagnostic {
  segments: number;
  durationSeconds: number;
  blankSegments: number;
  originalEndList: boolean;
  tagCounts: Record<string, number>;
  boundaries: PlaylistTagPosition[];
  unsupported: PlaylistTagPosition[];
  unsupportedCount: number;
  continuityCheckCount: number;
}

/** 元の ENDLIST とタグを検証する。URI・属性値は診断へ含めず、元のsequence・鍵・IVを維持する。 */
export function prepareTimeshiftPlaylist(
  text: string,
  url: string,
  onDiagnostic?: (diagnostic: TimeshiftPlaylistDiagnostic) => void,
) {
  const parsed = parseMediaPlaylist(text, url);
  const saved = parsed.segments.map((segment) => !segment.uri.includes('/blank/'));
  const firstSavedIndex = saved.indexOf(true);
  const lastSavedIndex = saved.lastIndexOf(true);
  const diagnostic: TimeshiftPlaylistDiagnostic = {
    segments: parsed.segments.length,
    durationSeconds: parsed.segments.reduce((sum, segment) => sum + segment.duration, 0),
    blankSegments: saved.filter((value) => !value).length,
    originalEndList: parsed.endList,
    tagCounts: {},
    boundaries: [],
    unsupported: [],
    unsupportedCount: 0,
    continuityCheckCount: 0,
  };
  const continuityCheckSeqs = new Set<number>();
  let segmentIndex = 0;
  let atSeconds = 0;
  let pendingSegment = false;
  const kind = (index: number): PlaylistTagPosition['previous'] =>
    index < 0 || index >= saved.length ? 'none' : saved[index] ? 'media' : 'blank';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const tag = line.startsWith('#') ? line.slice(1).split(':', 1)[0] : '';
    if (OBSERVED_TAGS.some((name) => name === tag))
      diagnostic.tagCounts[tag] = (diagnostic.tagCounts[tag] ?? 0) + 1;
    const position: PlaylistTagPosition = {
      tag: tag === 'EXT-X-MAP' ? 'EXT-X-MAP-BYTERANGE' : tag,
      segmentIndex,
      atSeconds: Math.round(atSeconds * 1000) / 1000,
      previous: kind(segmentIndex - 1),
      next: kind(segmentIndex),
      position:
        segmentIndex <= firstSavedIndex
          ? 'leading'
          : segmentIndex > lastSavedIndex
            ? 'trailing'
            : 'internal',
    };
    if (tag === 'EXT-X-DISCONTINUITY' && diagnostic.boundaries.length < 40)
      diagnostic.boundaries.push(position);
    // 保存対象同士の境界は、取得後に初期化情報と実データの時刻を確認する。
    // 先頭・末尾の空白だけの境界は保存した映像同士をつながないため、この照合は不要。
    const internalBoundary = tag === 'EXT-X-DISCONTINUITY' && position.position === 'internal';
    if (internalBoundary && position.previous === 'media' && position.next === 'media') {
      continuityCheckSeqs.add(parsed.segments[segmentIndex].seq);
      diagnostic.continuityCheckCount += 1;
    }
    // 対応外のタグは最後まで数え、拒否する場合も種類・位置を最大40件残す。
    const unsupported =
      (internalBoundary && (position.previous !== 'media' || position.next !== 'media')) ||
      tag === 'EXT-X-BYTERANGE' ||
      tag === 'EXT-X-GAP' ||
      (tag === 'EXT-X-MAP' && /BYTERANGE\s*=/.test(line));
    if (unsupported) {
      diagnostic.unsupportedCount += 1;
      if (diagnostic.unsupported.length < 40) diagnostic.unsupported.push(position);
    }
    if (tag === 'EXTINF') pendingSegment = true;
    if (line && !line.startsWith('#') && pendingSegment) {
      atSeconds += parsed.segments[segmentIndex]?.duration ?? 0;
      segmentIndex += 1;
      pendingSegment = false;
    }
  }
  onDiagnostic?.(diagnostic);
  if (!parsed.endList) throw new TimeshiftError('ORIGINAL_ENDLIST_MISSING');
  if (!parsed.segments.length) throw new TimeshiftError('EMPTY_PLAYLIST');
  if (diagnostic.unsupportedCount) throw new TimeshiftError('UNSUPPORTED_PLAYLIST_TAG');
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
    continuityCheckSeqs,
    summary: {
      expectedSavedSegments: saved.filter(Boolean).length,
      playlistDuration: diagnostic.durationSeconds,
    },
  };
}
