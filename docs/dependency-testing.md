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

`test/app/recording-manager-integration.test.js` は実managerと録画・検知をつなぎ、
FFmpeg異常終了後の別パート再開、旧動画とCSVの保持、累計履歴を確認します。
さらにファイルへ保存したpush購読の再読込、暗号通知からの録画、検知再起動後の
ポーリングとの重複防止、push登録失敗時のポーリング録画を確認します。
OS通知と認証情報の入口だけを差し替え、外部接続は拒否します。

Electron・React・electron-viteは `scripts/test-electron.mjs` でビルド済み画面の起動、
preload・IPC、タブ操作、変更通知、設定の保存・再起動後の復元を確認します。

結合テストはライブ・タイムシフト、別音声・音声込み、コメント認証エラー、
タイムシフトの欠落と再取得、ライブの鍵失効・手動停止を対象にします。
本体のWebSocket・暗号処理・Protobuf・ファイル保存は差し替えません。
Nodeの録画結合テストはHTTP接続をMockAgentの許可リスト経由でローカルへ通します。
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
FFmpegのソースはmacOSの準備ジョブで一度取得・SHA-256検証し、同じ実行のartifactとして
各OSへ渡します。各ビルドでも再検証するため、Windowsランナーからffmpeg.orgへの
直接接続が失敗しても、ソースやビルド条件を変えずにテストできます。
ソース設定をキーにしたキャッシュを使い、ヒット時もSHA-256を再検証します。
取得の接続失敗・HTTPエラーは最大3回まで再試行します。取得後のハッシュ不一致は再試行せず失敗します。
`node scripts/ffmpeg/build.mjs --download-only` で取得・検証だけを実行できます。
Releaseでも実行し、既存の配布物展開後のFFmpeg・更新メタデータ検証と併用します。

## Electron内蔵通信ランタイム

`npm run test:electron:runtime` は独立した Electron main を一時 userData で起動します。
内蔵fetchで不正圧縮指定・本文途中切断・応答待ちの中断を個別に発生させ、各失敗後に
正常なBrotli応答を読めることを確認します。内蔵WebSocketと`ws`では送受信・制御フレームの
PING/PONG・異常切断後の新規接続を確認します。通常のNodeテストと同じローカルサーバーを
使い、未処理例外・プロセス異常終了・ハングも失敗にします。実行時の`process.versions`を出力します。
PRとReleaseのmacOS・Windowsジョブで実行します。脆弱性全般の検証や実サービスの監視ではありません。

HTTPS/WSSもローカルのTLSサーバーで検証します。テスト専用CAで署名した正常な証明書と、
信頼していない自己署名証明書を使い、証明書の拒否、TLSハンドシェイク中の切断、
HTTPS本文の途中切断・応答待ちの中断、その後の正常通信を確認します。
内蔵WebSocketと`ws`はWSSの証明書拒否・ハンドシェイク切断後に再接続し、
送受信とPING/PONG、確立済み接続の異常切断も確認します。
証明書検証は有効なまま、CAの追加を実行中のスレッドに限定し、終了時に戻します。
OSの証明書ストアは変更しません。固定証明書の仕様は
[TLS素材の説明](../test/fixtures/tls/README.md)を参照してください。
npm版Undiciの既定requestもHTTPSで同じ異常系を検査します。加えて明示的なnpm版Agent
（既定設定）でHTTP/2を交渉すること、証明書拒否・
ハンドシェイク切断・RST_STREAM・応答待ちの中断後に再び本文を読めることを検証します。
切断時の内部エラーコードは固定せず、証明書拒否と中断の理由、タイムアウトに頼らない失敗、回復を確認します。
対象はNode側のTLS通信で、Chromiumの証明書ストアや企業プロキシの検証は含みません。

## Electron実体のスモークテスト

通常のVitestと実FFmpegのテストはNode上で実行します。Electron実体は次のコマンドで別途確認します。

```sh
npm run build
npm run test:electron
```

Electronのスモークテストは、空の一時userData・保存先と自動割当のCDPポートを使います。
起動・画面更新はイベントを待って確認し、固定秒数のsleepには依存しません。
実FFmpegを配置してから実行してください。二重起動側も含む全起動インスタンスの未処理rejection・廃止警告・例外と、終了後の保存ログのERROR・
トレイ画像欠落を失敗として扱います。driver経由の起動ではrenderer・GPU・utility等の異常終了も監視し、
復旧検査で指定したrendererの意図的なクラッシュ1回だけを除外します。警告・実rendererクラッシュ・
終了時エラーを発生させる負の検査で、この検出器自身も確認します。専用mainの認証・通信検査も共通の一時環境と診断保存を使います。
PRとReleaseのmacOS・Windowsジョブにも含めています。

## Electron Cookieの契約

`npm run test:electron:auth` は本体のNicoAuthを実Electronで動かします。
隔離したsessionにダミーCookieを入れ、同名の親ドメインCookieの優先、値中の`=`、
ログイン窓の二重起動防止・キャンセル・成功通知、再起動後の永続化、ログアウト時の削除を確認します。
ログインページはローカルHTTPSへ誘導し、実ChromiumがSecure・HttpOnly・SameSite=None付きの
Set-Cookieを受理して認証状態へ反映するところから検査します。DNS解決はループバックへ限定し、
証明書の例外は検証専用プロセスの固定テスト鍵のSPKIだけに限定します。
実アカウントへは接続せず、OSの信頼ストアは変更しません。
実サービスのログインや認証方式の変更への対応は、人間による確認が必要です。
PRとReleaseのmacOS・Windowsジョブで実行します。

