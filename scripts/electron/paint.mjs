import assert from 'node:assert/strict';

/** DOM成立だけで合格させず、Chromiumが返す描画結果に内容があることを確認する。 */
export async function verifyPaint(app) {
  await app.evaluate(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  const painted = await app.mainEvaluate(`(async () => {
    const contents = __nlrTest.require('electron').BrowserWindow.getAllWindows()[0].webContents;
    const image = await contents.capturePage();
    const bitmap = image.toBitmap();
    const colors = new Set();
    for (let i = 0; i < bitmap.length; i += 4) colors.add(bitmap.readUInt32LE(i));
    return { empty: image.isEmpty(), size: image.getSize(), colors: colors.size };
  })()`);
  assert.equal(painted.empty, false);
  assert.ok(painted.size.width > 0 && painted.size.height > 0);
  assert.ok(painted.colors > 1, 'capturePage returned a blank/solid image');
}
