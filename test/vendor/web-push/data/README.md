# Web Push 復号テストのデータ

実データの復号テストを追加するときの形式例です。流用元の Chrome 拡張を起動する必要はありません。テストはローカルで実行し、外部に接続しません。

## ディレクトリ構成

```text
test/vendor/web-push/data/
├── datasets/           # 手元で用意する実データ (Git 対象外)
│   └── .gitkeep
├── examples/
│   └── example.json    # 形式を示すダミーデータ (Git 管理)
├── .gitignore
└── README.md
```

`test/vendor/web-push/web-push-crypto.test.ts` は固定のテスト鍵から暗号文を生成し、RFC 形式・先頭ゼロを省略する送信側との互換処理・改ざん時の失敗を検証します。鍵の生成・保存・復元は PushManager の通知受信テストで確認します。

このディレクトリの JSON は自動では読み込みません。実データを使う場合は、入力と期待する平文を指定するテストを明示的に追加してください。ダミーデータを成功扱いするフォールバックはありません。

## 実データを追加する場合

リポジトリ直下で実行し、例をコピーします。

```bash
cp test/vendor/web-push/data/examples/example.json test/vendor/web-push/data/datasets/my-test.json
```

コピーした JSON のダミー値を次の項目で置き換えます。

| 項目                       | 内容                                             |
| -------------------------- | ------------------------------------------------ |
| `keys.authSecret`          | 購読時の auth secret (Base64 URL-safe)           |
| `keys.publicKey`           | 同じ購読の公開鍵 (Base64 URL-safe)               |
| `keys.privateKey`          | 同じ購読の秘密鍵 (Base64 URL-safe)               |
| `payload.encryptedPayload` | AutoPush 通知の `message.data` (Base64 URL-safe) |
| `expected.decryptedJson`   | 期待する復号後の JSON オブジェクト               |

```bash
npm test -- test/vendor/web-push/web-push-crypto.test.ts
```

アプリの購読状態は userData の `push-subscription.json`、開発用 `scripts/push-listen.ts` では指定した状態ファイルに保存され、`keys` に上記の鍵が入ります。暗号文と復号結果の対応は `src/main/core/push/web-push-manager.ts` の `handleNotification` で確認できます。通常のログにはテストデータ一式を出力しません。新しい実データの取得には、ログイン済みの環境で人間による疎通確認が必要です。

実データには秘密鍵と通知内容が含まれます。このディレクトリの `.gitignore` は `datasets/*` を除外し、`.gitkeep` だけを管理対象にします。実データを `examples/` やコミット対象のログに置かないでください。
