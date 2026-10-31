import assert from 'node:assert/strict';

/** 実contextBridgeを通し、引数・解除・再購読を同じチャネルの通知で検査する。 */
export async function verifyPreloadEvents(app) {
  // 録画進捗やログの自然発生と混ざらないよう、この契約検査中のmain通知だけを保留する。
  // IPC・contextBridge・rendererのリスナーは本物のまま、同じsendで検査用通知を送る。
  await app.mainEvaluate(`(() => {
    const contents = __nlrTest.require('electron').BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send;
    __nlrTest.contractSend = (...args) => send.apply(contents, args);
    __nlrTest.restoreSend = () => { contents.send = send; delete __nlrTest.contractSend; delete __nlrTest.restoreSend; };
    contents.send = function(channel, ...args) {
      if (!['app:settingsChanged', 'app:logsChanged', 'app:statusChanged'].includes(channel)) return send.call(this, channel, ...args);
    };
  })()`);
  try {
    for (const [method, channel, payload] of [
      ['onSettingsChanged', 'app:settingsChanged', []],
      ['onLogsChanged', 'app:logsChanged', [[]]],
      ['onStatusChanged', 'app:statusChanged', [await app.evaluate('window.api.getStatus()')]],
    ]) {
      await app.evaluate(`(() => {
      const state = window.__eventContract = { calls: [] };
      state.off = window.api.${method}((...args) => state.calls.push(args));
      state.next = new Promise(resolve => { state.barrier = window.api.${method}(() => resolve()); });
    })()`);
      const send = () =>
        app.mainEvaluate(
          `__nlrTest.contractSend(${JSON.stringify(channel)}, ...${JSON.stringify(payload)}); true`,
        );
      try {
        await send();
        await app.evaluate('window.__eventContract.next');
        assert.deepEqual(await app.evaluate('window.__eventContract.calls'), [payload], method);
        // 2回目の通知の到着を別リスナーで待つため、解除の確認にsleepは要らない。
        await app.evaluate(`(() => {
        const state = window.__eventContract;
        state.off(); state.off(); state.barrier();
        state.next = new Promise(resolve => { state.barrier = window.api.${method}(() => resolve()); });
      })()`);
        await send();
        await app.evaluate('window.__eventContract.next');
        assert.deepEqual(
          await app.evaluate('window.__eventContract.calls'),
          [payload],
          `${method}: unsubscribe`,
        );
        await app.evaluate(`(() => {
        const state = window.__eventContract;
        state.barrier();
        state.off = window.api.${method}((...args) => state.calls.push(args));
        state.next = new Promise(resolve => { state.barrier = window.api.${method}(() => resolve()); });
      })()`);
        await send();
        await app.evaluate('window.__eventContract.next');
        assert.deepEqual(
          await app.evaluate('window.__eventContract.calls'),
          [payload, payload],
          `${method}: resubscribe`,
        );
      } finally {
        await app.evaluate(
          'window.__eventContract.off(); window.__eventContract.barrier(); delete window.__eventContract',
        );
      }
    }
  } finally {
    await app.mainEvaluate('__nlrTest.restoreSend(); true');
  }
}
