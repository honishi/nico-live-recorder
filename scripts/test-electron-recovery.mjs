import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runElectronScenario } from './electron/scenario.mjs';
import { prepareRecordingMain } from './electron/recording-main.mjs';
import { verifyPreloadEvents } from './electron/preload-events.mjs';
import { waitForRecording } from './electron/recording-status.mjs';
import { startFakeProgram } from '../test/helpers/fake-program.ts';
import { waitFor } from '../test/helpers/fake-watch-server.ts';

await runElectronScenario('recovery', async ({ work, launch, defer }) => {
  const program = await startFakeProgram({ openEnded: true, longMedia: true });
  defer(() => program.close());
  const options = { prepareMain: prepareRecordingMain, config: { origin: program.url } };
  let app = await launch(options);
  await app.evaluate('window.api.startRecording("lv42")');
  const recording = await waitForRecording(
    app,
    'recording.state === "recording" && recording.videoBytes > 0 && recording.commentCount === 1',
  );
  const children = await app.mainEvaluate('__nlrTest.children');
  assert.ok(children.length > 0);
  // main/FFmpegを維持したままrendererだけを再読込・クラッシュさせる。
  for (const crash of [false, true]) {
    const requests = program.requests.length;
    await app.reloadRenderer(crash);
    const restored = await waitForRecording(app, 'recording.state === "recording"');
    assert.equal(restored.videoPath, recording.videoPath);
    assert.equal(restored.startedAt, recording.startedAt);
    await verifyPreloadEvents(app);
    await waitFor(() =>
      program.requests.slice(requests).some((request) => request.path.endsWith('.m3u8')),
    );
    for (const pid of children) assert.doesNotThrow(() => process.kill(pid, 0));
  }
  // 通常終了を通さず落とす前に、履歴が実際に保存済みであることを確認する。
  const historyPath = path.join(work, 'userdata/recording-history.json');
  await waitFor(async () => {
    const saved = JSON.parse(
      await readFile(historyPath, 'utf8').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return '[]';
      }),
    );
    return saved[0]?.state === 'recording';
  });
  const before = await readFile(recording.videoPath);
  assert.ok(before.length > 0);
  await app.forceExit();
  // cleanupによる強制停止で合格させず、親の消失でFFmpeg自身が終了することを確認する。
  await app.waitForChildExit();
  app = await launch(options);
  const history = await app.evaluate('window.api.listHistory({})');
  assert.equal(history.items[0].state, 'failed');
  assert.equal(history.items[0].error, 'アプリの終了により中断');
  assert.equal(history.items[0].videoPath, recording.videoPath);
  assert.deepEqual((await readFile(recording.videoPath)).subarray(0, before.length), before);
  assert.deepEqual(await app.mainEvaluate('__nlrTest.children'), []);
  await app.evaluate('window.api.startRecording("lv42")');
  const next = await waitForRecording(
    app,
    'recording.state === "recording" && recording.videoBytes > 0',
  );
  assert.notEqual(next.videoPath, recording.videoPath);
  await waitFor(
    async () =>
      (
        await readFile(next.videoPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return Buffer.alloc(0);
        })
      ).length > 0,
  );
  await app.evaluate('window.api.stopRecording("lv42")');
  await waitForRecording(app, 'recording.state === "done"');
  assert.deepEqual((await readFile(recording.videoPath)).subarray(0, before.length), before);
  assert.deepEqual(app.errors, []);
  await app.quit();
  console.log(
    'Electron recovery OK: renderer reload/crash, main crash, child exit, interrupted history, recording restart',
  );
});
