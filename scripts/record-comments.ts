// 開発用: コメント取得だけを試す。番組 ID を省略すると直近の放送からコメント数が最多のものを選ぶ
//   npx tsx scripts/record-comments.ts [lvXXXX] [秒数] [出力ファイル]
import path from 'node:path';
import { createConsoleLogger } from '../src/main/core/logger';
import { recordComments } from '../src/main/core/recorder/comment-recorder';
import { NicoClient } from '../src/main/nico-client/NicoClient';

const RECENT_URL = 'https://live.nicovideo.jp/front/api/pages/recent/v1/programs';

async function pickBusiestRecentProgram(): Promise<string> {
  const response = await fetch(RECENT_URL, { headers: { 'user-agent': 'Mozilla/5.0' } });
  const json = (await response.json()) as { data: { id: string }[] };
  const ids = json.data.slice(0, 8).map((p) => p.id);
  const infos = await Promise.all(
    ids.map(async (id) => ({ id, info: await new NicoClient(id).getProgramInfo() })),
  );
  infos.sort((a, b) => b.info.commentCount - a.info.commentCount);
  const best = infos[0];
  console.log(`target ${best.id} "${best.info.title}" comments=${best.info.commentCount}`);
  return best.id;
}

async function main(): Promise<void> {
  const [idArg, secondsArg, outArg] = process.argv.slice(2);
  const programId = idArg && /^lv\d+$/.test(idArg) ? idArg : await pickBusiestRecentProgram();
  const seconds = Number(secondsArg ?? 30);
  const outputPath = path.resolve(outArg ?? `./recordings/${programId}.comments.jsonl`);
  const logger = createConsoleLogger('comments');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), seconds * 1000);
  const result = await recordComments({ programId, outputPath, logger }, controller.signal);
  console.log(result);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
