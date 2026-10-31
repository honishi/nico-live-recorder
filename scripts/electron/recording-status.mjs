/** 状態通知を購読してから初期値を読み、変化を取りこぼさずに待つ。 */
export function waitForStatus(app, condition) {
  return app.evaluate(`new Promise((resolve, reject) => {
    let last;
    const unsubscribe = window.api.onStatusChanged(check);
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(${JSON.stringify(`status: ${condition}`)} + ": last=" + JSON.stringify(last))); }, 12000);
    function check(status) {
      last = status;
      if (${condition}) { clearTimeout(timer); unsubscribe(); resolve(status); }
    }
    window.api.getStatus().then(check, error => { clearTimeout(timer); unsubscribe(); reject(error); });
  })`);
}

export async function waitForRecording(app, condition) {
  const status = await waitForStatus(
    app,
    `status.recordings.some(recording => recording.programId === 'lv42' && (${condition}))`,
  );
  return status.recordings.find((recording) => recording.programId === 'lv42');
}
