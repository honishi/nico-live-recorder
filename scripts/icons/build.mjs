/*
 * build/icon.icns と build/icon.ico を、サイズ別に描き分けた build/icons/*.png から組み立てる。
 * 1024px の 1 枚から縮小すると 16 / 32 / 64px で括弧が潰れるため、electron-builder の自動変換に任せない。
 * macOS 専用 (iconutil を使う)。生成物はリポジトリに含めるので、アイコンを更新したときだけ実行する。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const iconsDir = path.join(root, 'build', 'icons');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-icons-'));

const macPng = (size) => path.join(iconsDir, `mac-${size}.png`);
const winPng = (size) => path.join(iconsDir, `win-${size}.png`);

// icns: iconutil が要求する名前で iconset を組む。@2x には倍の px で描き分けた PNG をそのまま使う
function buildIcns() {
  const iconset = path.join(tmp, 'icon.iconset');
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    fs.copyFileSync(macPng(size), path.join(iconset, `icon_${size}x${size}.png`));
    fs.copyFileSync(macPng(size * 2), path.join(iconset, `icon_${size}x${size}@2x.png`));
  }
  const out = path.join(root, 'build', 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out]);
  return out;
}

// ico に入れるサイズ。すべて描き分けた PNG をそのまま使う (20 / 40px は Windows の 125% 表示用)
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function icoLayer(size) {
  return fs.readFileSync(winPng(size));
}

// ico: PNG をそのまま格納する形式 (Windows Vista 以降) で、ヘッダとディレクトリを手で書く
function buildIco() {
  const layers = ICO_SIZES.map((size) => ({ size, png: icoLayer(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 予約
  header.writeUInt16LE(1, 2); // 種別: アイコン
  header.writeUInt16LE(layers.length, 4);
  const entries = [];
  let offset = header.length + 16 * layers.length;
  for (const { size, png } of layers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0); // 幅 (256 は 0 と書く)
    entry.writeUInt8(size === 256 ? 0 : size, 1); // 高さ
    entry.writeUInt8(0, 2); // パレット色数 (なし)
    entry.writeUInt8(0, 3); // 予約
    entry.writeUInt16LE(1, 4); // カラープレーン数
    entry.writeUInt16LE(32, 6); // 1 ピクセルあたりのビット数
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  const out = path.join(root, 'build', 'icon.ico');
  fs.writeFileSync(out, Buffer.concat([header, ...entries, ...layers.map((l) => l.png)]));
  return out;
}

if (process.platform !== 'darwin') {
  console.error('このスクリプトは macOS 専用です (iconutil を使います)');
  process.exit(1);
}
try {
  for (const out of [buildIcns(), buildIco()]) {
    console.log(`${path.relative(root, out)}: ${fs.statSync(out).size} bytes`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
