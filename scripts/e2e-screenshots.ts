// 開発用: ビルド済みのアプリを別 userData で起動し、CDP で各タブのスクリーンショットを撮る。
// ログイン不要の範囲 (未ログイン画面と手動録画) を確認する。
//   npm run build && npx tsx scripts/e2e-screenshots.ts [出力ディレクトリ]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket, { type RawData } from 'ws';

const PORT = 9334;
const outDir = path.resolve(process.argv[2] ?? './recordings/screenshots');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface CdpTarget {
  url: string;
  webSocketDebuggerUrl: string;
}

interface CdpMessage {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: unknown; data?: string };
}

async function pickLiveProgram(): Promise<string> {
  const response = await fetch('https://live.nicovideo.jp/front/api/pages/recent/v1/programs', {
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
  const json = (await response.json()) as { data: { id: string }[] };
  return json.data[2].id;
}

async function main(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  const userData = path.join(outDir, 'userdata');
  const log = fs.createWriteStream(path.join(outDir, 'electron.log'));
  const child = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    // 設定も保存先も出力ディレクトリの中に閉じ込め、本番の録画に触らない
    env: {
      ...process.env,
      NLR_USER_DATA: userData,
      NLR_OUTPUT_DIR: path.join(outDir, 'recordings'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  // renderer の CDP ターゲットが現れるまで待つ
  let target: CdpTarget | undefined;
  for (let i = 0; i < 40 && !target; i += 1) {
    await sleep(500);
    try {
      const list = (await (await fetch(`http://localhost:${PORT}/json`)).json()) as CdpTarget[];
      target = list.find((t) => t.url.includes('index.html'));
    } catch {
      // まだ起動中
    }
  }
  if (!target) {
    child.kill('SIGTERM');
    throw new Error('renderer target not found (別のインスタンスが動いていないか確認)');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.once('open', resolve));
  let nextId = 0;
  const pending = new Map<number, (message: CdpMessage) => void>();
  ws.on('message', (raw: RawData) => {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.from(raw as ArrayBuffer).toString('utf8');
    const message = JSON.parse(text) as CdpMessage;
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> =>
    new Promise((resolve) => {
      nextId += 1;
      pending.set(nextId, resolve);
      ws.send(JSON.stringify({ id: nextId, method, params }));
    });
  const evaluate = async (expression: string): Promise<unknown> => {
    const message = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (message.result?.exceptionDetails) {
      throw new Error(JSON.stringify(message.result.exceptionDetails));
    }
    return message.result?.result?.value;
  };
  const shot = async (name: string): Promise<void> => {
    await sleep(400);
    const message = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      path.join(outDir, `${name}.png`),
      Buffer.from(message.result?.data ?? '', 'base64'),
    );
    console.log('shot', name);
  };
  const clickTab = async (index: number): Promise<void> => {
    await evaluate(`document.querySelectorAll('.tab')[${index}].click()`);
    await sleep(300);
  };

  await sleep(1500);
  await shot('01-recordings');
  await clickTab(1);
  await shot('02-targets');
  await clickTab(2);
  await shot('03-history');
  await clickTab(3);
  await shot('04-log');
  await clickTab(4);
  await shot('05-settings');

  // 手動録画を 12 秒だけ回して止める
  await clickTab(0);
  const programId = await pickLiveProgram();
  console.log(
    'recording',
    programId,
    await evaluate(`window.api.startRecording(${JSON.stringify(programId)}).then((r) => r.state)`),
  );
  await sleep(12000);
  await shot('06-recording');
  await evaluate(`window.api.stopRecording(${JSON.stringify(programId)})`);
  await sleep(4000);
  await shot('07-after-stop');
  await clickTab(3);
  await shot('08-log-after');
  console.log(
    JSON.stringify(await evaluate('window.api.getStatus().then((s) => s.recordings)'), null, 1),
  );

  ws.close();
  child.kill('SIGTERM');
  await sleep(1500);
  console.log(`screenshots: ${outDir}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
