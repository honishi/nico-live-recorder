import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Logger } from '../core/logger';
import type { LogEntry, LogLevel } from '../../shared/types';

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const RING_BUFFER_SIZE = 500;

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

  recent(): LogEntry[] {
    return [...this.entries];
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
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      message: args.map(formatArg).join(' '),
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
