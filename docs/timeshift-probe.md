# タイムシフト検証スクリプト

技術検証は2026-09-08に完了しました。結論と本体実装へ引き継ぐ範囲は [検証結果と初期対応範囲](timeshift-feasibility.md) を参照してください。この文書は検証の再現手順・観測履歴として残します。

終了済み放送の視聴接続、映像・音声の短区間／全プレイリスト保存、過去コメントの取得方式を確認するための開発用スクリプトです。本体のタイムシフト実装とは別の検証用処理を使います。Electron の起動やアプリの保存済みセッションは不要です。

この版は全編取得の検証にも対応します。欠落のない途中再開、視聴予約・購入は行いません。提供されたデータの取得完了と、番組全体の完全性・音声同期の確認は分けて扱います。

## 準備

リポジトリ直下で実行します。依存パッケージは `npm ci`、映像保存に必要な同梱 FFmpeg は `npm run ffmpeg:build` で用意します。接続確認とコメント取得には FFmpeg は不要です。

最初は短い、タイムシフト公開中の通常のユーザー放送を一つ選んでください。次の条件を各アカウントについて控え、同じ番組で実行します。

| 条件               | 記録する内容                                                  |
| ------------------ | ------------------------------------------------------------- |
| アカウント         | 匿名・一般会員・プレミアム会員。チャンネル会員資格は別に記録  |
| 番組側の条件       | 予約の有無、チケット購入の有無、公開期限など                  |
| 公式サイトでの結果 | 同じアカウントで再生できるか、確認した日時                    |
| 実行ラベル         | `anonymous`、`standard-unreserved`、`premium-unreserved` など |

これらは視聴条件を決めつけるためではなく、アカウント間の結果の違いを切り分けるための記録です。スクリプトは会員種別を推測しません。`loginObserved` も視聴ページの `user.isLoggedIn` が真偽値として提供された場合だけ記録し、存在しなければ `unknown` とします。`credentialInput: session` は認証成功を意味しません。

## セッションの入力

Cookie の `user_session` の**値だけ**を `NICO_USER_SESSION` に設定します。Cookie 全体や `user_session=` は含めません。セッションをコマンド引数、コード、結果ファイルへ書かないでください。

macOS の zsh では、次の入力方法で画面表示とシェル履歴への値の記録を避けられます。

```zsh
read -rs 'NICO_USER_SESSION?user_session: '
printf '\n'
export NICO_USER_SESSION
```

アカウントを切り替えるときは同じ操作で上書きし、終了後は `unset NICO_USER_SESSION` を実行します。セッションをチャットへ貼る必要はありません。

`--anonymous` を付けた実行では、環境変数が残っていても Cookie を送信しません。環境変数も `--anonymous` もない実行は、意図せず匿名で調べないよう通信前に終了します。

## 1. 接続条件の比較

以下の `lv123456789` は、選んだ終了済み番組の ID に置き換えます。

```bash
npx tsx scripts/timeshift-probe.ts lv123456789 --anonymous --label anonymous
npx tsx scripts/timeshift-probe.ts lv123456789 --label standard-unreserved
```

二つ目は一般会員のセッションを設定した状態で実行します。続けてプレミアム会員のセッションへ切り替え、`--label premium-unreserved` で実行します。

既定の `inspect` モードは番組情報と視聴 WebSocket の接続情報まで取得します。動画・コメント本文は保存しませんが、`startWatching` による視聴接続は行います。視聴ページで公開状態が `Open` でも、それだけで当該アカウントの視聴可能性を確定しません。

`page.status`、`page.loginObserved`、`websocket.hasHls`、`websocket.hasComments`、`websocket.serverCodes` を比較してください。接続情報は最大15秒観測し、片方だけなら `partial-or-unavailable` です。サーバーの列挙形式のエラーコードだけを保存し、自由文・認証 Cookie・署名付き URL は記録しません。

## 2. 短区間の映像・音声

接続できたセッションで実行します。

```bash
npx tsx scripts/timeshift-probe.ts lv123456789 --mode video --label premium-unreserved --media-seconds 30
```

`--media-seconds` は初回 playlist の先頭から選ぶ**メディア上の秒数**です。取得に使う実時間ではありません。セグメント境界へ切り上げ、映像・音声でそれぞれ選ぶため、実際の選択時間には差が出ることがあります。初回 playlist が番組の先頭を含むかは、この段階では保証しません。

