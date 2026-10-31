import assert from 'node:assert/strict';
import { verifyPaint } from './paint.mjs';

export async function verifyRecordingUi(app, releaseSegments) {
  const waitForRequest = (visible) =>
    app.mainEvaluate(`new Promise(resolve => {
    const check = () => {
      if (__nlrTest.previewRequests.at(-1)?.visible === ${visible}) {
        __nlrTest.events.off('preview', check); resolve(true);
      }
    };
    __nlrTest.events.on('preview', check); check();
  })`);
  const clearRequests = () => app.mainEvaluate('__nlrTest.previewRequests.length = 0');
  const tab = async (name) => {
    await app.evaluate(
      `[...document.querySelectorAll('.tab-bar button')].find(button => button.firstChild.textContent.trim() === ${JSON.stringify(name)}).click()`,
    );
    await app.waitForDom(
      `document.querySelector('.tab.active')?.firstChild.textContent.trim() === ${JSON.stringify(name)}`,
    );
  };
  // 最初の映像は購読後に渡す。実FFmpegのJPEGをChromiumがdecodeして描画できることを確認する。
  await waitForRequest(true);
  releaseSegments();
  await app.waitForDom('document.querySelector(".rec-preview img")');
  const image = await app.evaluate(`(async () => {
    const img = document.querySelector('.rec-preview img'); await img.decode();
    const bounds = img.getBoundingClientRect();
    return { width: img.naturalWidth, height: img.naturalHeight, rendered: bounds.width > 0 && bounds.height > 0 };
  })()`);
  assert.deepEqual(image, { width: 180, height: 180, rendered: true });
  await verifyPaint(app);
  await clearRequests();
  await tab('ログ');
  await waitForRequest(false);
  assert.equal(await app.evaluate('!!document.querySelector(".rec-preview")'), false);
  await clearRequests();
  await tab('録画');
  await waitForRequest(true);

  // 閉じる操作はトレイ常駐へ移り、録画を保持する。非表示の画像要求もmainで拒否する。
  await app.mainEvaluate(
    '__nlrTest.require("electron").BrowserWindow.getAllWindows()[0].close(); true',
  );
  assert.deepEqual(
    await app.mainEvaluate(`(() => {
    const windows = __nlrTest.require('electron').BrowserWindow.getAllWindows();
    return { count: windows.length, visible: windows[0].isVisible() };
  })()`),
    { count: 1, visible: false },
  );
  assert.equal(await app.evaluate('window.api.getRecordingPreview("lv42", true)'), undefined);
  assert.equal((await app.evaluate('window.api.getStatus()')).recordings[0].state, 'recording');

  // OSの二重起動を通し、既存ウィンドウの再表示とロックによる新プロセス終了を確認する。
  await clearRequests();
  await app.mainEvaluate(`__nlrTest.shown = new Promise(resolve => {
    __nlrTest.require('electron').app.once('second-instance', () => resolve(true));
  }); true`);
  await Promise.all([app.mainEvaluate('__nlrTest.shown'), app.secondInstance()]);
  assert.equal(
    await app.mainEvaluate(
      '__nlrTest.require("electron").BrowserWindow.getAllWindows()[0].isVisible()',
    ),
    true,
  );
  await waitForRequest(true);
  assert.equal(
    await app.mainEvaluate('__nlrTest.require("electron").BrowserWindow.getAllWindows().length'),
    1,
  );
  assert.equal((await app.evaluate('window.api.getStatus()')).recordings[0].state, 'recording');
  console.log(
    'Packaged UI OK: JPEG decode/render, preview subscriptions, close to tray, second instance',
  );
}
