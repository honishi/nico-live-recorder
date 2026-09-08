// 不連続境界の回帰テスト用。外部メディアを使わず、必要なBMFF boxだけ組み立てる。
export function mp4Box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, body]);
}
function words(...values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeUInt32BE(value, index * 4));
  return buffer;
}
export function fragmentInit(duration = 1, id = 1): Buffer {
  return mp4Box('moov', mp4Box('mvex', mp4Box('trex', words(0, id, 1, duration, 0, 0))));
}
export function fragment(
  start: bigint,
  durationSource: 'tfhd' | 'trex' | 'trun' = 'tfhd',
  id = 1,
): Buffer {
  const tfhd = mp4Box(
    'tfhd',
    words(durationSource === 'tfhd' ? 8 : 0, id, ...(durationSource === 'tfhd' ? [1] : [])),
  );
  const timestamp = Buffer.alloc(12);
  timestamp[0] = 1;
  timestamp.writeBigUInt64BE(start, 4);
  const tfdt = mp4Box('tfdt', timestamp);
  const trun = mp4Box(
    'trun',
    words(
      durationSource === 'trun' ? 0x100 : 0,
      6,
      ...(durationSource === 'trun' ? [1, 1, 1, 1, 1, 1] : []),
    ),
  );
  return mp4Box('moof', mp4Box('traf', tfhd, tfdt, trun));
}
