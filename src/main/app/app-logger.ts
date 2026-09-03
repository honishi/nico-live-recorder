import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Logger } from '../core/logger';
import type { LogCategory, LogEntry, LogLevel } from '../../shared/types';

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const RING_BUFFER_SIZE = 2000;

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ?? `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === 'string') {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
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
 */
export class AppLogger extends EventEmitter<{ entry: [entry: LogEntry] }> implements Logger {
  private readonly filePath: string;
  private readonly entries: LogEntry[] = [];
  private stream?: fs.WriteStream;
  private minLevel: LogLevel;

  constructor(logDir: string, minLevel: LogLevel = 'info') {
    super();
    fs.mkdirSync(logDir, { recursive: true });
    this.filePath = path.join(logDir, 'app.log');
    this.minLevel = minLevel;
    this.rotateIfNeeded();
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
  }

  get logFilePath(): string {
    return this.filePath;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  recent(limit = RING_BUFFER_SIZE): LogEntry[] {
    return this.entries.slice(-limit);
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

  close(): void {
    this.stream?.end();
    this.stream = undefined;
  }

  private write(level: LogLevel, args: unknown[]): void {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (order.indexOf(level) < order.indexOf(this.minLevel)) {
      return;
    }
    const message = args.map(formatArg).join(' ');
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      category: categorize(message),
      message,
    };
    const line = `${entry.ts} ${level.toUpperCase().padEnd(5)} ${entry.message}\n`;
    if (level === 'error') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
    this.stream?.write(line);
    this.entries.push(entry);
    if (this.entries.length > RING_BUFFER_SIZE) {
      this.entries.splice(0, this.entries.length - RING_BUFFER_SIZE);
    }
    this.emit('entry', entry);
  }

  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size > MAX_LOG_FILE_BYTES) {
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      }
    } catch {
      // ファイルが無ければ何もしない
    }
  }
}
