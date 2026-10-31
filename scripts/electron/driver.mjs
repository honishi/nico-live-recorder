import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import WebSocket from 'ws';

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
    if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
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

function value(result) {
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

/** 本番コードにテスト用IPCを足さず、最初のmain文の実行前に隔離設定を注入する。 */
export async function launchElectron({ work, binary, prepareMain, config = {} }) {
  const sockets = new Set();
  const errors = [];
  let output = '';
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
  const child = spawn(binary ?? electron, args, {
    cwd: work,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  // 起動失敗時にも exit の監視を未処理のrejectionにしない。
  void exited.catch(() => {});
  const changed = new EventEmitter();
  const append = (data) => {
    output = (output + data).slice(-64_000);
    changed.emit('output');
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const debuggerUrl = (pattern) =>
    deadline(
      new Promise((resolve, reject) => {
        const check = () => {
          const url = output.match(pattern)?.[1];
          if (url) {
            cleanup();
            resolve(url);
          }
        };
        const fail = (error) => {
          cleanup();
          reject(error);
        };
        const stopped = (code, signal) =>
          fail(new Error(`Electron exited before ready: ${code}/${signal}`));
        const cleanup = () => {
          changed.off('output', check);
          child.off('error', fail);
          child.off('exit', stopped);
        };
        changed.on('output', check);
        child.once('error', fail);
        child.once('exit', stopped);
        check();
      }),
      'debugger startup',
    );
  const dispose = async () => {
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      // 正常系は quit() を使う。ここは失敗した検証プロセスだけを終了させる。
      child.kill('SIGKILL');
      await deadline(exited, 'forced exit', 5000);
    }
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
      ? `(${prepareMain.toString()})(__nlrTest.require, ${JSON.stringify(config)})`
      : '';
    value(
      await main.send('Debugger.evaluateOnCallFrame', {
        callFrameId: pause.callFrames[0].callFrameId,
        expression: `globalThis.__nlrTest = { require: process.getBuiltinModule("module").createRequire(${requireBase}) }; ${prepare}; true`,
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
    const targetReady = new Promise((resolve) => {
      const found = ({ targetInfo }) => {
        if (
          targetInfo.type === 'page' &&
          targetInfo.url.startsWith('file:') &&
          targetInfo.url.endsWith('/out/renderer/index.html')
        )
          resolve(targetInfo.targetId);
      };
      browser.events.on('Target.targetCreated', found);
      browser.events.on('Target.targetInfoChanged', found);
    });
    await browser.send('Target.setDiscoverTargets', { discover: true });
    const target = await deadline(targetReady, 'renderer target');
    const renderer = await connect(new URL(`/devtools/page/${target}`, browserUrl).href, sockets);
    renderer.events.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails));
    renderer.events.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error') errors.push(event.args);
    });
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
      evaluate(`new Promise(resolve => {
      const observer = new MutationObserver(check);
      function check() { if (${condition}) { observer.disconnect(); resolve(true); } }
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
      output: () => output,
      async secondInstance() {
        const second = spawn(binary ?? electron, binary ? [] : [root], {
          cwd: work,
          env,
          stdio: 'ignore',
        });
        try {
          const [code, signal] = await deadline(once(second, 'exit'), 'second instance exit');
          assert.equal(code, 0, `Second instance exited: ${code}/${signal}`);
        } finally {
          if (second.pid && second.exitCode === null && second.signalCode === null) {
            const stopped = once(second, 'exit');
            second.kill('SIGKILL');
            await deadline(stopped, 'second instance cleanup');
          }
        }
      },
      async quit() {
        // 応答を返してから通常の終了イベントへ進む。OSのkillで代用しない。
        await mainEvaluate('setImmediate(() => __nlrTest.require("electron").app.quit()); true');
        for (const socket of sockets) socket.terminate();
        sockets.clear();
        const [code, signal] = await deadline(exited, 'normal app quit', 25_000);
        assert.equal(code, 0, `Electron quit: ${code}/${signal}\n${output}`);
      },
    };
  } catch (error) {
    console.error(output);
    await dispose();
    throw error;
  }
}
