import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';

/** 合成した4色の映像を縮小したJPEGの寸法・色を、FFmpegと独立したデコーダで調べる。 */
export function assertPreviewColors(image) {
  const { width, height, data } = jpeg.decode(image, {
    tolerantDecoding: false,
    maxResolutionInMP: 1,
    maxMemoryUsageInMB: 16,
  });
  assert.equal(width, 320, 'プレビューの幅');
  assert.equal(height, 180, 'プレビューの高さ');
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
  ];
  // 色の境界は縮小とJPEG圧縮で混ざるため8px除外し、内部は全画素を確認する。
  for (let quadrant = 0; quadrant < colors.length; quadrant++) {
    const left = (quadrant % 2) * 160;
    const top = Math.floor(quadrant / 2) * 90;
    for (let y = top + 8; y < top + 90 - 8; y++) {
      for (let x = left + 8; x < left + 160 - 8; x++) {
        const offset = (y * width + x) * 4;
        const actual = data.subarray(offset, offset + 3);
        if (colors[quadrant].some((value, channel) => Math.abs(actual[channel] - value) > 20)) {
          assert.fail(
            `プレビューの色が不正: (${x}, ${y}) RGB=${[...actual]}, expected=${colors[quadrant]}`,
          );
        }
      }
    }
  }
}
