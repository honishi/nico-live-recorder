import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter, once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import WebSocket from 'ws';
import { createOutputDiagnostics } from './diagnostics.mjs';
import { observeElectronProcesses } from './process-diagnostics.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function deadline(promise, label, ms = 15_000) {
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

// main の Node inspector と renderer の CDP は同じ要求・応答形式で操作する。
async function connect(url, sockets) {
  const socket = new WebSocket(url);
  sockets.add(socket);
  const events = new EventEmitter();
  const pending = new Map();
  let nextId = 0;
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (!message.id) {
      events.emit(message.method, message.params);
      return;
    }
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error)
      request?.reject(new Error(`${request.label}: ${JSON.stringify(message.error)}`));
    else request?.resolve(message.result);
  });
  const rejectPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.on('error', rejectPending);
  socket.on('close', () => rejectPending(new Error('Debugger connection closed')));
  await deadline(once(socket, 'open'), 'debugger connection');
  return {
    events,
    async send(method, params = {}) {
      const id = ++nextId;
      try {
        return await deadline(
          new Promise((resolve, reject) => {
            pending.set(id, {
              resolve,
              reject,
              label: `${method}: ${params.expression?.slice(0, 240) ?? ''}`,
            });
            socket.send(JSON.stringify({ id, method, params }));
          }),
          `${method}: ${params.expression?.slice(0, 240) ?? ''}`,
        );
      } finally {
        pending.delete(id);
      }
    },
  };
}

