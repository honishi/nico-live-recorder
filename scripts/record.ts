// 開発用: Electron を起動せずに 1 番組を録画する
//   npx tsx scripts/record.ts lv123456789 [録画秒数] [出力ディレクトリ]
// 録画秒数を省略すると番組終了まで録画する。Ctrl-C でも停止できる。
import path from 'node:path';
import { createConsoleLogger } from '../src/main/core/logger';
import { recordProgram } from '../src/main/core/recorder/program-recorder';

const [programId, secondsArg, outDirArg] = process.argv.slice(2);
if (!programId || !/^lv\d+$/.test(programId)) {
  console.error('usage: npx tsx scripts/record.ts lvXXXXXXXX [seconds] [outputDir]');
  process.exit(1);
}
const seconds = secondsArg ? Number(secondsArg) : undefined;
const outputDir = path.resolve(outDirArg ?? './recordings');
const logger = createConsoleLogger('record');

const controller = new AbortController();
if (seconds && seconds > 0) {
  setTimeout(() => {
    logger.info(`${seconds}s elapsed, stopping`);
    controller.abort();
  }, seconds * 1000);
}
process.on('SIGINT', () => {
  logger.info('SIGINT received, stopping');
  controller.abort();
});

const cookies = process.env['NICO_USER_SESSION']
  ? { user_session: process.env['NICO_USER_SESSION'] }
  : undefined;

recordProgram({ programId, outputDir, cookies, logger }, controller.signal)
  .then((result) => {
    logger.info('done', {
      video: result.video && {
        reason: result.video.reason,
        segments: result.video.video.segments,
        bytes: result.video.video.bytes,
        audioBytes: result.video.audio?.bytes,
        ffmpegExitCode: result.video.ffmpegExitCode,
      },
      comments: result.comments?.count,
      errors: result.errors,
      files: [result.videoPath, result.commentsPath, result.metadataPath],
    });
    process.exit(result.errors.length > 0 ? 2 : 0);
  })
  .catch((error) => {
    logger.error('failed', error);
    process.exit(1);
  });
