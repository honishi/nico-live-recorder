// userData は ready より前に設定するため、同期ロードできる main エントリーを使う。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app } = require('electron');

// 実 Electron の main として起動する。ユーザーの設定には触れない。
if (!process.env.NLR_USER_DATA) throw new Error('NLR_USER_DATA is required');
app.setPath('userData', process.env.NLR_USER_DATA);
app.whenReady().then(async () => {
  try {
    const { verifyHttpRecovery, verifyWebSocketRecovery } =
      await import('../../test/helpers/network-runtime.mjs');
    const { default: Ws } = await import('ws');
    console.log('Electron main runtime:', JSON.stringify(process.versions));
    await verifyHttpRecovery();
    await verifyWebSocketRecovery(globalThis.WebSocket);
    await verifyWebSocketRecovery(Ws);
    console.log('Electron network OK: HTTP recovery, Brotli, native/ws WebSocket, PING/PONG');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
