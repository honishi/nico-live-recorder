# 同梱 FFmpeg のビルドと再配布

issue #33。アプリ本体の MIT ライセンスと、別プロセスで実行する FFmpeg / ffprobe の LGPL-2.1-or-later を分けて扱います。録画・復号機能そのものの法的評価は対象外です。

## 選定

| 方法                                 | 判断                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 従来の `ffmpeg-static@5.3.0`         | 手元の macOS arm64 実体 (FFmpeg 6.0) が `--enable-nonfree` を含み、`-L` が再配布不可を表示したため廃止。従来の Windows 実体については未調査です。      |
| 第三者配布の LGPL バイナリ           | バイナリごとの構成、正確な対応ソース、外部ライブラリ、macOS / Windows の提供範囲を継続管理する必要があります。今回の用途には機能が多いため不採用です。 |
| **公式ソースから用途を絞ってビルド** | **採用**。両 OS で同じバージョンと機能を指定でき、使用したソースそのものを同梱できます。                                                               |

FFmpeg **8.0.3** の公式リリースアーカイブを使います。固定 URL と SHA-256 は `scripts/ffmpeg/source.json`、configure 引数は `scripts/ffmpeg/config.mjs` が正です。バイナリの「最新版」を自動取得する処理はありません。

GPL、nonfree、version3、外部ライブラリの自動検出、ネットワーク、エンコーダを無効にします。fMP4 / MPEG-TS / H.264 / AAC の解析、ファイル・パイプ入出力、MPEG-TS 出力、必要な bitstream filter を有効にします。H.264 / AAC デコーダはストリーム情報の解析と検証に使います。録画の引数は従来どおり `-c copy` です。

## 許諾条件と同梱物

