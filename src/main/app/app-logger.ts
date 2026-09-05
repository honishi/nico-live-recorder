import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { EventEmitter } from 'node:events';
import type { Logger } from '../core/logger';
import type { LogCategory, LogEntry, LogLevel } from '../../shared/types';

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
/** info 以上と debug をそれぞれ何件まで保持するか。debug は録画中に 1 時間で数千件出るので、別枠にして info を押し出さない */
const RING_BUFFER_SIZE = 2000;

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ?? `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === 'string') {
    return arg;
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(arg);
  } catch {
    json = undefined;
  }
  if (json !== undefined && json !== '{}') {
    return json;
  }
  if (typeof arg !== 'object' || arg === null) {
    return String(arg);
  }
  // Event のように列挙されるプロパティを持たないものは、inspect の結果に
  // getter で取れる message / code を添えて、{} で情報が消えないようにする
  const hints = describeHiddenFields(arg);
  const inspected = util.inspect(arg, { depth: 3, breakLength: Infinity });
  if (inspected === '{}') {
    return hints || inspected;
  }
  return hints ? `${inspected} ${hints}` : inspected;
}

function describeHiddenFields(value: object): string {
  const source = value as { message?: unknown; code?: unknown; error?: unknown };
  const inner = source.error as { message?: unknown; code?: unknown } | undefined;
  const fields: Array<[string, unknown]> = [
    ['message', source.message],
    ['code', source.code],
    ['error', inner?.message ?? inner?.code],
  ];
  return fields
    .filter(([, v]) => (typeof v === 'string' && v.length > 0) || typeof v === 'number')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
}

/** 先頭の `[tag]` 列から出所を判定する (例: `[lv123] [comments] ...` → comments) */
export function categorize(message: string): LogCategory {
  const tags = [...message.matchAll(/^\s*(?:\[([^\]]+)\]\s*)+/g)].flatMap((m) =>
    [...m[0].matchAll(/\[([^\]]+)\]/g)].map((t) => t[1].toLowerCase()),
  );
  for (const tag of tags) {
    if (tag === 'push' || tag === 'autopush') {
      return 'push';
    }
    if (tag === 'rec') {
      return 'rec';
    }
    if (tag === 'detector' || tag === 'poll') {
      return 'poll';
    }
    if (tag === 'comments') {
      return 'comments';
    }
  }
  return 'app';
}

/**
 * アプリ全体のロガー。標準出力、ファイル (userData/logs/app.log)、
 * UI 表示用のリングバッファに書く。
 * リングバッファは debug も含めて常に保持し (UI の「debug を表示」で出し分ける)、
 * 標準出力とファイルは outputLevel 以上だけを書く。
 */
export class AppLogger extends EventEmitter<{ entry: [entry: LogEntry] }> implements Logger {
  private readonly filePath: string;
  /** info 以上のログ (ユーザーが見るもの) */
  private readonly entries: Numbered[] = [];
  /** debug のログ。量が多いので別に持ち、「debug を表示」のときだけ合流させる */
  private readonly debugEntries: Numbered[] = [];
  /** 2 つのバッファを出た順に合流させるための連番 (同じミリ秒でも順序が崩れない) */
  private seq = 0;
  private stream?: fs.WriteStream;
  /** 保存エラー後はファイルだけを止め、標準出力と画面のログは続ける */
  private fileFailed = false;
  private fileBytes = 0;
  /** 退避 (古いストリームを閉じて .1 に移し、開き直す) の進行中。その間の行は queued に溜める */
  private rotating?: Promise<void>;
  private readonly queued: string[] = [];
  private outputLevel: LogLevel;

  constructor(
    logDir: string,
    outputLevel: LogLevel = 'info',
    private readonly maxFileBytes = MAX_LOG_FILE_BYTES,
  ) {
    super();
    fs.mkdirSync(logDir, { recursive: true });
    this.filePath = path.join(logDir, 'app.log');
    this.outputLevel = outputLevel;
    this.openStream();
  }

  get logFilePath(): string {
    return this.filePath;
  }

  /** 標準出力とファイルに書く最低レベル (リングバッファには影響しない) */
  setOutputLevel(level: LogLevel): void {
    this.outputLevel = level;
  }

  getOutputLevel(): LogLevel {
    return this.outputLevel;
  }

  /**
   * 直近のログを時刻順に返す。limit は info 以上と debug のそれぞれに掛かるので、
   * debug を含めても info 以上のログが直近の debug に押し出されて見えなくなることはない
   */
  recent(limit = RING_BUFFER_SIZE, includeDebug = true): LogEntry[] {
    const main = this.entries.slice(-limit);
    const merged = includeDebug ? mergeBySeq(main, this.debugEntries.slice(-limit)) : main;
    return merged.map((n) => n.entry);
  }

  debug(...args: unknown[]): void {
    this.write('debug', args);
  }

  info(...args: unknown[]): void {
    this.write('info', args);
  }

  warn(...args: unknown[]): void {
    this.write('warn', args);
  }

  error(...args: unknown[]): void {
    this.write('error', args);
  }

  /** ファイルへの書き込みを終えるまで待つ */
  async close(): Promise<void> {
    // 退避の途中なら、溜めた行を書き終えてから閉じる
    await this.rotating;
    await this.closeStream();
  }

  private write(level: LogLevel, args: unknown[]): void {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const message = args.map(formatArg).join(' ');
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      category: categorize(message),
      message,
    };
    if (order.indexOf(level) >= order.indexOf(this.outputLevel)) {
      const line = `${entry.ts} ${level.toUpperCase().padEnd(5)} ${entry.message}\n`;
      if (level === 'error') {
        process.stderr.write(line);
      } else {
        process.stdout.write(line);
      }
      this.writeFile(line);
    }
    const ring = level === 'debug' ? this.debugEntries : this.entries;
    ring.push({ seq: (this.seq += 1), entry });
    if (ring.length > RING_BUFFER_SIZE) {
      ring.splice(0, ring.length - RING_BUFFER_SIZE);
    }
    this.emit('entry', entry);
  }

  /** ファイルに追記し、上限を超えたら .1 に退避して新しいファイルに切り替える */
  private writeFile(line: string): void {
    if (this.fileFailed) {
      return;
    }
    if (this.rotating) {
      this.queued.push(line);
      return;
    }
    if (!this.stream) {
      return;
    }
    this.writeLine(this.stream, line);
    if (this.fileBytes > this.maxFileBytes) {
      this.rotating = this.rotate().finally(() => {
        this.rotating = undefined;
      });
    }
  }

  private writeLine(stream: fs.WriteStream, line: string): void {
    stream.write(line);
    this.fileBytes += Buffer.byteLength(line);
  }

  /** 今のファイルを閉じて .1 に移し、新しいファイルを開いて退避中に溜めた行を書く */
  private async rotate(): Promise<void> {
    await this.closeStream();
    if (this.fileFailed) {
      return;
    }
    try {
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // 退避できなくても書き続ける
    }
    this.openStream();
    const stream = this.stream;
    if (stream) {
      for (const line of this.queued.splice(0)) {
        this.writeLine(stream, line);
      }
    }
  }

  private openStream(): void {
    try {
      this.fileBytes = fs.statSync(this.filePath).size;
    } catch {
      this.fileBytes = 0;
    }
    const stream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
    this.stream = stream;
    // close の最中だけでなく、open 直後や通常の追記中のエラーも必ず受け止める
    stream.on('error', (error) => {
      if (this.fileFailed) {
        return;
      }
      this.fileFailed = true;
      this.stream = undefined;
      this.queued.length = 0;
      this.warn(`ログファイルへの出力を停止しました: ${error.message} (画面のログは継続します)`);
    });
  }

  private closeStream(): Promise<void> {
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      stream.once('error', () => resolve());
      stream.end(() => resolve());
    });
  }
}

interface Numbered {
  seq: number;
  entry: LogEntry;
}

/** 連番順の 2 つの列を、出た順のまま 1 つにまとめる */
function mergeBySeq(a: Numbered[], b: Numbered[]): Numbered[] {
  const merged: Numbered[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].seq < b[j].seq)) {
      merged.push(a[i++]);
    } else {
      merged.push(b[j++]);
    }
  }
  return merged;
}
