# AGENTS.md

nico-live-recorder (ニコ生自動録画の Electron アプリ) で作業するときの規約。
仕組みやコード構成は [README.md](README.md) を参照すること。

## Issue と作業の流れ

- やることは GitHub の issue で管理する。着手する作業は issue から始め、無ければ先に作る。
- 優先度は `priority: high / medium / low`、種類は `type: infra / feature / chore` のラベルで表す。
- commit の footer に `Closes #12` のように issue 番号を入れ、マージで issue を閉じる。ブランチ名に番号は付けない。

## ブランチとマージ

- 新機能の実装は必ずブランチを作って行う。ブランチ名は `do-something-cool` のようにハイフン区切り。
- マージは `git merge --no-ff` で行い、マージコミットを残す。

## コミットメッセージ

- Angular の conventional commit 形式 (`feat(scope): subject`) に準拠する。
- 英語で簡潔に書く。

## コードコメント

- 読者の理解を助けるためのコメントを日本語で書く。
- コードを目で追うときのひとかたまりの処理ごとにコメントを付け、上から自然に読める状態にする。

## 検証

- commit 前に `npm run format` → `npm run lint` → `npm run typecheck` → `npm test` を通す。
- テストは積極的に足すが、何でも書くのではなく、壊れたときの実害と、書く手間・保守の手間・実行時間との釣り合いで判断する。録画や検知のように壊れると取りこぼしにつながる経路を優先し、表示だけの部品や Electron 実体が要るものは無理に書かない。
- テストは `test/` 以下に `src/main/` を鏡写しにして置く (`src/main/core/nico/hls.ts` → `test/core/nico/hls.test.ts`)。偽サーバーなど共通の道具は `test/helpers/`。ネットワークに出る部分は偽サーバー (視聴 WebSocket、HLS、AutoPush) か `vi.mock` で差し替え、テストから外部に接続しない。
- 録画コアの変更は `npx tsx scripts/record.ts <lv番号> 30 ./recordings` で実放送に対して確認する。
- Electron 全体は `--remote-debugging-port` 付きで起動し、CDP から `window.api.*` を呼んで確認できる。検証用のインスタンスは必ず `NLR_USER_DATA` (設定) と `NLR_OUTPUT_DIR` (保存先) を一時ディレクトリにして、本番の設定や録画に触らない。
- 本番の保存先 (既定は `~/Movies/NicoLiveRecorder`) と userData の中身は、検証の後始末でも消さない。録画中のフォルダを消すと録画が失われる。
- 失敗後の再開処理は `NLR_DEV_FAIL_VIDEO_AFTER_MS=8000` のように設定して起動すると、映像を強制的に失敗させて確認できる。
- ログインが必要な経路 (push 登録、フォロー中番組のポーリング、フォロー状態確認) はエージェントでは検証できない。変更したら人間側の確認を依頼する。
- 改行は LF に固定する (`.gitattributes` と `.editorconfig`)。CI は ubuntu と windows の両方でチェックを回すので、Windows で落ちる書き方 (shell script の spawn、実時間に依存する待ち) をテストに入れない。

## 依存パッケージ

- 公開から 7 日未満のバージョンは `.npmrc` の `min-release-age` で弾かれる。最新版が入らないときは 1 つ前を使う。
- 新しい依存を足すときは install script の有無を確認し、必要なものだけ `package.json` の `allowScripts` で許可する。

## ニコニコ API の扱い

- 非公開 API (push 登録、フォロー状態確認、nvapi など) は予告なく変わる前提で書く。
- 失敗は機能単位で degrade させ、録画や検知の全体を止めない。

## 流用元コード

- `src/main/vendor/` は流用元のコード (`web-push/` は chrome-nico-alert、`nico-client/` は stream-journal 由来)。upstream の修正を取り込めるよう、構造を大きく変えない。ESLint の緩和対象でもある。

## ログ

- ユーザーが見る情報 (検知、録画の開始・終了、エラー) は `info` 以上。内部の状態遷移は `debug`。
- 自動で回復する切断 (push の WebSocket が 20 分ごとに切られて再接続する など) は `debug`。回復しないまま続く場合に 1 回だけ `warn`、諦めたときだけ `error` にする。
- ウィンドウのログは `info` 以上と `debug` を別のリングバッファで保持し (`debug` の量で `info` が押し出されないように)、表示はログタブの「debug を表示」で切り替える。ファイルと標準出力は `info` 以上 (「debug を表示」が有効な間は `debug` も書く。開発時は常に `debug`)。
