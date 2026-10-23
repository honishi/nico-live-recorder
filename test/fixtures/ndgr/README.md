# NDGR の固定テストデータ

`.hex` は `resources/proto/dwango/nicolive/chat/` のフィールド番号と Protobuf wire format
（varint、長さ付きフィールド）から組み立てた合成データです。実ユーザーの通信・認証情報は含みません。
protobufjs のエンコーダーは使用していません。テスト中にも再生成しません。
依存更新の際は、テストを通すために入力や期待値を再生成せず、変更理由を確認してください。

- `comment.hex`: 長さプレフィックスなしの ChunkedMessage（168バイト）。
  ID は `fixture-comment`、投稿時刻は秒1700000000・ナノ秒123456789、
  live_id は9007199254740991、raw_user_id は4294967297。
  本文は日本語・引用符・改行・絵文字、装飾は上・大・RGB(1,2,3)・明朝・半透明です。
- `forward.hex`: 上のコメントを2回と、番組終了状態を1回、長さプレフィックス付きで連結。
  重複排除と、2バイト長プレフィックスを含む分割受信の検証に使います。
- `packed.hex`: 同じコメントと番組終了状態を持つ PackedSegment。
- `next-cursors.hex`: ChunkedEntry.next.at が9007199254740991、9007199254740993、-1、0の順。
  長さプレフィックス付きで連結し、64bit整数の精度を確認します。

コメントのフィールド構造と期待値は `test/vendor/nico-client/internal/protobuf-contract.test.ts`
に列挙しています。未知フィールドや壊れた長さは、固定データに明示的なバイト列を追加して検証します。
