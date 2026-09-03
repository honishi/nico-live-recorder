export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function timestamp(): string {
  return new Date().toISOString();
}

export function createConsoleLogger(prefix = ''): Logger {
  const tag = prefix ? `[${prefix}]` : '';
  return {
    debug: (...args) => console.debug(timestamp(), 'DEBUG', tag, ...args),
    info: (...args) => console.info(timestamp(), 'INFO ', tag, ...args),
    warn: (...args) => console.warn(timestamp(), 'WARN ', tag, ...args),
    error: (...args) => console.error(timestamp(), 'ERROR', tag, ...args),
  };
}

export function prefixLogger(base: Logger, prefix: string): Logger {
  const tag = `[${prefix}]`;
  return {
    debug: (...args) => base.debug(tag, ...args),
    info: (...args) => base.info(tag, ...args),
    warn: (...args) => base.warn(tag, ...args),
    error: (...args) => base.error(tag, ...args),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
