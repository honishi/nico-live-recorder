# macOS の署名と公証

GitHub Releases で配布する DMG / ZIP 向けの Developer ID 署名を使います。
Bundle ID は `com.honishi.nico-live-recorder`、表示名は `NicoLiveRecorder` です。

## リリース CI

本家リポジトリの Release ワークフローでは、macOS のビルドステップにだけ署名・公証用の Secrets を渡します。
認証情報の不足、署名失敗、公証失敗、成果物検証の失敗はエラーにし、未署名のままリリースに添付しません。
Windows と fork の Release、および通常の PR / main の CI は署名なしでパッケージを検証します。
各 OS のジョブの上限は60分です。

`v*` タグの push では、検証に通った DMG / ZIP / NSIS を下書きリリースに添付します。
`workflow_dispatch` による手動実行では同じビルド・検証を行い、成果物を Actions の artifact に7日間保存します。手動実行では GitHub Release を作成しません。
Actions の「Release」→「Run workflow」で対象ブランチを選ぶか、次のコマンドで実行できます。

```bash
gh workflow run release.yml --ref <検証するブランチ>
```

ローカル実行では electron-builder が認証情報なしの公証をスキップするため、署名済みというだけで配布可能とは扱わないでください。

## 署名の順序

1. `afterPack` で、コピー済み FFmpeg の全ファイルのハッシュ・資料・多重化動作を検証します。
2. `scripts/mac/sign.mjs` が、electron-builder の選んだ証明書とキーチェーンを使って `@electron/osx-sign` を実行します。
3. FFmpeg / ffprobe を含む内側のコードを署名します。
4. アプリ全体を署名する直前に、両バイナリの署名を検証し、同梱 `manifest.json` の両バイナリの SHA-256 だけを更新します。資料のハッシュは変更せず、不一致なら失敗します。
5. アプリ全体を署名します。これ以降は manifest を書き換えません。認証情報があれば続けて公証とチケットの添付が行われます。

署名で実行ファイルの内容が変わるため、この順序が必要です。ビルド元の `resources/ffmpeg/` は変更せず、パッケージ内のコピーだけを更新します。
署名後も既存の `ffmpeg:verify` / `ffmpeg:verify-artifacts` によるハッシュ・ライセンス・多重化検証をそのまま使えます。

Hardened Runtime を有効にし、Electron には V8 の JIT 実行権限だけを付けます。
FFmpeg / ffprobe には JIT の権限を付けません。App Sandbox は有効にしません。
`@electron/osx-sign` は Apple のタイムスタンプを付けて署名し、最後に署名全体を検証します。

## Apple 側の準備と GitHub Secrets

Apple Developer Program のアカウントで Developer ID Application 証明書を発行し、CSR を作った Mac のキーチェーンに追加します。
「自分の証明書」から対応する秘密鍵とともに `.p12` に書き出し、パスワードを設定します。
証明書・秘密鍵・パスワードはリポジトリに置きません。

| Repository secret             | 内容                                             |
| ----------------------------- | ------------------------------------------------ |
| `CSC_LINK`                    | `.p12` を Base64 に変換した文字列                |
| `CSC_KEY_PASSWORD`            | `.p12` の書き出し用パスワード                    |
| `APPLE_ID`                    | Apple Developer アカウントのメールアドレス       |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple Account で生成した公証用アプリ用パスワード |
| `APPLE_TEAM_ID`               | Developer ID Application 証明書と同じチームの ID |

GitHub Secrets はローカルのコマンドには自動的に渡りません。
アプリ用パスワードは Apple Account のパスワード変更・リセット時に無効になるため、その場合は再生成して Secrets を更新します。

## 証明書の期限と更新

### 期限の管理と影響

2026-09-06 に Mac のキーチェーンで確認した署名用証明書は次のとおりです。更新後はこの表も更新してください。