## 配布アプリの録画テスト

`ffmpeg:verify-artifacts` はDMG/ZIP/NSISから展開したアプリも起動します。
単独では `npm run test:electron:packaged -- <実行ファイルの絶対パス>` で実行できます。
`app.isPackaged` と `app.asar` からの起動を確認し、リポジトリ外の空白・日本語を含む
一時ディレクトリをcwd・userData・保存先として使います。

ライブ（別音声）の手動停止とタイムシフト（音声込み）の完了を、実preload/IPCから開始します。
番組HTMLだけをローカルへ誘導します。ローカルの録画通信は内蔵fetchとnpm Undiciそれぞれの
本来のAgentへ振り分け、実際に両方が使われたことも確認します。固定API応答だけをMockAgentへ渡し、
未許可の接続は拒否します。内蔵dispatcherの取得に使う内部symbolが変わった場合は明示的に失敗します。
本体のWS・復号・同梱FFmpeg・proto読込は置き換えません。
TSのコーデックとパケット数、固定コメントのCSV、JSON、履歴と設定の再起動後復元を確認します。
通常終了は `app.quit()` を使い、強制終了は失敗した検証プロセスの後始末だけに使います。
ライブの停止・終了前には、映像・音声の両方がセグメントを書き終えて次のplaylist取得へ
進むまで待ちます。コメントの到着だけで全パケットの保存を推定しません。

ライブ録画の1ケースでは、隔離sessionにダミーCookieを入れて録画カードを表示します。
実FFmpegが生成したJPEGをChromiumでdecodeし、寸法と表示領域を確認します。
タブ移動時のプレビュー購読解除・復帰、ウィンドウを閉じても録画が継続すること、
非表示時の画像要求の拒否、実行ファイルの二重起動による既存窓の再表示も確認します。
capturePageの結果が空・単色でないことと、トレイ画像欠落の警告がないことも確認します。
描画キャプチャはGPU全般の正常性や画面の視覚的な正しさを保証しません。
トレイのネイティブメニューの外観やOS固有の操作は自動確認の対象外です。

さらにライブ録画中と、タイムシフトの映像取得が終わりコメント取得が残った状態で
通常終了します。後者は偽サーバーのforward応答を保留し、保存済みコメントと映像を確認してから
終了するため、実時間のsleepには依存しません。終了後にTS・CSV・JSON、確定済みの履歴、
録画終了ログを確認し、FFmpegのPIDが残っていないことと、再起動後も中断扱いにならないことを検証します。
タイムシフトの未取得分は `cancelled` / `USER_CANCELLED` として区別します。

起動前のmain inspectorから隔離設定を注入するため、本番アプリにテスト用IPCや分岐はありません。
外部HTTPはMockAgentで拒否し、Chromiumの外部要求も拒否します。
自動更新の確認・適用はテスト側で無効化し、本番配信先や更新キャッシュへアクセスさせません。
このテストは自動更新ドライバーの検証には数えません。出力は一時領域に保存して終了後に削除し、
失敗時だけ限定した診断情報を `artifacts/electron/` に残します。

メジャー間のプロファイル移行、暗号pushからの録画、renderer/mainのクラッシュ復旧は、
[メジャー移行・異常終了の回帰テスト](development.md#electron-のメジャー移行異常終了の回帰テスト)を参照してください。

## 実updaterのダウンロード

`npm run test:electron:updater -- <配布アプリの実行ファイルの絶対パス>` は
配布アプリの実electron-updaterとElectronのnetを、ローカルのgeneric配信先につなぎます。
ダウンロードURLには別のローカルオリジンへの302リダイレクトを挟み、転送先まで取得したことを確認します。
許可する通信先はその2オリジンだけです。generic providerによる検査のため、GitHub provider固有のAPI処理は対象外です。
更新確認からダウンロード中・完了までの実IPC通知、転送進捗、保存バイト列とキャッシュ情報、
SHA512不一致での拒否を確認します。通常終了後にも適用処理が呼ばれなかったことを検査します。
`ffmpeg:verify-artifacts` にも含め、PRとReleaseのmacOS・Windowsジョブで実行します。

userDataに加え、updaterのキャッシュ基点もテスト側から一時領域へ向け、保存先を検査します。
本番フィードや本番キャッシュにはアクセスしません。固定バイト列の全量ダウンロードを使い、
差分ダウンロード、署名検証、実インストーラーの適用、Squirrelへの受け渡しは対象外です。
適用経路にはテスト側の失敗用ガードを置き、呼ばれた場合は終了後も失敗を検出します。

## 残る確認

ログイン、実アカウントのpush登録・フォローAPI、更新インストーラーの適用は対象外です。
固定データは現在想定している通信形式との互換性を確認するものであり、
ニコニコ側のAPI変更を検知する監視ではありません。

録画コア変更時の実放送確認、Electron更新時の通信ランタイムの確認、
ログイン経路の人間による確認など、AGENTS.mdの既存規約は引き続き適用します。
