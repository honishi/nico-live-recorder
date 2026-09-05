# Handoff: アプリアイコン / トレイアイコン（Nico Live Recorder）

## Overview
Electron 製デスクトップアプリ「Nico Live Recorder」(macOS / Windows) のアプリアイコンとトレイアイコン一式。
アプリアイコンは 5a「フレーム + 赤丸」で確定。トレイアイコンは 16px 単色の 3 状態（待機 / 録画中 / 未ログイン）。

このパッケージは **画像アセットの納品** が主で、UI コードの実装はありません。開発側の作業は
1. PNG / SVG をリポジトリに配置し、
2. electron-builder の設定を更新し、
3. `src/main/app/tray.ts` のビットマップ描画をファイル読み込みに置き換える、
の 3 点です。

## About the Design Files
同梱の `.dc.html` は **デザインの参照用プロトタイプ**（アイコンを一覧・比較するためのページ）で、製品コードではありません。
実際に使うのは `build/` と `tray/` の PNG / SVG です。HTML はアイコンの意図・寸法・サイズ別チューニングを目で確認するための資料として同梱しています。

## Fidelity
**High-fidelity（確定）**。色・寸法・比率はすべて確定値です。PNG はそのまま出荷可。
アイコンを作り直す必要はありません（サイズ違いが必要な場合のみ SVG から書き出してください）。

---

## 確定デザイン: アプリアイコン 5a「フレーム + 赤丸」

墨色の角丸の板に、白いカギ括弧が 4 隅、中央に赤い丸。
「括弧 = これから録る範囲」「赤丸 = 録画」を文字なしで表す構成です。

### 寸法（板の一辺を 1 とした比率 / 1024px マスターでの実寸）

| 要素 | 比率 | 1024px マスター実寸 |
|---|---|---|
| 板（macOS） | 824 / 1024 | 824×824、中央配置（上下左右に 100px の透過余白） |
| 板の角丸 | 辺の 22.37% | 半径 184.3px |
| 板（Windows） | 1024 / 1024 | 全面、角丸なし |
| 括弧の枠（横） | 15.5% – 84.5% | x = 227.7 – 796.3（板座標 + 100 オフセット） |
| 括弧の枠（縦） | 24% – 76% | y = 297.8 – 726.2 |
| 括弧の腕の長さ | 16% | 131.8px |
| 括弧の線の太さ | 5.5% | 45.3px |
| 赤丸の直径 | 29% | 239.0px（半径 119.5px） |
| 赤丸の中心 | 板の中心 | (512, 512) |

括弧は `stroke-linecap: square` / `stroke-linejoin: miter`（角を丸めない）。
赤丸の縁から括弧の縦線まで 60px、横線まで 25px の余白。

### 色

| 用途 | 値 |
|---|---|
| 板の地 | `#1e1c20` |
| 括弧 | `#ffffff` |
| 録画の丸 | `#d92b2b` |

グラデーション・影・光沢・不透明度の変化は一切なし。3 色ベタのみ。
`#d92b2b` はアプリ内の「録画中」表示およびトレイの録画中状態と同一色にしてください。

### サイズ別チューニング（重要）

小さいサイズは **自動縮小ではなく描き直し** です。線が細って灰色に沈むのを防ぐため、3 段で値を変えています。

| 帯 | 括弧の枠 | 腕の長さ | 線の太さ | 赤丸の直径 |
|---|---|---|---|---|
| 128px 以上 | 15.5–84.5% / 24–76% | 16% | 5.5% | 29% |
| 48–64px | 15.0–85.0% / 23.5–76.5% | 17.5% | 6.5% | 30% |
| 16–32px | 15.5–84.5% / 24–76% | 17% | 7.5% | 31% |

16px では線幅の下限を 1.5px で確保しています。
どの帯でも「4 隅の括弧 + 中央の赤丸」というシルエットは同一です。

**icns / ico を自前で組む場合は `build/icons/` の各サイズを使ってください。**
1024 の 1 枚から縮小すると、16 / 32 / 64px で括弧が潰れます。

---

## 確定デザイン: トレイアイコン 3 状態

アプリアイコンとは別系統で、**円ひとつだけ**で状態を表します。単色 + 透過。

