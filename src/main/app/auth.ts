import { EventEmitter } from 'node:events';
import { BrowserWindow, session, type Cookie } from 'electron';
import type { Logger } from '../core/logger';

const NICO_ORIGIN = 'https://www.nicovideo.jp';
const LOGIN_URL = 'https://account.nicovideo.jp/login?site=niconico';
const SESSION_COOKIE = 'user_session';

/**
 * ニコニコのログイン状態。アプリ内の BrowserWindow でログインしてもらい、
 * Electron の session に保存された cookie を API 呼び出しに使う。
 */
export class NicoAuth extends EventEmitter<{ change: [loggedIn: boolean] }> {
  private loginWindow?: BrowserWindow;
  /** 再ログイン時はログイン中のままでも画面のアカウント依存キャッシュを破棄する */
  revision = 0;

  constructor(private readonly logger: Logger) {
    super();
    this.on('change', () => {
      this.revision += 1;
    });
  }

  private get cookies(): Electron.Cookies {
    return session.defaultSession.cookies;
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.getUserSession()) !== undefined;
  }

  async getUserSession(): Promise<string | undefined> {
    const found = await this.cookies.get({ url: NICO_ORIGIN, name: SESSION_COOKIE });
    return found.find((c) => c.value.length > 0)?.value;
  }

  /** nicovideo.jp ドメインの cookie をまとめた Cookie ヘッダ。未ログインなら undefined */
  async getCookieHeader(): Promise<string | undefined> {
    const all = await this.cookies.get({ url: NICO_ORIGIN });
    if (!all.some((c) => c.name === SESSION_COOKIE && c.value.length > 0)) {
      return undefined;
    }
    return uniqueByName(all)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  async getCookieRecord(): Promise<Record<string, string> | undefined> {
    const header = await this.getCookieHeader();
    if (!header) {
      return undefined;
    }
    const record: Record<string, string> = {};
    for (const pair of header.split('; ')) {
      const index = pair.indexOf('=');
      if (index > 0) {
        record[pair.slice(0, index)] = pair.slice(index + 1);
      }
    }
    return record;
  }

  /**
   * ログインウィンドウを開き、user_session cookie が得られるまで待つ。
   * ユーザーが閉じた場合は false を返す
   */
  async login(parent?: BrowserWindow): Promise<boolean> {
    if (this.loginWindow) {
      this.loginWindow.focus();
      return false;
    }
    const window = new BrowserWindow({
      width: 520,
      height: 720,
      parent,
      title: 'ニコニコにログイン',
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.loginWindow = window;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.loginWindow = undefined;
        if (!window.isDestroyed()) {
          window.close();
        }
        resolve(result);
        if (result) {
          this.emit('change', true);
        }
      };
      const check = async (): Promise<void> => {
        if (settled || window.isDestroyed()) {
          return;
        }
        if (await this.isLoggedIn()) {
          this.logger.info('auth: login detected');
          finish(true);
        }
      };
      window.webContents.on('did-navigate', () => void check());
      window.webContents.on('did-navigate-in-page', () => void check());
      window.webContents.on('did-finish-load', () => void check());
      window.on('closed', () => finish(false));
      void window.loadURL(LOGIN_URL);
    });
  }

  async logout(): Promise<void> {
    const all = await this.cookies.get({ url: NICO_ORIGIN });
    for (const cookie of all) {
      const url = `https://${cookie.domain?.replace(/^\./, '') ?? 'www.nicovideo.jp'}${cookie.path ?? '/'}`;
      await this.cookies.remove(url, cookie.name).catch(() => undefined);
    }
    this.logger.info('auth: logged out');
    this.emit('change', false);
  }
}

function uniqueByName(cookies: Cookie[]): Cookie[] {
  const map = new Map<string, Cookie>();
  for (const cookie of cookies) {
    const existing = map.get(cookie.name);
    // 親ドメイン (.nicovideo.jp) の cookie を優先する
    if (!existing || (cookie.domain?.startsWith('.') && !existing.domain?.startsWith('.'))) {
      map.set(cookie.name, cookie);
    }
  }
  return [...map.values()];
}