既存の HLS ダウンローダー・復号・FFmpeg 多重化を再利用します。検証側で短区間の playlist を固定し、終了マーカーを追加します。`originalEndList` は元の playlist にあった終了マーカー、`selectedDuration` は選択区間の長さです。合成した終了マーカーを全編取得の証拠にしません。

404 で読み飛ばされたセグメント、保存予定数と実績の不一致、0セグメントの保存は `incomplete` になります。`/blank/` の除外件数も残します。取得する短区間に BYTERANGE・GAP、または保存する本編の途中に DISCONTINUITY が含まれる場合は `UNSUPPORTED_PLAYLIST_TAG` として止めます。取得対象より後のタグや、不連続境界そのものではない DISCONTINUITY-SEQUENCE だけでは止めません。403 を含む途中エラーでの認証更新・自動再開は行いません。

`schemaVersion: 3` 以降は、先頭がすべて `/blank/` で、その直後の最初の本編へ移る DISCONTINUITY だけを許可します。blank の映像・初期化情報は既存ダウンローダーで除外し、本編の初期化情報を取得します。セグメントの番号と暗号鍵情報は変更せず、暗黙 IV の復号位置を保ちます。本編を一度保存した後の不連続は引き続き拒否します。`leadingBlankSegments` は先頭 blank 数、`leadingBlankBoundaryCount` は許可した境界数、`savedDuration` は blank を除く保存予定のメディア長です。

`schemaVersion: 2` 以降は、拒否した場合にも両トラックの `video.tracks` に診断を残します。`tags.counts` は元の playlist 全体のタグ数、`selectedTagCounts` は取得区間のタグ数、`unsupportedTags` は実際に拒否したタグ名です。`tags.firstUnsupportedPositions` は最初の20箇所について、0始まりのセグメント位置と playlist の先頭からの秒数を示します。タグの URI・属性値は保存しません。初版では DISCONTINUITY-SEQUENCE を DISCONTINUITY と誤認し、取得範囲外のタグでも停止していたため、旧レポートのエラーだけでは原因タグを特定できません。

出力の `video.ts` を再生し、映像と音声があるか、音声がずれていないかを確認してください。FFmpeg の終了コードが0でも、人間による再生確認は別に必要です。

## 3. コメントのサンプル

```bash
npx tsx scripts/timeshift-probe.ts lv123456789 --mode comments --label premium-unreserved --comment-limit 1000
```

NDGR View 応答から backward・previous・segment・next を観測し、backward の履歴を辿った後、previous / segment のコメントを取得します。初回に next しかなければ、サーバーが返した `next.at` で入口を探します。重複を除去し、取得終了時に投稿時刻の昇順へソートして `comments.jsonl` に保存します。同時刻はコメント番号順、さらに同じなら取得順です。時刻がないコメントは末尾へ置きます。ソートは元の秒・ナノ秒で行い、出力の `at` はミリ秒精度です。途中失敗・Ctrl-C でも取得済み分をソートします（強制終了や保存先の障害を除く）。本文を含むため、このファイルはローカル確認用です。投稿者情報は保存しません。

上限は既定1000コメント、PackedSegment 20ページ、総受信量16MiBです。巡回 URI の循環と実行時間上限でも止めます。件数が少なくても、提供された履歴が尽きたか、通信や上限で中断したかを区別します。`historyExhausted` は backward の巡回終了を表し、番組全体のコメントが揃った保証ではありません。番組ページのコメント数との一致だけでも完全性は判断できません。

最初の View リクエストは `at=now` です。`schemaVersion: 3` 以降は、next しかない応答からはその `next.at` を辿ります。View 要求は既定3回、`--view-pages` で1〜10回を指定できます。データの入口が見つかる、カーソルが循環する、次のカーソルがない、または上限に達した時点で探索を終えます。1を指定すると以前の「初回応答だけ」の検証を再現できます。

