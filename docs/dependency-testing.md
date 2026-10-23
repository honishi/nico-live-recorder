# 依存更新時の回帰テスト

通常の確認は `npm run format` → `npm run lint` → `npm run typecheck` → `npm test` →
`npm run build` の順に行います。依存を更新しても、互換性テストの固定入力・期待値は
原則として変更しません。失敗した場合は、入力仕様の変更か本体の回帰かを確認します。

## 自動で確認する範囲

| 対象                      | テスト                                                       | 保証する範囲                                                                           |
| ------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Undici・set-cookie-parser | `test/vendor/nico-client/internal/httpClient.test.ts`        | 実HTTPでの圧縮、Cookie更新、リダイレクト、HTTPエラー、切断・中断・途中離脱後の通信継続 |
| Cheerio                   | `test/vendor/nico-client/program-info.test.ts`               | 固定HTMLからの番組情報・文字参照・視聴URL取得、情報欠落とHTTPエラーの区別              |
| protobufjs                | `test/vendor/nico-client/internal/protobuf-contract.test.ts` | 固定wireデータ、受信境界、64bit整数、時刻と装飾、protoの配置先変更                     |
| コメント変換              | `test/vendor/nico-client/NicoClient.test.ts`                 | 実デコード結果のRGB色と名前付き色、既定値、重複排除                                    |
| 録画全体                  | `test/core/recorder/program-recorder-integration.test.ts`    | 番組HTML→視聴WS→HLS・コメント→動画・CSV・JSONの保存                                    |

Electron・React・electron-viteは `scripts/test-electron.mjs` でビルド済み画面の起動、
preload・IPC、タブ操作、変更通知、設定の保存・再起動後の復元を確認します。

結合テストはライブ・タイムシフト、別音声・音声込み、コメント認証エラー、
タイムシフトの欠落と再取得、ライブの鍵失効・手動停止を対象にします。
本体のHTTP・WebSocket・暗号処理・Protobuf・ファイル保存は差し替えません。
公式の番組ページURLだけローカルHTTPへ誘導し、それ以外の外部HTTP接続は拒否します。
視聴WSとコンテンツのURLはローカルサーバーだけを指します。
出力はテスト専用の一時ディレクトリに作成し、終了時に削除します。

通常の `npm test` は偽FFmpegへの入力をバイト単位で比較します。
これによりFFmpegのビルドなしでも、全セグメントの取得・復号・パイプへの書き込みを確認できます。
固定Protobufデータの仕様は [fixturesの説明](../test/fixtures/ndgr/README.md) を参照してください。

## 同梱FFmpegを使う結合テスト

```sh
npm run ffmpeg:build
npm run test:recording
```

同じ結合テストを現在のOS・CPU向け同梱FFmpegで実行します。
ffprobeで出力TSを読み直し、H.264とAACを持つこと、各トラックのパケット数が
入力素材と一致することを確認します。バイナリ未配置ならスキップせず失敗します。
スクリプト内部の `NLR_TEST_FFMPEG` と `NLR_TEST_FFPROBE` はテスト専用です。

PRのCIではmacOS arm64・Windows x64のpackageジョブに含めています。
Releaseでも実行し、既存の配布物展開後のFFmpeg・更新メタデータ検証と併用します。

## Electron実体のスモークテスト

通常のVitestと実FFmpegのテストはNode上で実行します。Electron実体は次のコマンドで別途確認します。

```sh
npm run build
npm run test:electron
```

Electronのスモークテストは、空の一時userData・保存先と自動割当のCDPポートを使います。
起動・画面更新はイベントを待って確認し、固定秒数のsleepには依存しません。
実FFmpegを配置してから実行してください。mainのエラーログも失敗として扱います。
PRとReleaseのmacOS・Windowsジョブにも含めています。

## 残る確認

このスモークテストはビルド済みソースをElectronで起動するため、配布後のASAR・リソース配置は
保証しません。ログイン、実アカウントのpush登録・フォローAPI、更新インストーラーの適用も対象外です。
固定データは現在想定している通信形式との互換性を確認するものであり、
ニコニコ側のAPI変更を検知する監視ではありません。

録画コア変更時の実放送確認、Electron更新時のUndici差し替え見直し、
ログイン経路の人間による確認など、AGENTS.mdの既存規約は引き続き適用します。
