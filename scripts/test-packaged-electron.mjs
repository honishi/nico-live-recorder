import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startFakeProgram } from '../test/helpers/fake-program.ts';
import { CSV_HEADER } from '../src/main/core/recorder/comment-csv.ts';
import { launchElectron } from './electron/driver.mjs';
import { prepareRecordingMain } from './electron/recording-main.mjs';
import { verifyRecordingUi } from './electron/recording-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = process.argv[2];
assert.ok(
  binary && path.isAbsolute(binary),
  '配布アプリの実行ファイルを絶対パスで指定してください',
);

// 本体の状態通知を待つ。保存完了を固定sleepや画面の文字列から推測しない。
async function waitForRecording(app, condition) {
  return app.evaluate(`new Promise((resolve, reject) => {
    const unsubscribe = window.api.onStatusChanged(check);
    function check(status) {
      const recording = status.recordings.find(item => item.programId === 'lv42');
      if (recording && (${condition})) { unsubscribe(); resolve(recording); }
    }
    window.api.getStatus().then(check, reject);
  })`);
}

async function verifyFiles(recording, resources, separateAudio) {
  const csv = await readFile(recording.commentsPath, 'utf8');
  assert.ok(csv.startsWith(CSV_HEADER));
  assert.equal(csv.split(CSV_HEADER).length, 2);
  assert.equal(csv.match(/fixture-comment/g)?.length, 1);
  assert.ok(csv.includes('日本語のコメント, ""引用符""\n改行と絵文字🎵も保持する'));
  assert.ok(csv.includes('"#010203"'));
  const metadata = JSON.parse(
    await readFile(recording.videoPath.replace(/\.ts$/, '.json'), 'utf8'),
  );
  assert.equal(metadata.programId, 'lv42');
  assert.equal(metadata.comments.count, 1);
  assert.deepEqual(metadata.errors, []);
  const probe = async (file) => {
    const { stdout } = await promisify(execFile)(
      path.join(resources, 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
      ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', file],
      { timeout: 10_000 },
    );
    return JSON.parse(stdout);
  };
  const output = await probe(recording.videoPath);
  assert.deepEqual(output.streams.map((stream) => stream.codec_name).sort(), ['aac', 'h264']);
  for (const track of ['video', 'audio']) {
    const input = await probe(
      path.join(root, 'test/fixtures/ffmpeg', `${separateAudio ? track : 'combined'}.mp4`),
    );
    assert.equal(
      output.packets.filter((packet) => packet.codec_type === track).length,
      input.packets.filter((packet) => packet.codec_type === track).length,
    );
  }
  return metadata;
}

for (const scenario of [
  { mode: 'live', separateAudio: true, openEnded: true, holdSegments: true, checkUi: true },
  { mode: 'timeshift', separateAudio: false },
  { mode: 'live', separateAudio: true, openEnded: true, quitDuringRecording: true },
  { mode: 'timeshift', separateAudio: false, holdForward: true, quitDuringRecording: true },
]) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'nlr 配布テスト '));
  const program = await startFakeProgram(scenario);
  let app;
  try {
    const launch = async () =>
      launchElectron({
        work,
        binary,
        prepareMain: prepareRecordingMain,
        config: { origin: program.url, observePreviews: scenario.checkUi },
      });
    app = await launch();
    const runtime = await app.mainEvaluate(
      '({ packaged: __nlrTest.require("electron").app.isPackaged, appPath: __nlrTest.require("electron").app.getAppPath(), resources: process.resourcesPath })',
    );
    assert.equal(runtime.packaged, true);
    assert.ok(runtime.appPath.endsWith('app.asar'));
    assert.equal(
      (await app.evaluate('window.api.getSettings()')).outputDir,
      path.join(work, 'recordings'),
    );
    assert.equal(await app.evaluate('typeof window.require'), 'undefined');
    if (scenario.checkUi) {
      await app.mainEvaluate(`__nlrTest.require('electron').session.defaultSession.cookies.set({
        url: 'https://www.nicovideo.jp', name: 'user_session', value: 'offline-ui-test', secure: true
      })`);
    }
    await app.evaluate('window.api.updateSettings({ pollIntervalSec: 45 })');
    await app.evaluate('window.api.startRecording("lv42")');
    if (scenario.checkUi) await verifyRecordingUi(app, program.releaseSegments);
    let recording;
    if (scenario.quitDuringRecording) {
      // 映像が完了していても、コメント取得中なら未完了ジョブとして終了を待つ。
      recording = await waitForRecording(
        app,
        scenario.mode === 'timeshift'
          ? 'recording.commentCount === 1 && recording.timeshift?.phase === "comments"'
          : 'recording.commentCount === 1 && recording.state === "recording"',
      );
      if (scenario.mode === 'timeshift')
        assert.ok(program.requests.some((request) => request.path === '/forward'));
    } else {
      if (scenario.mode === 'live') {
        await waitForRecording(app, 'recording.commentCount === 1');
        assert.equal(await app.evaluate('window.api.stopRecording("lv42")'), true);
      }
      recording = await waitForRecording(app, '["done", "failed"].includes(recording.state)');
      assert.equal(recording.state, 'done');
    }
    assert.deepEqual(app.errors, []);
    assert.deepEqual(
      await app.evaluate(
        'window.api.getLogs().then(logs => logs.filter(log => log.level === "error"))',
      ),
      [],
    );
    const children = await app.mainEvaluate('__nlrTest.children');
    assert.ok(children.length > 0, '実FFmpegの起動が必要');
    await app.quit();
    // 親の終了だけでは合格にせず、実ファイルの最終状態と子プロセスの終了を検査する。
    for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    const metadata = await verifyFiles(recording, runtime.resources, scenario.separateAudio);
    if (scenario.mode === 'timeshift') {
      assert.equal(
        metadata.timeshift.completion,
        scenario.quitDuringRecording ? 'cancelled' : 'complete',
      );
      if (scenario.quitDuringRecording) {
        assert.equal(metadata.timeshift.comments.reason, 'USER_CANCELLED');
        assert.equal(metadata.video.reason, 'endlist');
      }
    } else assert.equal(metadata.video.reason, 'aborted');
    const saved = JSON.parse(
      await readFile(path.join(work, 'userdata/recording-history.json'), 'utf8'),
    );
    assert.equal(saved.length, 1);
    assert.equal(saved[0].state, 'done');
    assert.equal(saved[0].commentCount, 1);
    assert.ok(saved[0].endedAt);
    const log = await readFile(path.join(work, 'userdata/logs/app.log'), 'utf8');
    assert.ok(log.includes('[rec] finished lv42'));
    assert.ok(log.includes('ffmpeg exited code=0'));
    if (scenario.quitDuringRecording) assert.ok(log.includes('stopping recordings before quit'));
    // 同じ隔離userDataで実際に再起動し、アプリ経由で履歴と設定を読み直す。
    app = await launch();
    assert.equal((await app.evaluate('window.api.getSettings()')).pollIntervalSec, 45);
    const history = await app.evaluate('window.api.listHistory({})');
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].videoPath, recording.videoPath);
    assert.equal(history.items[0].commentCount, 1);
    assert.equal(history.items[0].state, 'done');
    assert.equal(history.items[0].completion, saved[0].completion);
    assert.deepEqual(app.errors, []);
    await app.quit();
    console.log(
      `Packaged Electron OK: ${scenario.mode}, quitDuringRecording=${!!scenario.quitDuringRecording}, recording/CSV/proto/IPC/history/logs/restart/child exit`,
    );
  } catch (error) {
    console.error(app?.output());

    throw error;
  } finally {
    await app?.dispose();
    await program.close();
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
