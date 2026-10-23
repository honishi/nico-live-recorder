import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import electron from 'electron';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(path.join(os.tmpdir(), 'nlr-electron-test-'));
const sockets = new Set();
let child;
let output = '';

// 固定秒数の待機ではなく、CDPのイベントとDOM更新で進める。期限はハングの検出用。
async function deadline(promise, label, ms = 15_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  sockets.add(socket);
  const events = new EventEmitter();
  const pending = new Map();
  let nextId = 0;
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    } else events.emit(message.method, message.params);
  });
  const rejectPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.on('error', rejectPending);
  socket.on('close', () => rejectPending(new Error('CDP connection closed')));
  await deadline(once(socket, 'open'), 'CDP connection');
  return {
    events,
    send: async (method, params = {}) => {
      const id = ++nextId;
      try {
        return await deadline(
          new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
          }),
          method,
        );
      } finally {
        pending.delete(id);
      }
    },
  };
}

async function stop() {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  try {
    await deadline(exited, 'Electron exit', 5000);
  } catch (error) {
    child.kill('SIGKILL');
    await deadline(exited, 'Electron forced exit', 5000);
    throw error;
  }
}

async function launch() {
  // 開発起動のビルド済みアプリを使い、ログイン・更新確認が発生しない空の設定で起動する。
  // ELECTRON_RUN_AS_NODE等、親の開発環境による起動方法の変更は引き継がない。
  const env = {
    ...process.env,
    NLR_USER_DATA: path.join(work, 'userdata'),
    NLR_OUTPUT_DIR: path.join(work, 'recordings'),
  };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'NICO_USER_SESSION',
    'NICO_FFMPEG_PATH',
    'NLR_DEV_FAIL_VIDEO_AFTER_MS',
  ])
    delete env[key];
  child = spawn(
    electron,
    [root, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
    {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const debuggerUrl = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      reject(new Error(`Electron exited before ready: ${code}/${signal}`)),
    );
    child.stdout.on('data', (data) => {
      output = (output + data).slice(-32_000);
    });
    child.stderr.on('data', (data) => {
      output = (output + data).slice(-32_000);
      const url = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
      if (url) resolve(url);
    });
  });
  const browserUrl = await deadline(debuggerUrl, 'Electron debugger');
  const browser = await connect(browserUrl);
  const expectedUrl = pathToFileURL(path.join(root, 'out/renderer/index.html')).href;
  const targetReady = new Promise((resolve) => {
    const found = ({ targetInfo }) => {
      if (targetInfo.type === 'page' && targetInfo.url === expectedUrl)
        resolve(targetInfo.targetId);
    };
    browser.events.on('Target.targetCreated', found);
    browser.events.on('Target.targetInfoChanged', found);
  });
  await browser.send('Target.setDiscoverTargets', { discover: true });
  const target = await deadline(targetReady, 'renderer target');
  const renderer = await connect(new URL(`/devtools/page/${target}`, browserUrl).href);
  const errors = [];
  renderer.events.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails));
  renderer.events.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error') errors.push(event.args);
  });
  await renderer.send('Runtime.enable');
  const evaluate = async (expression) => {
    const result = await renderer.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const waitForDom = (condition) =>
    evaluate(`new Promise(resolve => {
    const observer = new MutationObserver(check);
    function check() { if (${condition}) { observer.disconnect(); resolve(true); } }
    observer.observe(document, { childList: true, subtree: true, attributes: true });
    check();
  })`);
  await waitForDom('window.api && document.querySelector(".status-band")');
  return { evaluate, waitForDom, errors };
}

try {
  const first = await launch();
  // 実preloadからmainへ到達し、隔離した設定と未ログイン状態を読めることを確認する。
  const settings = await first.evaluate('window.api.getSettings()');
  assert.equal(settings.outputDir, path.join(work, 'recordings'));
  assert.deepEqual(settings.targets, []);
  assert.equal((await first.evaluate('window.api.getStatus()')).auth.loggedIn, false);
  assert.equal(await first.evaluate('typeof window.require'), 'undefined');

  // Reactの操作・再描画と、main→preload→rendererの変更通知を確認する。
  for (const label of ['録画対象', '履歴', 'ログ', '設定']) {
    await first.evaluate(
      `[...document.querySelectorAll('.tab-bar button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`,
    );
    await first.waitForDom(
      `document.querySelector('.tab.active')?.textContent.trim() === ${JSON.stringify(label)}`,
    );
  }
  const changed = await first.evaluate(`new Promise((resolve, reject) => {
    const unsubscribe = window.api.onSettingsChanged(() => {
      unsubscribe();
      window.api.getSettings().then(resolve, reject);
    });
    window.api.updateSettings({ pollIntervalSec: 45 }).catch(reject);
  })`);
  assert.equal(changed.pollIntervalSec, 45);
  await first.waitForDom('document.querySelector(".settings input[type=number]")?.value === "45"');
  assert.deepEqual(first.errors, []);
  assert.deepEqual(
    await first.evaluate(
      'window.api.getLogs().then(logs => logs.filter(log => log.level === "error"))',
    ),
    [],
  );
  await stop();

  // 同じ一時userDataで起動し直し、ディスク保存と復元を実際のアプリで確認する。
  output = '';
  const second = await launch();
  const restored = await second.evaluate('window.api.getSettings()');
  assert.equal(restored.pollIntervalSec, 45);
  assert.equal(restored.ui.tab, 'settings');
  await second.waitForDom('document.querySelector(".settings input[type=number]")?.value === "45"');
  assert.deepEqual(second.errors, []);
  assert.deepEqual(
    await second.evaluate(
      'window.api.getLogs().then(logs => logs.filter(log => log.level === "error"))',
    ),
    [],
  );
  console.log(
    'Electron smoke OK: startup, preload/IPC, React tabs, settings events, restart persistence',
  );
} catch (error) {
  console.error(output);
  throw error;
} finally {
  // 今回作成した一時領域だけを、プロセスの終了後に削除する。
  await stop();
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
