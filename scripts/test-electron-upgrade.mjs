import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runElectronScenario } from './electron/scenario.mjs';
import { prepareRecordingMain } from './electron/recording-main.mjs';
import { prepareDetectionMain } from './electron/detection-main.mjs';
import { waitForRecording, waitForStatus } from './electron/recording-status.mjs';
import { startFakeProgram } from '../test/helpers/fake-program.ts';
import { startFakeAutoPush, encryptWebPush } from '../test/helpers/fake-autopush.ts';
import { waitFor } from '../test/helpers/fake-watch-server.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version: baseline } = JSON.parse(
  await readFile(new URL('./electron/baseline.json', import.meta.url), 'utf8'),
);
const {
  devDependencies: { electron: candidate },
} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(
  Number(baseline.split('.')[0]),
  Number(candidate.split('.')[0]) - 1,
  'メジャー更新時はbaseline.jsonを更新前のElectronへ進めてください',
);
const oldBinary = path.join(
  root,
  '.cache/electron-baseline',
  baseline,
  `${process.platform}-${process.arch}`,
  process.platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron',
);
await access(oldBinary);

await runElectronScenario('upgrade', async ({ work, launch, defer }) => {
  const program = await startFakeProgram({ openEnded: true, longMedia: true });
  defer(() => program.close());
  const push = await startFakeAutoPush();
  defer(() => push.close());
  const options = {
    prepareMain: [prepareRecordingMain, prepareDetectionMain],
    config: { origin: program.url, pushOrigin: push.url },
  };
  const old = await launch({ ...options, executable: oldBinary });
  assert.equal(await old.mainEvaluate('process.versions.electron'), baseline);
  // 旧ChromiumがCookie DBを書き、旧Nodeが購読鍵を生成する。実アカウントは使わない。
  await old.mainEvaluate(`(async () => {
    const cookies = __nlrTest.require('electron').session.defaultSession.cookies;
    await cookies.set({ url: 'https://www.nicovideo.jp', name: 'user_session', value: 'upgrade-dummy', secure: true, expirationDate: Date.now()/1000+86400 });
    await cookies.flushStore();
  })()`);
  await old.evaluate(
    `window.api.updateSettings({ pollIntervalSec: 45, notificationsEnabled: false })`,
  );
  await old.evaluate(
    `window.api.restoreTargets([{ userId: '123', name: '配信者', enabled: true, addedAt: '2026-01-01' }])`,
  );
  await waitForStatus(old, "status.push.state === 'connected' && status.push.niconicoRegistered");
  await old.evaluate('window.api.startRecording("lv42")');
  await waitForRecording(old, 'recording.commentCount === 1 && recording.videoBytes > 0');
  await old.evaluate('window.api.stopRecording("lv42")');
  const before = await waitForRecording(old, 'recording.state === "done"');
  await old.quit();
  const video = await readFile(before.videoPath);
  const savedPush = JSON.parse(
    await readFile(path.join(work, 'userdata/push-subscription.json'), 'utf8'),
  );
  const channelCount = push.channels.length;

  // 同じuserDataを新しい実行ファイルで開き、履歴の誤った中断扱いと認証消失を検出する。
  const current = await launch(options);
  assert.equal(await current.mainEvaluate('process.versions.electron'), candidate);
  assert.equal((await current.evaluate('window.api.getSettings()')).pollIntervalSec, 45);
  const status = await waitForStatus(
    current,
    "status.push.state === 'connected' && status.push.niconicoRegistered",
  );
  assert.equal(status.auth.loggedIn, true);
  const history = await current.evaluate('window.api.listHistory({})');
  assert.equal(history.items[0].state, 'done');
  assert.equal(history.items[0].videoPath, before.videoPath);
  assert.deepEqual(await readFile(before.videoPath), video);
  assert.equal(push.hellos.at(-1).uaid, savedPush.uaid);
  assert.equal(push.channels.length, channelCount);
  const restoredPush = JSON.parse(
    await readFile(path.join(work, 'userdata/push-subscription.json'), 'utf8'),
  );
  assert.deepEqual(restoredPush.keys, savedPush.keys);

  // 移行した鍵で暗号通知を復号し、重複通知でも実録画が一つだけになることを検査する。
  const data = encryptWebPush(
    JSON.stringify({ data: { on_click: 'https://live.nicovideo.jp/watch/lv42' } }),
    savedPush.keys,
  );
  push.notify(savedPush.channelId, data);
  const recording = await waitForRecording(
    current,
    `recording.source === "push" && recording.state === "recording" && recording.commentCount === ${before.commentCount + 1} && recording.videoBytes > ${before.videoBytes}`,
  );
  const children = await current.mainEvaluate('__nlrTest.children');
  const acknowledgements = push.acks.length;
  const receivedAt = (await current.evaluate('window.api.getStatus()')).push.lastReceivedAt;
  push.notify(savedPush.channelId, data);
  await waitFor(() => push.acks.length > acknowledgements);
  // ACKは復号より先に返る。復号後に更新される状態通知まで待ってから重複を検査する。
  await waitForStatus(current, `status.push.lastReceivedAt !== ${JSON.stringify(receivedAt)}`);
  assert.equal(
    (await current.evaluate('window.api.getStatus()')).recordings.filter(
      (item) => item.state === 'recording',
    ).length,
    1,
  );
  assert.deepEqual(await current.mainEvaluate('__nlrTest.children'), children);
  assert.notEqual(recording.videoPath, before.videoPath);
  await current.evaluate('window.api.stopRecording("lv42")');
  await waitForRecording(current, 'recording.state === "done"');
  assert.deepEqual(await readFile(before.videoPath), video);
  assert.deepEqual(current.errors, []);
  await current.quit();
  console.log(
    `Electron upgrade OK: ${baseline} -> ${candidate}, cookies/settings/history/push keys/encrypted detection/recording`,
  );
});
