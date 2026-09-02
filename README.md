# nico-live-recorder

ニコニコ生放送の放送開始を検知して、映像 (MPEG-TS) とコメント (JSON Lines) を自動録画する Electron アプリです。
Windows と macOS で動作します。streamlink は使わず、ffmpeg だけを同梱します。

## 仕組み

```
放送開始の検知
  ├─ Web Push (Mozilla AutoPush 経由、ニコニコの push 通知を購読)   ... 主
  └─ フォロー中番組 API の 30 秒ポーリング                          ... 副 (取りこぼし防止)
        ↓ 対象配信者の放送なら
録画
  ├─ 視聴 WebSocket (startWatching) → HLS の URI と cookie を取得
  ├─ 映像・音声の playlist を追跡し、セグメントを取得して AES-128 を復号
  ├─ ffmpeg に 2 本のパイプで渡し、1 本の .ts に多重化
  └─ NDGR からコメントを受信し .comments.jsonl に追記
```

- push 通知は **ログイン中のアカウントがフォローしている配信者** の放送開始にだけ届きます。録画したい配信者はニコニコ側でフォローしておいてください。アプリはフォロー状態の確認だけを行い、フォロー操作はしません。
- HLS を ffmpeg に直接渡さないのは、ニコニコが同名の CloudFront cookie をパス別に複数配るためです (ffmpeg の cookie 管理は名前単位で、正しく送れません)。
- 放送検知の実装は [chrome-nico-alert](https://github.com/honishi/chrome-nico-alert)、コメント取得は stream-journal の nico-client を元にしています。

## 出力ファイル

`保存先/配信者名/日時_lv番号_タイトル.*`

| ファイル          | 内容                                                   |
| ----------------- | ------------------------------------------------------ |
| `.ts`             | 映像 + 音声 (h264 / AAC, 最高画質)                     |
| `.comments.jsonl` | コメント。1 行 1 件の JSON (投稿時刻, vpos, 本文 など) |
| `.json`           | 番組情報と録画結果のメタデータ                         |

## 開発

```bash
npm install
npm run dev          # electron-vite の開発モードで起動
npm run typecheck
npm test             # vitest
npm run build        # out/ に成果物を出力
```

Electron を起動せずに録画部分だけを試すスクリプトもあります。

```bash
npx tsx scripts/record.ts lv123456789 30 ./recordings      # 30 秒だけ録画
npx tsx scripts/record-comments.ts                          # コメント取得のみ
NICO_USER_SESSION=... npx tsx scripts/push-listen.ts        # push 購読の疎通確認
```

### コード構成

```
src/main/core/nico/        視聴 WebSocket、HLS 取得・復号、ffmpeg 多重化、フォロー中番組 API
src/main/core/recorder/    映像録画・コメント録画・番組単位の録画まとめ
src/main/core/detector/    push + ポーリングの放送検知
src/main/push/             AutoPush クライアント、RFC8291 復号、購読管理 (chrome-nico-alert 由来)
src/main/nico-client/      NDGR コメントクライアント (stream-journal 由来)
src/main/app/              Electron 側: 設定、ログイン、録画マネージャ、トレイ、IPC
src/renderer/              React の設定ウィンドウ
resources/proto/           NDGR の protobuf 定義
```

## パッケージング

```bash
npm run package:mac   # release/ に dmg / zip
npm run package:win   # release/ に nsis インストーラ
```

ffmpeg は `ffmpeg-static` から取り込みます。この npm パッケージはインストール時に実行環境向けのバイナリだけを取得するため、別プラットフォーム向けにビルドする場合は次のように対象を指定して `npm install` し直してください。

```bash
npm_config_platform=win32 npm_config_arch=x64 npm install
```

## ライセンス

MIT。同梱する ffmpeg のライセンス (GPL) は `ffmpeg-static` の配布物に従います。