function value(result) {
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

/** 本番コードにテスト用IPCを足さず、最初のmain文の実行前に隔離設定を注入する。 */
export async function launchElectron({
  work,
  binary,
  executable,
  prepareMain,
  config = {},
  label = 'electron',
}) {
  const sockets = new Set();
  const errors = [];
  const diagnostics = createOutputDiagnostics(errors);
  let output = '';
  let pendingOutput = '';
  const ownedChildren = new Set();
  const env = {
    ...process.env,
    NLR_USER_DATA: path.join(work, 'userdata'),
    NLR_OUTPUT_DIR: path.join(work, 'recordings'),
  };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NICO_USER_SESSION',
    'NICO_FFMPEG_PATH',
    'NLR_DEV_FAIL_VIDEO_AFTER_MS',
  ])
    delete env[key];
  const args = [
    '--inspect-brk=127.0.0.1:0',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
  ];
  if (!binary) args.unshift(root);
  const child = spawn(binary ?? executable ?? electron, args, {
    cwd: work,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const closed = once(child, 'close');
  void closed.catch(() => {});
  // 起動失敗時にも exit の監視を未処理のrejectionにしない。
  void exited.catch(() => {});
  const changed = new EventEmitter();
  const append = (data) => {
    output = (output + data).slice(-64_000);
    pendingOutput += data;
    const lines = pendingOutput.split('\n');
    pendingOutput = lines.pop();
    for (const line of lines) {
      const marker = line.match(/^NLR_TEST_CHILD_(SPAWN|EXIT) (\d+)$/);
      if (marker?.[1] === 'SPAWN') ownedChildren.add(Number(marker[2]));
      if (marker?.[1] === 'EXIT') ownedChildren.delete(Number(marker[2]));
    }
    changed.emit('output');
  };
  const observeOutput = (target) => {
    for (const stream of [target.stdout, target.stderr]) {
      stream.on('data', (data) => {
        append(data);
        diagnostics.append(stream, data);
      });
      stream.once('end', () => diagnostics.finish(stream));
    }
  };
  observeOutput(child);
  const debuggerUrl = async (pattern) => {
    let cleanup;
    try {
      return await deadline(
        new Promise((resolve, reject) => {
          const check = () => {
            const url = output.match(pattern)?.[1];
            if (url) resolve(url);
          };
          const stopped = (code, signal) =>
            reject(new Error(`Electron exited before ready: ${code}/${signal}`));
          cleanup = () => {
            changed.off('output', check);
            child.off('error', reject);
            child.off('exit', stopped);
          };
          changed.on('output', check);
          child.once('error', reject);
          child.once('exit', stopped);
          check();
        }),
        `${label}: debugger startup`,
      );
    } finally {
      cleanup?.();
    }
  };
  const forceExit = async () => {
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      child.kill('SIGKILL');
      await deadline(exited, `${label}: forced exit`, 5000);
    }
  };
  const dispose = async () => {
    const failures = [];
    try {
      await forceExit();
    } catch (error) {
      failures.push(error);
    }
    // 親の終了に失敗しても、今回spawnを観測した子だけは全て後始末する。
    for (const pid of ownedChildren) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') failures.push(error);
      }
    }
    try {
      await waitForChildExit([...ownedChildren], `${label}: child cleanup`);
      await deadline(closed, `${label}: output drain`, 5000);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, `${label}: cleanup failed`);
  };
  try {
    const main = await connect(await debuggerUrl(/Debugger listening on (ws:\/\/[^\s]+)/), sockets);
    main.events.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails));
    await main.send('Runtime.enable');
    const paused = once(main.events, 'Debugger.paused');
    await main.send('Debugger.enable');
    await main.send('Runtime.runIfWaitingForDebugger');
    const [pause] = await deadline(paused, 'main entry breakpoint');
    const requireBase = binary
      ? 'process.resourcesPath + "/app.asar/package.json"'
      : JSON.stringify(path.join(root, 'package.json'));
    const prepare = prepareMain
      ? [prepareMain]
          .flat()
          .map((prepare) => `(${prepare.toString()})(__nlrTest.require, ${JSON.stringify(config)})`)
          .join(';')
      : '';
    value(
      await main.send('Debugger.evaluateOnCallFrame', {
        callFrameId: pause.callFrames[0].callFrameId,
        expression: [
          `globalThis.__nlrTest = { require: process.getBuiltinModule("module").createRequire(${requireBase}) }`,
          `(${observeChildren.toString()})(__nlrTest.require)`,
          `(${observeElectronProcesses.toString()})(__nlrTest.require('electron').app, __nlrTest, message => process.stderr.write(message + '\\n'))`,
          prepare,
          'true',
        ].join(';'),
        returnByValue: true,
      }),
    );
    await main.send('Debugger.resume');
    const mainEvaluate = async (expression) =>
      value(
        await main.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }),
      );
    const browserUrl = await debuggerUrl(/DevTools listening on (ws:\/\/[^\s]+)/);
    const browser = await connect(browserUrl, sockets);
    let removeTargetListeners;
    const targetReady = new Promise((resolve) => {
      const found = ({ targetInfo }) => {
        if (
          targetInfo.type === 'page' &&
          targetInfo.url.startsWith('file:') &&
          targetInfo.url.endsWith('/out/renderer/index.html')
        )
          resolve(targetInfo.targetId);
      };
      removeTargetListeners = () => {
        browser.events.off('Target.targetCreated', found);
        browser.events.off('Target.targetInfoChanged', found);
      };
      browser.events.on('Target.targetCreated', found);
      browser.events.on('Target.targetInfoChanged', found);
    });
    await browser.send('Target.setDiscoverTargets', { discover: true });
    const target = await deadline(targetReady, `${label}: renderer target`).finally(
      removeTargetListeners,
    );
    const renderer = await connect(new URL(`/devtools/page/${target}`, browserUrl).href, sockets);
    renderer.events.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails));
    renderer.events.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error') errors.push(event.args);
    });
    // TargetのURLはナビゲーション開始時点で変わる。古いabout:blankのcontextへ
    // DOM待機を注入しないよう、main側のload完了を待ってからrendererを操作する。
    await mainEvaluate(`new Promise((resolve, reject) => {
      const contents = __nlrTest.require('electron').BrowserWindow.getAllWindows()[0].webContents;
      if (!contents.isLoadingMainFrame()) { resolve(true); return; }
      const cleanup = () => { contents.off('did-finish-load', done); contents.off('did-fail-load', failed); };
      const done = () => { cleanup(); resolve(true); };
      const failed = (_event, code, description, _url, mainFrame) => {
        if (mainFrame) { cleanup(); reject(new Error('renderer initial load: ' + code + ' ' + description)); }
      };
      contents.once('did-finish-load', done);
      contents.on('did-fail-load', failed);
    })`);
    await renderer.send('Runtime.enable');
    const evaluate = async (expression) =>
      value(
        await renderer.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }),
      );
    const waitForDom = (condition) =>
      evaluate(`new Promise((resolve, reject) => {
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`${label}: DOM ${condition}`)})); }, 12000);
      const observer = new MutationObserver(check);
      function check() { if (${condition}) { clearTimeout(timer); observer.disconnect(); resolve(true); } }
      observer.observe(document, { childList: true, subtree: true, attributes: true });
      check();
    })`);
    await waitForDom('window.api && document.querySelector(".status-band")');
    return {
      evaluate,
      mainEvaluate,
      waitForDom,
      errors,
      dispose,
      forceExit,
      async waitForChildExit() {
        await waitForChildExit([...ownedChildren], `${label}: child exit`);
        ownedChildren.clear();
      },
      async reloadRenderer(crash = false) {
        await mainEvaluate(
          `new Promise(resolve => {
          const contents = __nlrTest.require("electron").BrowserWindow.getAllWindows()[0].webContents;
          const reload = () => { contents.once("did-finish-load", () => resolve(true)); contents.reload(); };
          if (${crash}) {
            __nlrTest.expectedRendererCrashes.add(contents);
            contents.once("render-process-gone", reload);
            contents.forcefullyCrashRenderer();
          }
          else reload();
        })`,
        );
        await waitForDom('window.api && document.querySelector(".status-band")');
      },
      output: () => output,
      async secondInstance() {
        const second = spawn(binary ?? executable ?? electron, binary ? [] : [root], {
          cwd: work,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        observeOutput(second);
        const secondClosed = once(second, 'close');
        void secondClosed.catch(() => {});
        try {
          const [code, signal] = await deadline(secondClosed, 'second instance output drain');
          assert.equal(code, 0, `Second instance exited: ${code}/${signal}`);
        } finally {
          if (second.pid && second.exitCode === null && second.signalCode === null) {
            const stopped = once(second, 'exit');
            second.kill('SIGKILL');
            await deadline(stopped, 'second instance cleanup');
          }
          await deadline(secondClosed, 'second instance cleanup output drain');
        }
      },
      async quit() {
        // 応答を返してから通常の終了イベントへ進む。OSのkillで代用しない。
        await mainEvaluate('setImmediate(() => __nlrTest.require("electron").app.quit()); true');
        for (const socket of sockets) socket.terminate();
        sockets.clear();
        const [code, signal] = await deadline(closed, 'normal app quit', 25_000);
        assert.equal(code, 0, `Electron quit: ${code}/${signal}\n${output}`);
      },
    };
  } catch (error) {
    console.error(output);
    error.message = `${label}: ${error.message}\n${output}`;
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${label}: startup and cleanup failed`, {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

/** 実際のspawnは維持し、親がクラッシュしても外側から所有する子を片付けられるようにする。 */
function observeChildren(require) {
  const childProcess = require('node:child_process');
  const spawn = childProcess.spawn;
  globalThis.__nlrTest.children = [];
  childProcess.spawn = function (...args) {
    const child = spawn.apply(this, args);
    child.once('spawn', () => {
      globalThis.__nlrTest.children.push(child.pid);
      process.stderr.write(`NLR_TEST_CHILD_SPAWN ${child.pid}\n`);
    });
    child.once('exit', () => process.stderr.write(`NLR_TEST_CHILD_EXIT ${child.pid}\n`));
    return child;
  };
}

async function waitForChildExit(pids, label) {
  // OSのプロセス終了はイベント購読できないため、上限付きで生存を調べる。
  const until = Date.now() + 5000;
  for (;;) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        return false;
      }
    });
    if (!alive.length) return;
    if (Date.now() >= until) throw new Error(`${label}: remaining PIDs ${alive.join(', ')}`);
    await delay(50);
  }
}