| 状態 | 形 | 用途 |
|---|---|---|
| 待機 | 輪（線のみの円） | 常駐中・録画していない |
| 録画中 | 塗りの円 | 録画中 |
| 未ログイン | 破線の輪 | ニコニコ未ログイン |

### 16px グリッドでの寸法

- 円の直径 12px（上下左右に 2px の余白）
- 線の太さ 2px（12px 径に対して、アプリアイコン側の線比率に最も近い整数）
- 破線: 円周を 8 分割し、各セグメントの 56% を実線、44% を空き
- `@2x`（32px）は拡大ではなく **32px で描き直し**。線が半端な小数にならないようにしています

### 色

- macOS: 黒 `#000000` + 透過 → `setTemplateImage(true)` で OS が反転を管理
- Windows 暗テーマ: 白 `#ffffff` + 透過
- Windows 明テーマ: 黒版（Template 版と同じファイル）を流用

トレイ側は **着色しません**。録画中を赤くしたい場合はアプリアイコンとの色の一貫性のため `#d92b2b` を使いますが、
現状の設計では単色のまま OS のテーマに任せる方針です。

---

## Assets

### アプリアイコン

| ファイル | 内容 |
|---|---|
| `build/icon.png` | 1024×1024、macOS 用マスター。角丸の板、外側は透過 |
| `build/icon-win.png` | 1024×1024、Windows 用。全面正方形、透過なし |
| `build/icons/mac-{16,32,64,128,256,512,1024}.png` | macOS 用サイズ別（小サイズは描き直し） |
| `build/icons/win-{16,32,64,128,256,512,1024}.png` | Windows 用サイズ別（同上） |
| `build/icon-macos.svg` | 元データ（1024 基準、128px 以上のチューニング）、角丸版 |
| `build/icon-windows.svg` | 元データ、正方形版 |
| `build/icon-small-16.svg` | 16 / 32px 用の元データ（16px グリッド、S 帯のチューニング） |

### トレイアイコン

| ファイル | 内容 |
|---|---|
| `tray/trayIdleTemplate.png` / `-2x.png` | 待機・黒・16 / 32px |
| `tray/trayRecordingTemplate.png` / `-2x.png` | 録画中・黒・16 / 32px |
| `tray/trayOfflineTemplate.png` / `-2x.png` | 未ログイン・黒・16 / 32px |
| `tray/trayIdleWhite.png` / `-2x.png` | 待機・白・16 / 32px |
| `tray/trayRecordingWhite.png` / `-2x.png` | 録画中・白・16 / 32px |
| `tray/trayOfflineWhite.png` / `-2x.png` | 未ログイン・白・16 / 32px |
| `svg/tray-{idle,recording,offline}.svg` | 元データ（16px グリッド、`currentColor`） |

> **⚠️ リネームが必要**
> このデザイン環境はファイル名に `@` を使えないため、Retina 版を `-2x.png` という名前で保存しています。
> リポジトリに入れる際に **`-2x.png` → `@2x.png`** にリネームしてください（例: `trayIdleTemplate-2x.png` → `trayIdleTemplate@2x.png`）。
> Electron の `nativeImage` は `@2x` サフィックスを見て自動的に高解像度版を選びます。
> また macOS のテンプレート画像は **ファイル名が `Template` で終わること** が必須です。

---

## Implementation

### 1. ファイル配置

```
build/
  icon.png              # electron-builder mac.icon
  icon-win.png          # electron-builder win.icon
  icons/                # 自前で icns/ico を組む場合のみ
assets/tray/            # 配置先はプロジェクトの慣習に合わせて
  trayIdleTemplate.png
  trayIdleTemplate@2x.png
  ...
```

### 2. electron-builder

```json
{
  "mac":  { "icon": "build/icon.png" },
  "win":  { "icon": "build/icon-win.png" }
}
```

`win.icon` を省略すると macOS の角丸マスターが ico に変換され、Windows で角が丸く抜けた見た目になります。必ず指定してください。

### 3. `src/main/app/tray.ts` の置き換え

現状はアプリ内でビットマップを描画しています。これを PNG 読み込みに置き換えます。

