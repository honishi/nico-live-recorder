# TLS の固定テスト素材

ローカルの HTTPS/WSS サーバー専用の証明書と公開済みのテスト鍵です。
実サービスやユーザーの証明書は含みません。配布アプリには使いません。

- `ca.pem`: テスト専用 CA。RSA 2048 bit、SHA-256、CA=true、pathLen=0。
- `server.pem`: 上記 CA で署名したサーバー証明書。SAN は `localhost` と `127.0.0.1`、用途は serverAuth。
- `untrusted.pem`: 同じサーバー鍵・SAN・用途を使った自己署名証明書。信頼リストへ追加しません。
- `server-key.pem`: 両サーバー証明書に対応するテスト専用 RSA 2048 bit 鍵。

証明書の有効期間はすべて 2020-01-01 UTC〜2120-01-01 UTC です。
Python cryptography 50.0.2 の CertificateBuilder で生成しました。
CA の署名鍵は生成時のみ使用し、保存していません。
再生成時は上記の属性と期間を維持し、4ファイルをまとめて置き換えてください。
通常のテスト実行には Python・OpenSSL コマンド・外部通信は不要です。

テストは `tls.setDefaultCACertificates` で実行中のスレッドだけに CA を追加し、
終了時に元のリストへ戻します。OS の証明書ストアや本番設定は変更しません。
`rejectUnauthorized: false` や `NODE_TLS_REJECT_UNAUTHORIZED=0` は使用しません。
