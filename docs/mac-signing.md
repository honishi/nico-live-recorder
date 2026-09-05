# macOS の署名と公証

issue #22。GitHub Releases で配布する DMG / ZIP 向けの Developer ID 署名を使います。
Bundle ID は `com.honishi.nico-live-recorder`、表示名は `NicoLiveRecorder` です。

## 現在の対応範囲

ローカルの Developer ID Application 証明書で、Electron 本体・補助プロセス・同梱 FFmpeg / ffprobe を署名する設定があります。
electron-builder の公証連携も有効ですが、認証情報がない場合は公証をスキップします。
Release の CI に Secrets を渡す処理と、公証済み成果物の検証は次の工程で追加します。
現時点のタグビルドは引き続き未署名です。

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

## ローカル検証

署名用の証明書と秘密鍵が認識されていることを確認します。

```bash
security find-identity -v -p codesigning
```

署名だけを検証する場合は、公証を明示的に無効にして一時的な出力先へパッケージします。
`forceCodeSigning` を指定すると、署名用証明書がなければ失敗します。

```bash
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

## ローカル検証記録 (2026-09-06)

macOS arm64 / Electron 44.0.0 / electron-builder 26.15.3 で確認しました。

- Developer ID Application 証明書での署名と、アプリ全体の `codesign --verify --deep --strict` が成功。
- Bundle ID、Hardened Runtime、Apple のタイムスタンプを署名情報で確認。
- 署名後の FFmpeg / ffprobe がハッシュ・ライセンス・資料・音声分離/音声込みの多重化検証を通過。
- 一時的な `NLR_USER_DATA` / `NLR_OUTPUT_DIR` でアプリを起動し、CDP から設定取得と実放送 `lv351329563` の30秒録画を実行。状態 `done`、MPEG-TS 5,798,672 bytes を確認。
- 証明書の自動検出を無効にした未署名パッケージの作成も成功。
- format / lint / typecheck と全192テストが成功。追加した署名処理の7テストは OS の署名ツールと外部通信をモック。

公証・DMG / ZIP からの Gatekeeper 検証・Windows CI はこの工程では未実行です。

## 参考

- [Apple: Developer ID 証明書と有効期限](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)
- [Apple: アプリ用パスワード](https://support.apple.com/en-us/102654)
- [electron-builder v26: Code Signing](https://www.electron.build/v26/docs/features/code-signing/)
- [electron-builder v26: Notarization](https://www.electron.build/v26/docs/notarization/)
- [Electron: osx-sign](https://github.com/electron/osx-sign)