これは [N Air の NDGR クライアント](https://github.com/n-air-app/n-air-app/blob/n-air_development/app/services/nicolive-program/NdgrClient.ts) が `now` から `entry.next.at` を辿る処理を参考にしています。検証では無限にポーリングせず、回数・バイト数・実行時間の上限を適用します。

比較用の `--view-at beginning` は `at` を省略しますが、今回の実サービス検証では HTTP 400 でした。先頭から取得する方法としては扱いません。受信 URI にもともと `at` があれば削除する挙動は、比較の再現用に残しています。

`comments.requestedAt` は初回の指定（省略は `omitted`）、`viewEntries` は全要求で受信した種類別の件数、`nextAt` は最後に返された数値カーソルを文字列のまま保存したものです。`viewRequests` には各要求の指定値・返された次の位置・エントリー数を残します。特定位置を試すには `--view-at 数値` を使います。カーソルは整数のまま引き継ぎ、日時への変換や丸めは行いません。視聴接続の更新はまだ行いません。`schemaVersion: 4` 以降の `sortOrder: at-then-no` は、取得済みコメントのソートが完了したことを示します。

```bash
npx tsx scripts/timeshift-probe.ts lv123456789 --mode comments --label premium-unreserved --view-at now --view-pages 3
```

## 4. 全編・コメント履歴の終端まで取得

短区間の再生を確認できたセッションで、映像とコメントをそれぞれ実行します。以下は今回の検証番組です。

```bash
npx tsx scripts/timeshift-probe.ts lv351334237 --mode video --full --label premium
npx tsx scripts/timeshift-probe.ts lv351334237 --mode comments --full --label premium
```

`--full` は video / comments 用です。短区間の `--media-seconds` と併用できません。全編モードの既定実行時間上限は1800秒（30分）で、`--timeout` で最大7200秒に変更できます。これは放送の長さではなく取得処理の実時間です。映像は選択した最高品質で取得し、番組の長さ・品質に応じた保存容量を使います。

映像は、映像・音声の両方について元の playlist に ENDLIST があることを要求し、含まれる全セグメントを選択します。保存予定数と実績が一致し、欠落がなく、FFmpeg が正常終了した場合は `playlist-saved` / `video.playlistCoverage: complete` です。冒頭 blank の除外は短区間と同じで、本編中の不連続・未対応タグがあれば停止します。元の ENDLIST がなければ `ORIGINAL_ENDLIST_MISSING` です。

この判定は提供された playlist の取得完了を示します。番組先頭が含まれていることや再生品質まで保証しません。`playlistDuration` と番組の `endTime - beginTime` を比較し、`video.ts` の冒頭・中間・末尾を再生して、映像と音声、音ずれ、再生時間を確認してください。今回の番組は約2時間17分32秒です。

コメントは backward のリンクがなくなるまで辿り、取得時点の View が提供した previous / segment も読み切ります。全編モードの上限は既定20万件、PackedSegment 2000ページ、総受信量128MiBです。件数上限は `--comment-limit` で20万件まで指定できます。上限・循環・失敗による停止は完了と区別します。件数がちょうど上限に達した場合も保守的に未完了とします。

最後の View の next マーカーまで観測し、backward の終端と提供された直近セグメントをすべて読み切った場合は `history-saved` / `comments.snapshotCoverage: complete` です。これは取得時点で提供された履歴の取得完了であり、放送全体の全コメントが揃った保証ではありません。データ入口が見つかった後の View の継続ポーリングや、その後に投稿されたコメントは対象外です。`forwardSegments` は提供された参照数、`completedForwardSegments` は実際に読み切った数です。

`fullCoverage` は引き続き `not-verified` とし、番組全体の完全性を断定しません。映像とコメントは別実行のため、今回確認するのはそれぞれの取得範囲です。コメントと動画の再生位置の対応は別途検証します。

### 工程別の時間

`schemaVersion: 4` 以降は `timingsMs` にミリ秒単位で記録します。

- レポート直下: `page`、`websocket`、`video` または `comments`、`total`
- `video.timingsMs`: `master`、各トラックの `Playlist` / `Download`、`muxerFinish`
- `comments.timingsMs`: `view`、`backward`、`forward`、`sortAndSave`

コメントの `view` は複数回の応答待ちと読み取りを含みます。これにより、前回約19.5秒かかった処理が View 待ちか履歴取得かを切り分けられます。各工程は通信・デコード・その中の書き込みを含む経過時間で、純粋なネットワーク時間ではありません。動画の両トラックは並行するため、内訳の合計は全体時間と一致しません。

## 5. 動画の取得速度を比較する

`schemaVersion: 5` 以降は `--segment-threads 1`〜`5` で、検証専用の先読みダウンローダーへ切り替えられます。video モード専用です。未指定では、これまで通り既存の `HlsTrackDownloader` を使います。`video.engine` は未指定で `core`、指定時は `probe-prefetch` です。

同じセッション・番組で、まず1並列、次に5並列を実行します。

```bash
npx tsx scripts/timeshift-probe.ts lv351334237 --mode video --full --label premium-t1 --segment-threads 1
npx tsx scripts/timeshift-probe.ts lv351334237 --mode video --full --label premium-t5 --segment-threads 5
```

どちらも映像と音声は並行し、指定数は**各トラックの先読み件数**です。5ならセグメント取得は映像・音声それぞれ最大5件です。取得が逆順に終わっても、復号と書き込みは元のセグメント番号順に行います。1の場合も、出力を待つ間に次の1件を先読みするため、従来方式とは異なります。

先読みは指定件数＋出力中1件までで、番組全体をメモリに保持しません。1リソース（セグメント・初期化情報・鍵）の受信上限は32MiBです。これに鍵・初期化情報の小さな件数制限付きキャッシュと、復号・出力用の一時バッファが加わります。Streamlink の64MiBリングバッファと同一の構造ではありません。

blank の除外、元の番号による AES-128 の暗黙 IV、明示 IV、鍵・初期化情報の切り替えを扱います。取得失敗時は最大4回試行しますが、403・404は再試行しません。セグメントの404は欠落として数え、初期化情報や鍵の404は失敗として停止します。途中失敗・中断では先読み中の要求を中止します。この先読み処理は検証用です。

検証用ダウンローダーでは `video.tracks[].download` に要求数・最大同時要求数・受信バイト数・HTTPエラーと以下の `timingsMs` を残します。従来方式にこの内訳はありません。

| 項目          | 意味                                                                             |
| ------------- | -------------------------------------------------------------------------------- |
| `fetch`       | 全HTTP要求の開始から本文読み取り完了までの累積時間。鍵・初期化情報・再試行を含む |
| `retryWait`   | 再試行までの待機時間の合計                                                       |
| `orderedWait` | 次に出力すべきセグメントの取得完了を待った時間の合計                             |
| `decrypt`     | AES復号に使った時間の合計                                                        |
| `write`       | FFmpegへの書き込み処理と待機時間の合計                                           |
| `drainWait`   | `write` のうち、出力パイプが空くのを待った時間                                   |

`fetch` は並列要求の時間を足すため、全体の実時間を超えることがあります。`orderedWait` は `fetch` と、`drainWait` は `write` と重複するので、これらを足して全体時間と比較しないでください。FFmpegは取得中にも動くため、`muxerFinish` だけをFFmpegの処理時間とは扱いません。実時間の比較にはレポート直下の `timingsMs.total` とトラックの `videoDownload` / `audioDownload` を使います。

速度に加えて、両方の結果の `playlistCoverage`、欠落数、保存セグメント数を比較し、冒頭・中間・末尾の再生と音声同期も再確認してください。通信状況による変動があるため、必要なら実行順を入れ替えて比較します。

## 結果と制限

出力先は既定で `.cache/timeshift-probe/` 配下の実行ごとに異なるディレクトリです。既存の録画・検証結果を上書きしません。`--out` で変更できます。アプリの設定や本番録画先は読み書きしません。

共有・比較には **`report.json`** を使用してください。実行条件・番組の状態・段階ごとの結果・失敗理由が含まれ、Cookie、トークン付き URL、コメント本文は含みません。予期しない例外の本文も保存せず `UNEXPECTED_ERROR` とします。その場合は再現条件と失敗段階から、必要な観測項目を追加します。

| 結果                                 | 意味                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| `connection-observed`                | HLS とコメントの両接続情報を受信。内容の取得成功ではない       |
| `sample-saved`                       | 指定範囲のサンプルを保存。全編・全件取得の保証ではない         |
| `playlist-saved`                     | 元の ENDLIST を含む選択プレイリストの保存が完了                |
| `history-saved`                      | 取得時点で提供されたコメント履歴を読み切った                   |
| `partial-or-unavailable`             | 接続情報の一部または全部が得られなかった                       |
| `incomplete`                         | 映像の欠落、または全編モードのコメントが上限・循環などで未完了 |
| `no-comments-observed`               | コメントを観測しなかった。取得方式が正しいという保証ではない   |
| `timeout` / `interrupted` / `failed` | 時間上限・Ctrl-C・エラー。部分ファイルが残ることがある         |

終了コードは接続情報の受信・サンプル保存・playlist-saved・history-saved で0、検証が不完全／失敗なら2、入力・初期化・結果保存の問題は1です。既定の実行時間上限は短区間120秒・全編1800秒、`--timeout` で最大7200秒まで変更できます。タイムアウトはデータ取得の上限で、終了後にファイル・プロセスの後始末を行います。

初回の全編保存・コメント履歴の終端判定の技術検証は完了しています。別番組や一般会員の予約済みケースなど、追加条件の検証にも利用できますが、失敗時の途中再開はこのスクリプトでは行いません。スクリプト側だけが失敗する条件では、同じ番組とセッションで streamlink の結果と比較します。

## ユーザー実行で得られた観測（2026-09-08）

対象は `lv351334237`、タイムシフトの公開状態は `Open`、両セッションともページ上のログイン認識は成功しました。

| 条件・モード                                   | 観測結果                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 一般会員・事前予約なし / inspect               | 視聴 WebSocket URL なし。公式サイトでも視聴不可との確認あり                                                                |
| プレミアム会員 / inspect                       | タイムシフト用 WebSocket で HLS・コメント両方の接続情報を受信                                                              |
| プレミアム会員 / video（初版）                 | `UNSUPPORTED_PLAYLIST_TAG` で停止。実際の原因タグは未確認                                                                  |
| プレミアム会員 / comments、at=now              | 9バイトの応答、next のみ、コメント0件。過去コメントの不存在を示すものではない                                              |
| プレミアム会員 / video（version 2）            | 映像・音声とも1377セグメント、約8252秒、元の ENDLIST あり。冒頭に blank 1個、その直後約1秒地点に DISCONTINUITY 1個あり停止 |
| プレミアム会員 / comments、at省略（version 2） | View API が HTTP 400。protobuf を読む前に拒否                                                                              |
| プレミアム会員 / video（version 3）            | 映像・音声各5セグメント、欠落0で約30秒を保存。ユーザーが正常再生・目立つ音ずれなし・約30秒の再生を確認                     |
| プレミアム会員 / comments（version 3）         | backward 3ページから1000件を保存、重複0。全工程19.493秒。件数上限で停止し履歴終端は未確認                                  |

一般会員の予約済みケースはまだ未確認です。全編検証の結果は以下に記録しています。会員種別の一般的な視聴条件を、この1番組の結果だけで確定しません。

### 全編検証と速度比較の観測

- video（version 4）: 元の1377セグメントから冒頭blank 1個を除き、映像・音声とも1376個を保存。欠落0、出力約1.94GiB。ユーザーが開始から終了まで正常に保存できたことを確認。全工程156.621秒、映像取得・書き込み155.787秒、音声155.666秒。
- Streamlink（同じ番組・ユーザー実行）: 5並列・64MiBリングバッファで42秒、1並列・同じバッファで121秒。どちらも表示上の出力は1.94GiB。実行時刻は異なるため、速度差のすべてを並列数だけに帰属させない。
- comments（version 4）: 1806件、重複0、backward 4ページの終端と直近4セグメントを読み切り、`snapshotCoverage: complete`、投稿時刻順へのソート完了。全工程24.862秒。View 17.864秒、過去履歴0.534秒、直近分5.721秒、ソート・保存0.007秒。番組全体のコメント完全性と動画上の表示位置の対応は未検証。

## アプリ本体との違い

検証スクリプトは本体の機能をすべて再現するものではありません。本体は各トラック5並列を固定し、条件付きで本編同士の不連続境界も検証して通過させ、コメントを14列のCSVへ保存します。コメントViewの1要求上限も本体は60秒、検証スクリプトは共通HTTP処理の20秒です。本体の履歴・通知・推定残り時間・空の予約ファイル整理は、このスクリプトの対象外です。本体の調査には [組み込み設計](timeshift-recording-design.md) と [出力ファイル仕様](files.md) を参照してください。
