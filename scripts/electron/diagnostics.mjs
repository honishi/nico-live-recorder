import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** stdout/stderrの分割境界に依存せず、終了処理中の失敗も取りこぼさない。 */
export function createOutputDiagnostics(errors) {
  const pending = new Map();
  const inspect = (line) => {
    if (
      /UnhandledPromiseRejection|Unhandled promise rejection|DeprecationWarning|\(electron\).*\bdeprecated\b|\bERROR\s|tray icon not found:/.test(
        line,
      )
    )
      errors.push(line);
  };
  return {
    append(stream, data) {
      const lines = ((pending.get(stream) ?? '') + data).split('\n');
      pending.set(stream, lines.pop());
      for (const line of lines) inspect(line);
    },
    finish(stream) {
      const streams = stream === undefined ? [...pending.keys()] : [stream];
      for (const key of streams) {
        if (pending.has(key)) inspect(pending.get(key));
        pending.delete(key);
      }
    },
  };
}

/** 再起動前のappも含め、プロセス終了後に全インスタンスと永続ログを検査する。 */
export async function verifyScenarioDiagnostics(apps, work) {
  const failures = apps.flatMap((app, index) =>
    app.errors.map((error) => new Error(`Electron ${index}: ${JSON.stringify(error)}`)),
  );
  for (const file of ['app.log.1', 'app.log']) {
    const log = await readFile(path.join(work, 'userdata/logs', file), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    for (const line of log.split('\n')) {
      if (/\bERROR\s|tray icon not found:/.test(line)) failures.push(new Error(`${file}: ${line}`));
    }
  }
  if (failures.length)
    throw new AggregateError(failures, failures.map((e) => e.message).join('\n'));
}
