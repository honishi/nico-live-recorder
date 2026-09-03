/**
 * chrome-nico-alert の push 診断ログの差し替え。
 * 拡張版は chrome.storage に時系列イベントを蓄積していたが、ここでは
 * 登録されたリスナーに流すだけにする (アプリ側でログやトラブルシュート表示に使う)。
 */
export type PushDiagnosticsDetail = Record<string, string | number | boolean | undefined>;

export interface PushDiagnosticsEvent extends PushDiagnosticsDetail {
  ts: string;
  type: string;
}

type Listener = (event: PushDiagnosticsEvent) => void;

class PushDiagnosticsHub {
  private listeners = new Set<Listener>();

  record(type: string, detail: PushDiagnosticsDetail = {}): void {
    if (this.listeners.size === 0) {
      return;
    }
    const event: PushDiagnosticsEvent = { ...detail, ts: new Date().toISOString(), type };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 診断リスナーの失敗で push 処理を止めない
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const pushDiagnostics = new PushDiagnosticsHub();

/** AutoPush の version 文字列は長いので先頭だけ残す */
export function shortVersion(version: unknown): string | undefined {
  if (version === undefined || version === null) {
    return undefined;
  }
  const text = typeof version === 'string' || typeof version === 'number' ? String(version) : '?';
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

/** AutoPush クライアントのログ出力先。既定は何も出さない。アプリ側で差し替える */
export interface PushLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

let currentLogger: PushLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const pushLog: PushLogger = {
  debug: (...args) => currentLogger.debug(...args),
  warn: (...args) => currentLogger.warn(...args),
  error: (...args) => currentLogger.error(...args),
};

export function setPushLogger(logger: PushLogger): void {
  currentLogger = logger;
}
