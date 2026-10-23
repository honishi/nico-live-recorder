import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';

/** 実際の HTTP ストリームを使い、空きポートと終了処理をテストごとに分離する。 */
export async function startFakeHttp(listener: RequestListener): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP server address unavailable');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (!server.listening) return;
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