[FFmpeg 公式のライセンス解説](https://ffmpeg.org/legal.html)、採用版の `LICENSE.md` と `COPYING.LGPLv2.1` を確認したうえで、LGPL 2.1 第 4 条の「実行形式に完全な対応ソースを添付する」方法を採ります。上流へのリンクのみ、後日のソース請求への対応、取得期限のある CI artifact には依存しません。

`resources/ffmpeg` (macOS では `.app/Contents/Resources/ffmpeg`) に以下をまとめて置きます。アプリの設定「情報」→「FFmpeg のライセンス・ソース」で参照できます。

| 同梱物                                                               | 目的                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ffmpeg` / `ffmpeg.exe`                                              | 録画の多重化。アプリとリンクせず子プロセスとして実行                                                     |
| `ffprobe` / `ffprobe.exe`                                            | ストリーム、パケット、映像・音声の検証                                                                   |
| `COPYING.LGPLv2.1`                                                   | 採用版のライセンス本文を無改変で同梱                                                                     |
| `LICENSE.md`                                                         | 上流のライセンス説明を無改変で同梱 (無効な GPL 機能の説明も含む)                                         |
| `NOTICE.txt`                                                         | FFmpeg 開発者の著作権表示、適用ライセンス、免責、ソースの所在、差し替え方法、商標                        |
| `source/ffmpeg-8.0.3.tar.xz`                                         | 実際にビルドした無変更の完全な公式ソース。個別ファイルの著作権表示・MIT/BSD 等の許諾文も保持             |
| `source/packaging/`                                                  | 実際に使ったビルドスクリプト、固定ソース情報とスクリプトの MIT 許諾文                                    |
| `source/rebuild.sh`                                                  | 実行した configure 引数と make による再ビルド手順                                                        |
| `source/config.h`, `config_components.h`, `config.mak`, `config.log` | 実際に生成された構成と検出ログ                                                                           |
| `source/toolchain.txt`                                               | コンパイラ、make、macOS SDK または MSYS2 パッケージの版                                                  |
| `source/*.license.txt`, `*.buildconf.txt`                            | ビルドした実体の `-L` / `-buildconf` 出力                                                                |
| `toolchain-licenses/` (Windows)                                      | MinGW-w64 CRT / headers / winpthreads の許諾文と、GCC ランタイムの GPLv3 + Runtime Library Exception 3.1 |
| `manifest.json`                                                      | ソース・構成・OS/CPU・全同梱ファイルの SHA-256                                                           |

FFmpeg のソース変更はありません。独立したアプリ本体の MIT 許諾は FFmpeg の改変・再配布等の権利を制限しません。自分で再ビルドした FFmpeg への置換、または `NICO_FFMPEG_PATH` での指定を維持しています。

Windows は MSYS2 **UCRT64** の GCC で通常のコンパイルを行い、GCC ランタイムは Runtime Library Exception 3.1 の対象として扱います (GCC プラグイン等による非適格なコンパイルはしません)。FFmpeg ライブラリとコンパイラランタイムは静的にリンクし、Windows 標準の UCRT / システム DLL を利用します。ツールチェーンの例外・著作権表示はインストールしたパッケージからコピーします。macOS は Apple Clang とシステムライブラリを使用します。

## ビルド

macOS arm64 では Xcode Command Line Tools (clang / make) が必要です。Windows x64 では MSYS2 UCRT64 シェルを使い、Windows 用 Node.js を PATH に含めます。

```bash
# Windows のみ、MSYS2 UCRT64 シェルで事前に実行
pacman -S --needed make diffutils mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-winpthreads

# 以下は両 OS 共通。リポジトリ直下で実行
npm ci
npm run ffmpeg:build
npm run ffmpeg:verify
npm run package:mac  # macOS arm64 上
npm run package:win  # Windows x64 上
```

ビルド出力は `resources/ffmpeg/<platform>-<arch>/`、取得したソースと作業領域は `.cache/ffmpeg/` に置きます。どちらも Git 対象外です。毎回未変更のソースアーカイブからビルドします。失敗したビルドは作業領域を残すので、`ffbuild/config.log` を参照できます。Linux x64 でも開発用ビルドは可能ですが、配布対象には含めません。

ソース同梱物だけから再ビルドするときは、同じ OS/CPU と `toolchain.txt` に記載されたツールを用意し、`source/` 内で `bash rebuild.sh` を実行します。`packaging/` にはリポジトリで使用した元スクリプトも保管しますが、単独の再ビルドには `rebuild.sh` を使用してください。Node.js とこのリポジトリは不要です。ツールの版は記録しますが、バイト単位で同一になるビルドは保証しません。

## 検証とリリースの条件

`npm run ffmpeg:verify -- <FFmpeg の同梱ディレクトリ>` は次を検証します。

- OS/CPU と固定ソース、configure 引数、全ファイルの SHA-256、必須資料の存在。
- ソースアーカイブ内の LGPL 本文と、別ファイルで同梱した本文の一致。
- 記録済みの表示だけでなく、FFmpeg / ffprobe 実体の `-L` / `-buildconf` / `-version`。GPL / nonfree / version3 が有効、または LGPL 2.1 の表示がない場合は失敗。
- macOS の外部 dylib 依存がシステムライブラリだけであること。Windows のツールチェーン DLL が PATH にない状態でも起動できること。
- 合成した H.264 / AAC の fMP4 を本番の `FfmpegMuxer` の fd3 / fd4 に渡して終了すること。音声分離と音声込みの両方を確認。
- 出力の MPEG-TS 同期バイト・パケット長、映像・音声のコーデック、入力に対応するパケット数とタイムスタンプ。

electron-builder の `afterPack` でもこの検証を必ず行います。開発ディレクトリではなく、`.app` / `win-unpacked` の Resources にコピーされた実体を検証します。資料欠落、異なる CPU/OS、旧バイナリ混入、多重化失敗でパッケージ作成を止めます。ホストと異なる OS/CPU へのクロスパッケージングは受け付けません。`NICO_FFMPEG_PATH` でこのゲートを回避することはできません。

macOS の署名時は、FFmpeg / ffprobe の署名を検証してから、パッケージ内の manifest の両バイナリのハッシュだけを更新します。その後アプリ全体を署名するため、署名済み成果物にも同じハッシュ検証を適用できます。順序とローカル検証の手順は [mac-signing.md](mac-signing.md) を参照してください。

PR の CI とタグの Release の両方で、macOS arm64 と Windows x64 それぞれのネイティブランナーを使用します。Windows の実行結果は Windows ジョブで確認し、macOS の成功だけで検証済みとは扱いません。

Release の説明には FFmpeg のライセンスと同梱ソースの所在を載せます。`npm run ffmpeg:verify-artifacts` で配布用 DMG / ZIP / NSIS インストーラを一時領域へ展開し、同じ検証を再実行します (Windows は 7-Zip が必要です)。Release はこれも成功してから下書きに添付します。下書き公開前に両 OS の成功を確認してください。古い `ffmpeg-static` 入り成果物を同じリリースに残さないでください。将来別サイトで配布するときも、配布ページに FFmpeg とライセンス・ソースの所在を表示します。

本家の macOS Release では `--require-notarization` を付け、展開したアプリと FFmpeg / ffprobe の署名、公証チケット、Gatekeeper の受け入れ判定も必須にします。検証する署名元は `APPLE_TEAM_ID` で指定します。通常の CI / fork はこのオプションを付けず、未署名で従来の FFmpeg 検証を行います。

バージョン更新時は公式アーカイブとハッシュを確認して固定値を更新し、許諾文、configure、外部ランタイム、両 OS のパッケージと実放送録画を再確認します。ソースを改変する場合は改変内容と日付を明示し、その変更を含む完全な対応ソースとビルドスクリプトを配布する必要があります。

## 参考

- [FFmpeg 8.0.3 の LICENSE.md](https://github.com/FFmpeg/FFmpeg/blob/n8.0.3/LICENSE.md)
- [FFmpeg 8.0.3 の COPYING.LGPLv2.1](https://github.com/FFmpeg/FFmpeg/blob/n8.0.3/COPYING.LGPLv2.1)
- [FFmpeg 8.0.3 の configure](https://github.com/FFmpeg/FFmpeg/blob/n8.0.3/configure)
- [FFmpeg の公式リリース一覧](https://ffmpeg.org/releases/)
- [BtbN/FFmpeg-Builds (第三者ビルドの比較)](https://github.com/BtbN/FFmpeg-Builds)
- [MSYS2 GCC ランタイムのパッケージ情報](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-gcc-libs)
- [MSYS2 MinGW-w64 CRT のパッケージ情報](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-crt)

## この変更のローカル検証記録 (2026-09-06)

macOS arm64 で、ビルドした FFmpeg / ffprobe、パッケージ内の実体、ZIP と DMG から展開した実体のライセンス・ソース・多重化検証が通りました。隔離した `NLR_USER_DATA` / `NLR_OUTPUT_DIR` でパッケージ版を起動し、同梱パスを解決することとライセンス用 preload API の存在も CDP で確認しました。

パッケージ内の FFmpeg を指定して `scripts/record.ts lv351328853 30 ./.cache/ffmpeg/live-recordings` を実行し、映像 14 セグメント・音声を保存、FFmpeg 終了コード 0、録画エラーなしを確認しました。検証データは `.cache/ffmpeg/` に隔離しています。

Windows バイナリのビルド・実行と NSIS 展開検証はローカルでは未実行です。上記 CI / Release の Windows ジョブで確認する必要があります。macOS の検証結果を Windows の検証結果として扱いません。
