import crypto from 'node:crypto';
import { TimeshiftError } from './timeshift-common';

interface Box {
  type: string;
  body: Buffer;
}
export interface FragmentTiming {
  initHash: string;
  tracks: Map<number, { start: bigint; end: bigint }>;
}

function unsupported(): never {
  throw new TimeshiftError('DISCONTINUITY_TIMING_UNSUPPORTED');
}

// 必要なISO BMFF boxだけを読む。範囲外・未知の長さは推測して接続せず中止する。
function boxes(buffer: Buffer): Box[] {
  const result: Box[] = [];
  for (let offset = 0; offset < buffer.length;) {
    if (buffer.length - offset < 8) unsupported();
    const small = buffer.readUInt32BE(offset);
    let size = small;
    let header = 8;
    if (small === 1) {
      if (buffer.length - offset < 16) unsupported();
      const large = buffer.readBigUInt64BE(offset + 8);
      if (large > BigInt(buffer.length - offset)) unsupported();
      size = Number(large);
      header = 16;
    } else if (small === 0) size = buffer.length - offset;
    if (size < header || size > buffer.length - offset) unsupported();
    result.push({
      type: buffer.toString('ascii', offset + 4, offset + 8),
      body: buffer.subarray(offset + header, offset + size),
    });
    offset += size;
  }
  return result;
}
function one(items: Box[], type: string): Buffer {
  const matches = items.filter((item) => item.type === type);
  if (matches.length !== 1) unsupported();
  return matches[0].body;
}
function uint(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) unsupported();
  return buffer.readUInt32BE(offset);
}

// trunのsample_duration、tfhd、trexの順で期間を解決する。全サンプルのDTS範囲を照合する。
function duration(trun: Buffer, fallback: number | undefined): bigint {
  const flags = uint(trun, 0) & 0xffffff;
  if (trun[0] > 1 || flags & ~0xf05) unsupported();
  const count = uint(trun, 4);
  if (count === 0) unsupported();
  const start = 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
  const width = [0x100, 0x200, 0x400, 0x800].filter((flag) => flags & flag).length * 4;
  if (start + count * width !== trun.length) unsupported();
  if (!(flags & 0x100)) {
    if (!fallback) unsupported();
    return BigInt(count) * BigInt(fallback);
  }
  let total = 0n;
  for (let i = 0; i < count; i += 1) {
    const value = uint(trun, start + i * width);
    if (value === 0) unsupported();
    total += BigInt(value);
  }
  return total;
}

/** 不連続タグの前後でだけ呼ぶ。通常のセグメント取得に解析負荷を加えない。 */
export function inspectFragmentTiming(data: Buffer, init: Buffer | undefined): FragmentTiming {
  if (!init) unsupported();
  const moov = boxes(one(boxes(init), 'moov'));
  const defaults = new Map<number, number>();
  const mvex = moov.find((box) => box.type === 'mvex');
  for (const box of mvex ? boxes(mvex.body) : []) {
    if (box.type === 'trex') defaults.set(uint(box.body, 4), uint(box.body, 12));
  }
  const tracks: FragmentTiming['tracks'] = new Map();
  for (const moof of boxes(data).filter((box) => box.type === 'moof')) {
    for (const traf of boxes(moof.body).filter((box) => box.type === 'traf')) {
      const children = boxes(traf.body);
      const tfhd = one(children, 'tfhd');
      const flags = uint(tfhd, 0) & 0xffffff;
      if (tfhd[0] !== 0 || flags & 0x10000) unsupported();
      const id = uint(tfhd, 4);
      const defaultOffset = 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
      const defaultDuration = flags & 8 ? uint(tfhd, defaultOffset) : defaults.get(id);
      const tfdt = one(children, 'tfdt');
      uint(tfdt, 0);
      let start: bigint;
      if (tfdt[0] === 0 && tfdt.length === 8) start = BigInt(uint(tfdt, 4));
      else if (tfdt[0] === 1 && tfdt.length === 12) start = tfdt.readBigUInt64BE(4);
      else unsupported();
      const runs = children.filter((box) => box.type === 'trun');
      if (!runs.length) unsupported();
      const span = runs.reduce((sum, box) => sum + duration(box.body, defaultDuration), 0n);
      const previous = tracks.get(id);
      if (previous && previous.end !== start) unsupported();
      tracks.set(id, { start: previous?.start ?? start, end: start + span });
    }
  }
  if (!tracks.size) unsupported();
  return { initHash: crypto.createHash('sha256').update(init).digest('hex'), tracks };
}

/** 同じ初期化情報・トラック・連続したDTSの場合だけ、そのまま多重化できる境界と判断する。 */
export function requireContinuousFragments(
  previous: FragmentTiming | undefined,
  current: FragmentTiming,
): void {
  if (
    !previous ||
    previous.initHash !== current.initHash ||
    previous.tracks.size !== current.tracks.size
  )
    throw new TimeshiftError('DISCONTINUITY_FORMAT_CHANGED');
  for (const [id, track] of current.tracks) {
    if (previous.tracks.get(id)?.end !== track.start)
      throw new TimeshiftError('DISCONTINUITY_TIMESTAMP_CHANGED');
  }
}
