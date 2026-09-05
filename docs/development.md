# 開発者向けドキュメント

nico-live-recorder の仕組み、開発の手順、コード構成、リリースの流れをまとめています。
作業の規約 (ブランチ、コミット、テストの方針) は [AGENTS.md](../AGENTS.md)、出力するファイルの一覧は [files.md](files.md) を参照してください。

## 仕組み

```
放送開始の検知
  ├─ Web Push (Mozilla AutoPush 経由、ニコニコの push 通知を購読)   ... 主
  └─ フォロー中番組 API のポーリング (既定 30 秒)                    ... 副 (取りこぼし防止)
        ↓ 対象配信者の放送なら
録画
  ├─ 視聴 WebSocket (startWatching) → HLS の URI と cookie を取得
  ├─ 映像・音声の playlist を追跡し、セグメントを取得して AES-128 を復号
  ├─ ffmpeg に 2 本のパイプで渡し、1 本の .ts に多重化
  └─ NDGR からコメントを受信し .comments.jsonl に追記
```

- push 通知は **ログイン中のアカウントがフォローしている配信者** の放送開始にだけ届きます。アプリはフォロー状態の確認だけを行い、フォロー操作はしません。
- 有効な録画対象が 0 件のときは、ポーリングも push の接続も止めます (外部にアクセスしない)。
- HLS を ffmpeg に直接渡さないのは、ニコニコが同名の CloudFront cookie をパス別に複数配るためです (ffmpeg の cookie 管理は名前単位で、正しく送れません)。
- playlist の再取得は RFC 8216 の下限 (変化ありなら target duration、なしならその半分) を守ります。視聴 WebSocket の再接続は録画ごとに 1 本だけ動かし、試行回数も録画全体で数えます。
- 映像が途中で止まっても番組が続いていれば、連番付きの別ファイル (`_2.ts`, `_3.ts`, …) で再開します。録画中に出力ファイルが消されたことも検知して、別ファイルで再開します。
- 放送検知の実装は [chrome-nico-alert](https://github.com/honishi/chrome-nico-alert)、コメント取得は stream-journal の nico-client を元にしています。

## 開発

Node のバージョンは `.node-version` に固定しています (nodenv などで自動的に切り替わります)。
Electron 44 が内蔵する Node と同じ 24 系で、`min-release-age` などに使う npm 11 が同梱されます。

```bash
npm install
npm run ffmpeg:build # 録画用 FFmpeg をビルド (前提ツールは下記参照)
npm run dev          # electron-vite の開発モードで起動
npm run format       # prettier
npm run lint         # eslint (型情報を使うルールを含む)
npm run typecheck
npm test             # vitest
npm run build        # out/ に成果物を出力
```

Electron を起動せずに録画部分だけを試すスクリプトもあります。

```bash
npx tsx scripts/record.ts lv123456789 30 ./recordings      # 30 秒だけ録画
npx tsx scripts/record-comments.ts                          # コメント取得のみ
NICO_USER_SESSION=... npx tsx scripts/push-listen.ts        # push 購読の疎通確認
npm run build && npx tsx scripts/e2e-screenshots.ts         # アプリを起動して各タブのスクリーンショット
```

検証用に起動するときは、必ず `NLR_USER_DATA` (設定の置き場所) と `NLR_OUTPUT_DIR` (保存先の既定値) を一時ディレクトリにして、本番の設定や録画に触らないようにしてください。`e2e-screenshots.ts` は設定済みです。

```bash
NLR_USER_DATA=/tmp/nlr-userdata NLR_OUTPUT_DIR=/tmp/nlr-recordings npm run dev
```

失敗後の再開処理は `NLR_DEV_FAIL_VIDEO_AFTER_MS=8000` のように設定して起動すると、映像を強制的に失敗させて確認できます。

### コード構成

```
src/main/core/nico/           視聴 WebSocket、HLS 取得・復号、ffmpeg 多重化、フォロー中番組 API
src/main/core/recorder/       映像録画・コメント録画・番組単位の録画まとめ
src/main/core/detector/       push + ポーリングの放送検知
src/main/core/push/           Web Push の購読管理 (ニコニコ push API への登録、通知の復号)
src/main/vendor/web-push/     AutoPush クライアントと RFC 8291 復号 (chrome-nico-alert 由来)
src/main/vendor/nico-client/  NDGR コメントクライアント (stream-journal 由来)
src/main/app/                 Electron 側: 設定、ログイン、録画マネージャ、履歴、ログ、トレイ、IPC
src/renderer/                 React の設定ウィンドウ
src/shared/                   main と renderer で共有する型・定数・整形
resources/proto/              NDGR の protobuf 定義
resources/tray/               トレイアイコン (16px と @2x。黒 = macOS のテンプレート / Windows の明テーマ、白 = Windows の暗テーマ)
build/                        アプリアイコン (icns / ico と、その元になるサイズ別 PNG) と macOS の entitlements
test/                         src/main/ を鏡写しにしたテスト。偽サーバーは test/helpers/
```

### ログ

- ユーザーが見る情報 (検知、録画の開始・終了、エラー) は `info` 以上、内部の状態遷移は `debug` です。
- ウィンドウのログは `info` 以上と `debug` を別のリングバッファ (各 2000 件) で保持し、ログタブの「debug を表示」で切り替えます。
- ファイル (`userData/logs/app.log`) と標準出力は `info` 以上を書きます。「debug を表示」が有効な間と開発時は `debug` も書きます。5 MB を超えると `app.log.1` に退避します。

## CI とリリース

- PR と main への push で GitHub Actions (`.github/workflows/ci.yml`) が ubuntu と windows で format / lint / typecheck / test / build を実行します。macOS arm64 と Windows x64 では FFmpeg のビルドとパッケージ内実体の検証も行います。
- `v0.1.0` のような `v` 始まりのタグを push すると、macOS (Apple Silicon) と Windows (x64) のパッケージを作り、下書きのリリースに添付します (`release.yml`)。内容を確認してから公開してください。
- 本家の Release は macOS の署名・公証と、DMG / ZIP 展開後の Gatekeeper / FFmpeg 検証を必須にします。手動実行ではリリースを作らず、検証済み成果物を Actions の artifact に保存します。必要な Secrets と検証手順は [mac-signing.md](mac-signing.md) を参照してください (issue #22)。Windows の署名は issue #23 で扱います。

### 新しいバージョンの表示

- パッケージ版は起動時と 6 時間ごとに、GitHub Releases の最新の正式リリースを認証なしで確認します。設定タブの「情報」から手動確認もできます。開発起動では自動確認しません。
- 更新があれば画面上部にバージョンと「リリースページを開く」を表示します。ダウンロード・アプリの置き換えはユーザーが手動で行います。アプリからの自動インストール・再起動はありません。
- 現在の非公開リポジトリや正式リリースがない場合は API が 404 を返すため、「公開された更新情報を取得できません」と表示します。「更新なし」とは区別し、録画・検知は継続します。GitHub のトークンはアプリに持たせません。
- リポジトリを公開し、成果物を添付した正式リリースを公開すれば、次回の確認から利用できます。コードや設定の切り替え、更新用メタデータ、署名・公証はこの通知機能には不要です。未署名アプリの起動時の制限は別途残ります。
- 公開時は `package.json` のバージョンとタグ (`v0.2.0` など) を一致させ、その正式リリースを GitHub の Latest に指定してください。下書きとプレリリースは通知しません。バージョンは SemVer で比較します。
- 手動確認も最低 60 秒間隔に制限します。通信は 10 秒で中断し、API 制限時は最低 1 時間、解除時刻が先ならそこまで待ちます。通信失敗時も、既に検知した更新の案内は保持します。確認状態はメモリ内だけに保持します。
- 公開前の確認は `test/app/update-checker.test.ts` で API をモックします。公開後は旧バージョンのパッケージ版で、実リリースの通知とリンクを macOS / Windows それぞれで確認してください。

## パッケージング

```bash
npm run package:mac   # release/ に dmg / zip
npm run package:win   # release/ に nsis インストーラ
```

FFmpeg は公式ソースから LGPL-2.1-or-later の構成でビルドし、完全な対応ソースと許諾文を同梱します。パッケージ作成前に `npm run ffmpeg:build` を実行してください。macOS arm64 / Windows x64 それぞれのネイティブ環境で作成し、同梱した実体を `afterPack` で検証します。取得元、前提ツール、ライセンス条件、検証手順は [ffmpeg.md](ffmpeg.md) を参照してください。

### アプリアイコン

アプリアイコンは `build/icons/` のサイズ別 PNG、トレイアイコンは `resources/tray/` の PNG が元データです。出荷用の `build/icon.icns` と `build/icon.ico` は、1024px の 1 枚から縮小すると 16 / 32 / 64px で括弧が潰れるため、サイズ別に描き分けた `build/icons/*.png` から `npm run icons:build` (macOS 専用。`iconutil` と `sips` を使う) で組み立て、生成物ごとリポジトリに含めます。アイコンを更新したときだけ実行してください。開発起動でも Dock / タスクバーに同じアイコンを出します。

## ライセンス

アプリ本体は MIT。別プロセスとして実行する同梱 FFmpeg / ffprobe は LGPL-2.1-or-later です。ライセンス本文、著作権表示、対応ソースとビルド手順をアプリに同梱します。
