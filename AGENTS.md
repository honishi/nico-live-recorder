# AGENTS.md

nico-live-recorder (ニコ生自動録画の Electron アプリ) で作業するときの規約。
仕組みやコード構成は [README.md](README.md) を参照すること。

## ブランチとマージ

- 新機能の実装は必ずブランチを作って行う。ブランチ名は `do-something-cool` のようにハイフン区切り。
- マージは `git merge --no-ff` で行い、マージコミットを残す。

## コミットメッセージ

- Angular の conventional commit 形式 (`feat(scope): subject`) に準拠する。
- 英語で簡潔に書く。

## コードコメント

- 読者の理解を助けるためのコメントを日本語で書く。
- コードを目で追うときのひとかたまりの処理ごとにコメントを付け、上から自然に読める状態にする。
