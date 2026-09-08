// 終了済み放送の接続条件を、アプリのコードを変更せずに確認する。使い方は docs/timeshift-probe.md。
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  checkedFetch,
  errorSummary,
  parseOptions,
  parsePage,
  ProbeError,
} from './timeshift-probe/common';
import { sampleVideo } from './timeshift-probe/video';
import { sampleComments } from './timeshift-probe/comments';
import { observeSession, type ProbeSession } from './timeshift-probe/session';

const HELP = `使い方:
  npx tsx scripts/timeshift-probe.ts <lv番号|視聴URL> --anonymous [オプション]
  NICO_USER_SESSION を設定した場合は --anonymous を外してください。

  --mode inspect|video|comments  既定: inspect（接続情報まで）
  --label standard              比較条件のラベル（英数字・ハイフン・下線）
  --media-seconds 30             video のメディア長（秒、セグメント境界へ切り上げ）
  --comment-limit 1000           comments の保存件数上限
  --view-at now|beginning|数値   beginning は at を省略、数値は at にそのまま指定
  --timeout 120                 全工程の実行時間上限（秒、最大600）
  --out .cache/timeshift-probe   実行ごとにサブディレクトリを作成
`;

async function main(): Promise<void> {
  // parseArgs の例外には入力値が含まれ得るため、生の例外を表示しない。
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch {
    console.error(
      '入力を確認してください。セッションは引数ではなく NICO_USER_SESSION に設定します。\n' + HELP,
    );
    process.exitCode = 1;
    return;
  }
  if (!options) {
    console.log(HELP);
    return;
  }
  const startedAt = new Date().toISOString();
  const baseDir = path.resolve(options.out);
  await fs.mkdir(baseDir, { recursive: true });
  const dir = await fs.mkdtemp(path.join(baseDir, `${options.programId}-${options.label}-`));
  await fs.chmod(dir, 0o700);
  const report: Record<string, unknown> = {
    schemaVersion: 2,
    startedAt,
    programId: options.programId,
    label: options.label,
    mode: options.mode,
    credentialInput: options.session ? 'session' : 'anonymous',
    limits: {
      mediaSeconds: options.mediaSeconds,
      commentLimit: options.commentLimit,
      timeoutSeconds: options.timeout,
    },
    viewAt: options.viewAt,
    status: 'running',
    fullCoverage: 'not-verified',
  };
  const stop = new AbortController();
  const deadline = AbortSignal.timeout(options.timeout * 1000);
  const signal = AbortSignal.any([stop.signal, deadline]);
  const onInterrupt = (): void => stop.abort();
  process.once('SIGINT', onInterrupt);
  let stage = 'page';
  let session: ProbeSession | undefined;
  const saveReport = async (): Promise<void> => {
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  };
  try {
    await saveReport();
    const cookie = options.session ? `user_session=${options.session}` : undefined;
    const page = parsePage(
      await (
        await checkedFetch(`https://live.nicovideo.jp/watch/${options.programId}`, signal, cookie)
      ).text(),
    );
    report.page = page.summary;
    if (page.summary.status !== 'ENDED') throw new ProbeError('NOT_ENDED_PROGRAM');
    if (!page.webSocketUrl) throw new ProbeError('WATCH_URL_MISSING');

    stage = 'websocket';
    console.log('視聴接続を確認しています…');
    session = await observeSession(page.webSocketUrl, cookie, signal);
    const { summary: socketSummary, viewUri } = session;
    report.websocket = socketSummary;
    signal.throwIfAborted();
    await saveReport();
    if (options.mode === 'inspect') {
      report.status =
        socketSummary.hasHls && socketSummary.hasComments
          ? 'connection-observed'
          : 'partial-or-unavailable';
    } else if (options.mode === 'video') {
      stage = 'video';
      const stream = session.stream;
      if (!stream) throw new ProbeError('HLS_NOT_RECEIVED');
      console.log('映像・音声の短区間を取得しています…');
      const result = await sampleVideo(stream, dir, options.mediaSeconds, signal, (summary) => {
        report.video = summary;
      });
      report.video = result;
      report.status = result.status;
    } else {
      stage = 'comments';
      if (!viewUri) throw new ProbeError('COMMENT_URI_NOT_RECEIVED');
      console.log('過去コメントのサンプルを取得しています…');
      const result = await sampleComments(
        viewUri,
        dir,
        options.commentLimit,
        options.viewAt,
        signal,
        (summary) => {
          report.comments = summary;
        },
      );
      report.comments = result;
      report.status = result.status;
    }
  } catch (error) {
    report.status = deadline.aborted ? 'timeout' : stop.signal.aborted ? 'interrupted' : 'failed';
    report.failure = { stage, ...errorSummary(error) };
  } finally {
    session?.close();
    process.removeListener('SIGINT', onInterrupt);
    report.endedAt = new Date().toISOString();
    await saveReport();
  }
  console.log(JSON.stringify(report, null, 2));
  console.log(`結果: ${path.join(dir, 'report.json')}`);
  console.log('全編取得・音声同期は未検証です。共有には report.json を使用してください。');
  process.exitCode = ['connection-observed', 'sample-saved'].includes(String(report.status))
    ? 0
    : 2;
}

main().catch(() => {
  console.error('検証の初期化または結果の保存に失敗しました。');
  process.exitCode = 1;
});