| 項目         | 値                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------- |
| 証明書名     | `Developer ID Application: Hiroyuki Onishi (N4SRN3NAQ3)`                                          |
| Team ID      | `N4SRN3NAQ3`                                                                                      |
| 発行元       | Developer ID Certification Authority（G1）                                                        |
| 有効期限     | **2027-02-02 07:12:15 JST**（2027-02-01 22:12:15 UTC）                                            |
| SHA-256 指紋 | `EB:A9:67:33:B9:48:EE:28:91:A2:05:8B:F5:49:B0:11:B2:B3:96:25:16:FD:D6:D1:28:0A:EB:6F:AA:1F:F4:2D` |

期限接近の自動通知は実装していません。運用上の目安として期限の1か月前までに更新に着手し、更新後の動作確認まで済ませます。
Apple Developer Program の会員資格は証明書とは別に更新が必要で、新しい Developer ID 証明書の発行には有効な会員資格と Account Holder の権限が必要です。

このアプリは Developer ID provisioning profile を使っていません。有効期間内にタイムスタンプ付きで署名・公証した配布版は、証明書の期限後もダウンロード・インストール・実行できます。期限切れだけを理由に既存の配布版を再署名する必要はありませんが、新しい版の署名には新しい証明書が必要です。
一方、証明書の失効（Revoke）は既存の配布版のインストール・起動にも影響します。通常の更新では古い証明書を Revoke しません。[Apple の期限・失効の説明](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)
秘密鍵の漏えい時は通常の更新とは別に、[Apple の Compromised certificates の案内](https://developer.apple.com/help/account/certificates/certificates-overview)に従って失効を依頼し、新しい証明書で配布し直します。

### 更新手順

1. Account Holder として Apple Developer の Certificates, Identifiers & Profiles を開き、同じチーム `N4SRN3NAQ3` で新しい **Developer ID Application** 証明書を発行します。キーチェーンアクセスで新しい CSR を作り、発行時にアップロードします。Developer ID Installer や Apple Development は選びません。
2. 中間証明書の選択肢があれば **G2** を選びます。現在の G1 系列は2027年に期限を迎えるため、更新時は G2 系列で発行します。新しい証明書が信頼されない場合は、[Apple の案内](https://developer.apple.com/support/developer-id-intermediate-certificate/)に従って G2 中間証明書をインストールします。G1 を使う古い証明書で署名する間は、G1 中間証明書も残します。
3. ダウンロードした `.cer` を CSR を作った Mac に読み込みます。「自分の証明書」で新しい証明書の下に秘密鍵があることを確認し、その証明書と秘密鍵をパスワード付きの `.p12` として書き出します。古い署名用証明書を一緒に選択しないでください。
4. 新しい `.cer` の Team ID（subject の OU）、期限、SHA-256 指紋を次のコマンドで確認します。後述の成果物との照合にも使います。`notAfter` は UTC（GMT）表示です。

   ```bash
   openssl x509 -inform DER -in /path/to/developerID_application.cer \
     -noout -subject -issuer -dates -fingerprint -sha256
   ```

5. GitHub のリポジトリの Settings → Secrets and variables → Actions で、`CSC_LINK` を新しい `.p12` の Base64 に、`CSC_KEY_PASSWORD` をその書き出しパスワードに更新します。次のコマンドで Base64 を画面に表示せずクリップボードへコピーできます。貼り付け後は `pbcopy < /dev/null` でクリップボードを空にします。両方の更新が終わるまで Release は実行しません。

   ```bash
   base64 -i /path/to/developer-id-application.p12 | pbcopy
   ```

6. 同じチーム・アカウントなら、`APPLE_TEAM_ID`、`APPLE_ID`、有効な `APPLE_APP_SPECIFIC_PASSWORD` は変更不要です。Bundle ID や署名コードも変更不要です。Mac のキーチェーンに新しい証明書を追加しただけでは、CI の `CSC_LINK` は更新されません。
7. 次の「更新後の確認」を実施し、このページの証明書情報と検証結果（実行 URL・確認日）を更新します。

### 更新後の確認

通常の CI は未署名なので、成功しても証明書更新の確認にはなりません。「リリース CI」の手順で **Release を手動実行**し、`Sign and notarize macOS` と `Verify notarized macOS artifacts` の成功を確認します。タグや GitHub Release の作成は不要です。

自動検証は同じチームの古い有効な証明書でも通るため、Actions の `packages-macOS` から DMG / ZIP をダウンロードし、それぞれに格納された `.app` が新しい証明書で署名されていることも確認します。次の例は署名から公開証明書だけを一時領域に取り出します。`app` を展開した `.app` のパスに置き換え、新しい `.cer` の指紋・期限と一致することを確認してください。

```bash
(
  app="/path/to/NicoLiveRecorder.app"
  cert_dir=$(mktemp -d) || exit 1
  trap 'rm "$cert_dir"/cert[0-9]*; rmdir "$cert_dir"' EXIT
  codesign --display --extract-certificates="$cert_dir/cert" "$app"
  openssl x509 -inform DER -in "$cert_dir/cert0" \
    -noout -subject -dates -fingerprint -sha256
)
```

同梱の `Contents/Resources/ffmpeg/ffmpeg` と `ffprobe` も、上の `app` に各実行ファイルのパスを指定して同じ指紋であることを確認します。最後に「ローカル検証」の設定・保存先の隔離方法に従って、ダウンロードしたアプリの起動と録画を確認します。

署名段階で失敗したら、証明書の期限、`.p12` に対応する秘密鍵が含まれるか、`CSC_KEY_PASSWORD` が一致するかを確認します。公証の認証で失敗したら、`APPLE_ID` / `APPLE_TEAM_ID` とアプリ用パスワードの有効性を確認します。証明書の更新と公証用パスワードの再発行は別の作業です。

### 保管と復旧

パスワード付き `.p12` をアクセス制限のある保管先にバックアップし、パスワードはパスワードマネージャーなどで管理します。Base64 は暗号化ではないため、`CSC_LINK` の値も秘密鍵と同様に扱います。GitHub Secrets の登録済みの値は読み戻せないので、バックアップの代わりにはしません。

CSR は発行時の申請用ファイルで、発行後の署名や公証では使いません。次回は新しい CSR を作成できるため、永続保管は必須ではありません。`.cer` は公開証明書だけで、CSR とともに保存していても秘密鍵の復元はできません。Mac を移行するときは `.p12` とパスワードで証明書・秘密鍵を取り込みます。秘密鍵も `.p12` も失った場合は、新しい CSR と証明書を作成して CI の Secrets を更新します。

## ローカル検証

署名用の証明書と秘密鍵が認識されていることを確認します。

```bash
security find-identity -v -p codesigning
```

署名だけを検証する場合は、公証を明示的に無効にして一時的な出力先へパッケージします。
`forceCodeSigning` を指定すると、署名用証明書がなければ失敗します。

```bash
npm ci
npm run ffmpeg:build
npm run build
npx electron-builder --mac --arm64 --dir --publish never \
  -c.directories.output=.cache/mac-sign-check \
  -c.mac.notarize=false -c.forceCodeSigning=true
codesign --verify --deep --strict --verbose=2 \
  .cache/mac-sign-check/mac-arm64/NicoLiveRecorder.app
npm run ffmpeg:verify -- \
  .cache/mac-sign-check/mac-arm64/NicoLiveRecorder.app/Contents/Resources/ffmpeg
```

この段階では公証していないため、Gatekeeper の `Notarized Developer ID` 判定は得られません。
アプリの起動・録画検証では、必ず `NLR_USER_DATA` と `NLR_OUTPUT_DIR` を一時ディレクトリにし、本番の設定と録画から隔離してください。

証明書のない通常の CI / fork では署名をスキップします。手元で未署名パッケージを検証する場合は、署名用の `CSC_*` 認証情報を設定せず、`CSC_IDENTITY_AUTO_DISCOVERY=false` を指定します。

## 配布成果物の検証

本家の macOS Release は `APPLE_TEAM_ID` を渡して以下を実行します。

```bash
npm run ffmpeg:verify-artifacts -- --require-notarization
```

DMG と ZIP の両方を一時領域に展開し、`scripts/mac/verify.mjs` で次を検証します。

- アプリ全体と FFmpeg / ffprobe の署名が破損していないこと。
- Developer ID Application の署名で、指定した Team ID と一致し、Hardened Runtime とタイムスタンプがあること。
- アプリの Bundle ID が `com.honishi.nico-live-recorder` であること。
- `xcrun stapler validate` で、アプリに公証チケットが添付されていること。
- `spctl` が `accepted` / `source=Notarized Developer ID` を返すこと。
- 従来の FFmpeg の全ファイルのハッシュ・ライセンス・資料・多重化検証に通ること。

署名・公証する対象は `.app` とその中のコードです。DMG と ZIP は、公証チケットを添付した `.app` を格納します。
公開前には、配布ファイルをダウンロードして起動と録画を確認します。別の Mac を使える場合は、その環境でも確認します。
初回の「インターネットからダウンロードしたアプリを開きますか」という通常の確認は、公証済みでも表示される場合があります。

## ローカル署名の検証記録 (2026-09-06)

macOS arm64 / Electron 44.0.0 / electron-builder 26.15.3 で確認しました。

- Developer ID Application 証明書での署名と、アプリ全体の `codesign --verify --deep --strict` が成功。
- Bundle ID、Hardened Runtime、Apple のタイムスタンプを署名情報で確認。
- 署名後の FFmpeg / ffprobe がハッシュ・ライセンス・資料・音声分離/音声込みの多重化検証を通過。
- 一時的な `NLR_USER_DATA` / `NLR_OUTPUT_DIR` でアプリを起動し、CDP から設定取得と実放送 `lv351329563` の30秒録画を実行。状態 `done`、MPEG-TS 5,798,672 bytes を確認。
- 証明書の自動検出を無効にした未署名パッケージの作成も成功。
- format / lint / typecheck と全192テストが成功。追加した署名処理の7テストは OS の署名ツールと外部通信をモック。

公証・DMG / ZIP からの Gatekeeper 検証・Windows CI はこの工程では未実行です。

## CI の公証と成果物の検証記録 (2026-09-06)

コミット `83fe3a5` の作業ブランチに対して、[Release を手動実行](https://github.com/honishi/nico-live-recorder/actions/runs/33984115059)しました。

- macOS 15 のランナーで GitHub Secrets から署名用証明書を読み込み、署名・Apple の公証・チケット添付が成功。
- DMG と ZIP の両方を展開し、署名元・Bundle ID・Hardened Runtime・タイムスタンプ・公証チケット・Gatekeeper 判定と FFmpeg の検証が成功。
- Actions からダウンロードした両成果物を手元の macOS 26 でも展開し、同じ署名・公証・FFmpeg 検証が成功。
- Windows のランナーでもテスト、未署名 NSIS の作成、展開後の FFmpeg 検証と artifact 保存が成功。
- ローカルの format / lint / typecheck、全203テスト、actionlint が成功。

ユーザーが同じ Mac に成果物をダウンロードし、録画が問題なくできることを確認しました。
別の Mac での確認は行っていませんが、ユーザーの判断でこの結果を最終の動作確認とし、issue #22 の署名・公証対応を完了とします。

タグと GitHub Release は作成していません。正式なタグからのリリースは別の工程で行います。

## 参考

- [Apple: Developer ID 証明書と有効期限](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)
- [Apple: CSR の作成](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/)
- [Apple: Developer ID 中間証明書の更新](https://developer.apple.com/support/developer-id-intermediate-certificate/)
- [Apple: アプリ用パスワード](https://support.apple.com/en-us/102654)
- [GitHub: Actions の Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [electron-builder v26: Code Signing](https://www.electron.build/v26/docs/features/code-signing/)
- [electron-builder v26: Notarization](https://www.electron.build/v26/docs/notarization/)
- [Electron: osx-sign](https://github.com/electron/osx-sign)
