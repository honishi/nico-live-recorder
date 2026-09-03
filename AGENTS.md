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
- テストは `test/` 以下に `src/main/` を鏡写しにして置く (`src/main/core/nico/hls.ts` → `test/core/nico/hls.test.ts`)。
- 録画コアの変更は `npx tsx scripts/record.ts <lv番号> 30 ./recordings` で実放送に対して確認する。
- Electron 全体は `--remote-debugging-port` 付きで起動し、CDP から `window.api.*` を呼んで確認できる。
- ログインが必要な経路 (push 登録、フォロー中番組のポーリング、フォロー状態確認) はエージェントでは検証できない。変更したら人間側の確認を依頼する。

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
- パッケージ版は `info` 以上だけをウィンドウのログとファイルに出す。
