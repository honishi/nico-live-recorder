import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getProtoRegistry,
  configureProtoRootDir,
} from '../../../../src/main/vendor/nico-client/internal/protoLoader';
import { ProtobufStreamReader } from '../../../../src/main/vendor/nico-client/internal/protobufStreamReader';
import { int64ToSafeInteger } from '../../../../src/main/vendor/nico-client/internal/int64';
import { convertTimeshiftComment } from '../../../../src/main/core/recorder/timeshift-comment-recorder';
import { toCommentCsv } from '../../../../src/main/core/recorder/comment-csv';
import { ndgrFixture } from '../../../helpers/ndgr-fixture';

const expected = {
  meta: {
    id: 'fixture-comment',
    at: { seconds: '1700000000', nanos: 123456789 },
    origin: { chat: { live_id: '9007199254740991' } },
  },
  message: {
    chat: {
      content: '日本語のコメント, "引用符"\n改行と絵文字🎵も保持する',
      vpos: 150,
      account_status: 1,
      raw_user_id: '4294967297',
      hashed_user_id: 'hash:test',
      modifier: { position: 2, size: 2, full_color: { r: 1, g: 2, b: 3 }, font: 1, opacity: 1 },
      no: 42,
    },
  },
};

function drain(reader: ProtobufStreamReader): Uint8Array[] {
  const messages: Uint8Array[] = [];
  let message;
  while ((message = reader.unshift()) !== undefined) messages.push(message);
  return messages;
}

test('固定バイナリから64bit整数・装飾・ナノ秒を元のフィールド名で復元する', async () => {
  const { ChunkedMessage } = await getProtoRegistry();
  expect(
    ChunkedMessage.toObject(ChunkedMessage.decode(ndgrFixture('comment')), { longs: String }),
  ).toEqual(expected);
});

test('未知フィールドが追加されても既知のコメントを保持する', async () => {
  const { ChunkedMessage } = await getProtoRegistry();
  // field 99, wire type 0, value 7 を既存データに追加する。
  const data = Buffer.concat([ndgrFixture('comment'), Buffer.from('980607', 'hex')]);
  expect(ChunkedMessage.toObject(ChunkedMessage.decode(data), { longs: String })).toEqual(expected);
});

test('PackedSegment 内のコメントと番組終了状態を復元する', async () => {
  const { PackedSegment } = await getProtoRegistry();
  expect(
    PackedSegment.toObject(PackedSegment.decode(ndgrFixture('packed')), { longs: String }),
  ).toEqual({
    messages: [expected, { state: { program_status: { state: 1 } } }],
  });
});

test.each([1, 2, 7, 4096])(
  '%i バイトずつ受信しても長さ情報・文字・メッセージの境界を保つ',
  async (size) => {
    const reader = new ProtobufStreamReader();
    const data = ndgrFixture('forward');
    const frames: Uint8Array[] = [];
    for (let offset = 0; offset < data.length; offset += size) {
      reader.addChunk(data.subarray(offset, offset + size));
      frames.push(...drain(reader));
    }
    const { ChunkedMessage } = await getProtoRegistry();
    expect(
      frames.map((frame) =>
        ChunkedMessage.toObject(ChunkedMessage.decode(frame), { longs: String }),
      ),
    ).toEqual([expected, expected, { state: { program_status: { state: 1 } } }]);
    expect(reader.unshift()).toBeUndefined();
  },
);

test('全ての分割位置で未完のフレームを保留し、残りの受信後に復元する', () => {
  const body = ndgrFixture('comment');
  // 168 バイトの本文に対する2バイト長プレフィックス。protobufjs では生成しない。
  const frame = Buffer.concat([Buffer.from([0xa8, 0x01]), body]);
  for (let split = 0; split < frame.length; split++) {
    const reader = new ProtobufStreamReader();
    reader.addChunk(frame.subarray(0, split));
    reader.addChunk(new Uint8Array());
    expect(reader.unshift(), `split=${split}`).toBeUndefined();
    reader.addChunk(frame.subarray(split));
    expect(Buffer.from(reader.unshift()!), `split=${split}`).toEqual(body);
    expect(reader.unshift()).toBeUndefined();
  }
});

test.each(['ffffffff10', '808080808000'])('不正なuint32長 %s を拒否する', (hex) => {
  const reader = new ProtobufStreamReader();
  reader.addChunk(Buffer.from(hex, 'hex'));
  expect(() => reader.unshift()).toThrow(/VarInt/);
});

test('64bitカーソルを丸めずにデコードし、安全整数の範囲外を拒否する', async () => {
  const { ChunkedEntry } = await getProtoRegistry();
  const reader = new ProtobufStreamReader();
  reader.addChunk(ndgrFixture('next-cursors'));
  const cursors = drain(reader).map((frame) => (ChunkedEntry.decode(frame) as any).next.at);
  expect(cursors.map((value) => value.toString())).toEqual([
    '9007199254740991',
    '9007199254740993',
    '-1',
    '0',
  ]);
  expect(cursors.map(int64ToSafeInteger)).toEqual([Number.MAX_SAFE_INTEGER, undefined, -1, 0]);
});

test('固定コメントをCSVへ変換しても日時・装飾・引用符・本文改行を保持する', async () => {
  const { ChunkedMessage } = await getProtoRegistry();
  // タイムシフト本体と同じ toObject を通し、省略フィールドの既定値を持ち込まない。
  const decoded = ChunkedMessage.toObject(ChunkedMessage.decode(ndgrFixture('comment')), {
    longs: String,
  });
  const converted = convertTimeshiftComment(decoded)!;
  expect(converted.comment.at.toISOString()).toBe('2023-11-14T22:13:20.123Z');
  expect(toCommentCsv(converted.comment)).toBe(
    '"2023-11-15T07:13:20.123+09:00","42","日本語のコメント, ""引用符""\n改行と絵文字🎵も保持する","150","4294967297","hash:test","Premium","ue","big","#010203","mincho","Translucent","fixture-comment","9007199254740991"\n',
  );
});

test('配置先を変更してもgoogle型を含むprotoを読み込み、旧レジストリを再利用しない', async () => {
  const original = path.resolve('resources/proto');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nlr proto '));
  try {
    const previous = await getProtoRegistry();
    await fs.cp(original, dir, { recursive: true });
    configureProtoRootDir(dir);
    const moved = await getProtoRegistry();
    expect(moved).not.toBe(previous);
    expect(
      moved.ChunkedMessage.toObject(moved.ChunkedMessage.decode(ndgrFixture('comment')), {
        longs: String,
      }),
    ).toEqual(expected);
  } finally {
    configureProtoRootDir(original);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
