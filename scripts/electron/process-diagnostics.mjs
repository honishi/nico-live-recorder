/** 起動前から全renderer・補助プロセスを監視し、JS例外にならない異常終了も記録する。 */
export function observeElectronProcesses(app, state, report) {
  state.expectedRendererCrashes = new WeakSet();
  app.on('render-process-gone', (_event, contents, details) => {
    // 復旧検査が指定したwebContentsの、次の意図的なクラッシュだけを除外する。
    const expected = state.expectedRendererCrashes.delete(contents);
    // forcefullyCrashRendererはOSによりcrashedまたはkilledとして通知される。
    if (expected && ['crashed', 'killed'].includes(details.reason)) return;
    if (details.reason !== 'clean-exit')
      report(`ERROR Electron render-process-gone ${JSON.stringify(details)}`);
  });
  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit')
      report(`ERROR Electron child-process-gone ${JSON.stringify(details)}`);
  });
}