```ts
import path from 'node:path';
import { nativeImage, systemPreferences, Tray, type NativeImage } from 'electron';

type TrayState = 'idle' | 'recording' | 'offline';

const FILE: Record<TrayState, string> = {
  idle: 'trayIdle',
  recording: 'trayRecording',
  offline: 'trayOffline',
};

function trayImage(state: TrayState): NativeImage {
  const dir = path.join(__dirname, '../../assets/tray'); // 配置先に合わせて調整

  if (process.platform === 'darwin') {
    // ファイル名が Template で終わることが必須。@2x は自動で拾われる
    const img = nativeImage.createFromPath(
      path.join(dir, `${FILE[state]}Template.png`)
    );
    img.setTemplateImage(true);
    return img;
  }

  // Windows: タスクバーの明暗に合わせて白 / 黒を選ぶ
  const dark =
    process.platform === 'win32' &&
    !systemPreferences.getSystemColor?.('window-background')?.startsWith('#ff');
  const variant = dark ? 'White' : 'Template';
  return nativeImage.createFromPath(path.join(dir, `${FILE[state]}${variant}.png`));
}

export function setTrayState(tray: Tray, state: TrayState): void {
  tray.setImage(trayImage(state));
}
```

Windows のテーマ判定は環境によって取得方法が変わります。既存コードにテーマ判定があればそれを流用し、
なければ `nativeTheme.shouldUseDarkColors` で代替してください（タスクバーの色とは厳密には別ですが実用上は十分です）。

テーマ変更に追従する場合は `nativeTheme.on('updated', ...)` で現在の状態を再適用してください。

### 4. 確認項目

- [ ] macOS: Dock で角丸の板として表示され、板の外に余白の縁が出ていない
- [ ] macOS: メニューバーで黒 / 白が OS のテーマに合わせて反転する（Template 画像が効いている）
- [ ] macOS: Retina で輪郭がぼやけない（`@2x` のリネーム漏れがない）
- [ ] Windows: タスクバーで角が丸く抜けていない（`win.icon` の指定漏れがない）
- [ ] Windows: 明暗テーマの切り替えでトレイアイコンが読める
- [ ] 16px のトレイアイコンで 3 状態（輪 / 塗り / 破線）が区別できる
- [ ] 「録画中」表示の赤とアプリアイコンの赤が同じ `#d92b2b`

---

## Design Tokens

```
--icon-plate:    #1e1c20   /* アプリアイコンの板 */
--icon-frame:    #ffffff   /* カギ括弧 */
--rec:           #d92b2b   /* 録画の赤（アプリ内表示・トレイと共通） */

plate-size:      824 / 1024        /* macOS の板の比率 */
plate-radius:    22.37%            /* 板の一辺に対する角丸半径 */
frame-inset-x:   15.5% – 84.5%     /* 括弧の枠（板の一辺基準） */
frame-inset-y:   24%   – 76%
frame-arm:       16%               /* 腕の長さ */
frame-stroke:    5.5%              /* 線の太さ */
rec-dot:         29%               /* 赤丸の直径 */

tray-grid:       16px
tray-circle:     12px              /* 直径 */
tray-stroke:     2px
tray-dash:       円周 / 8、実線 56%
```

## Files（同梱の参照用ファイル）

| ファイル | 内容 |
|---|---|
| `アプリアイコン案.dc.html` | 確定案・過去案・トレイの一覧ページ（デザイン参照用） |
| `build/`, `tray/`, `svg/` | 上記 Assets の実データ |

`アプリアイコン案.dc.html` はブラウザで直接開けます。最上部が確定した 5a、その下に検討過程（フレームのバリエーション、弾幕案、録画アプリ一般の案、円ひとつの案）と、最下部にトレイの 3 状態が並んでいます。

## 検討過程で見送った方向（参考）

実装には不要ですが、判断の経緯が必要な場合の記録です。

- **円ひとつ（v1）**: 赤地 + 白丸。記号として最短だが「作り込まれたアプリ」に見えず却下
- **録画アプリ一般（v2）**: 電波 / 画面の重なり / フィルムリール。ニコ生のアプリだと分からず却下
- **弾幕（v3, v4）**: 映像面の上を流れる白いコメント線。ニコ生らしさは最も強いが、要素が多く 16px で崩れる
- **フレームのバリエーション（v6）**: 反転（赤地）/ 角丸括弧 + 脈動 / 対角括弧 / 画面入り
- ニコニコテレビちゃん等の公式キャラクター・ロゴは商標のため一切使用していません
