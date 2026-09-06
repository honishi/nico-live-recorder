# Web Push 復号テストのデータ

`test/vendor/web-push/web-push-crypto.test.ts` が読む追加データです。流用元の Chrome 拡張を起動する必要はありません。テストはローカルで実行し、外部に接続しません。

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

`datasets/` 直下の `.json` をすべて読み、復号結果を `expected.decryptedJson` と比較します。データがない場合は `examples/example.json` を読みますが、ダミーの `authSecret` (`AAAAAAAAAAAAAAAAAAAAAA`) のケースは復号を行わず終了します。

同じテストファイルには、実データなしでも動く Base64・鍵生成・payload 解析のテストと、固定のテスト鍵から暗号文を生成する復号テストがあります。後者は共有秘密の先頭ゼロを省略する送信側への互換処理と、改ざん時の失敗も確認します。

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
