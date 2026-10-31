/** 接続先とAPI応答だけを隔離し、WebSocket・鍵生成・復号・検知はElectron内の本体を通す。 */
export function prepareDetectionMain(_require, { pushOrigin }) {
  const agent = globalThis.__nlrTest.agent;
  globalThis.__nlrTest.allowNetworkOrigin(pushOrigin.replace(/^ws/, 'http'));
  const NativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      if (String(url) !== 'wss://push.services.mozilla.com')
        throw new Error(`Unexpected push URL: ${url}`);
      super(pushOrigin, protocols);
    }
  };
  agent.get('https://account.nicovideo.jp').intercept({ path: '/sw.js' }).reply(200, '').persist();
  agent
    .get('https://api.push.nicovideo.jp')
    .intercept({ path: '/v1/nicopush/webpush/endpoints.json', method: 'POST' })
    .reply(200, '')
    .persist();
  agent
    .get('https://push.example')
    .intercept({ path: /.*/, method: 'POST' })
    .reply(201, '')
    .persist();
  agent
    .get('https://live.nicovideo.jp')
    .intercept({ path: '/front/api/pages/follow/v1/programs?status=onair&offset=0' })
    .reply(200, { data: { programs: [] } })
    .persist();
}
