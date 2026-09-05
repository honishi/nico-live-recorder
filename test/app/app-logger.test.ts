import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { AppLogger, categorize } from '../../src/main/app/app-logger';

describe('categorize', () => {
  test('先頭のタグから出所を判定する', () => {
    expect(categorize('[push] received "x" lv1')).toBe('push');
    expect(categorize('[autopush] WebSocket opened')).toBe('push');
    expect(categorize('[rec] start lv1')).toBe('rec');
    expect(categorize('[detector] poll failed')).toBe('poll');
    expect(categorize('[lv123] [comments] 番組タイトル')).toBe('comments');
    expect(categorize('[lv123] [video] recording')).toBe('app');
    expect(categorize('detection started')).toBe('app');
  });
});

describe('AppLogger', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-logger-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('リングバッファは debug も保持し、ファイルと標準出力は出力レベル以上だけ', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = new AppLogger(dir, 'info');
    logger.debug('[detector] quiet');
    logger.info('[rec] start lv1');
    await logger.close();

    expect(logger.recent().map((e) => [e.level, e.category])).toEqual([
      ['debug', 'poll'],
      ['info', 'rec'],
    ]);
    const file = fs.readFileSync(path.join(dir, 'app.log'), 'utf8');
    expect(file).toContain('[rec] start lv1');
    expect(file).not.toContain('quiet');
    expect(stdout).toHaveBeenCalledTimes(1);
  });

  test.each(['open', 'write'])(
    '%s の保存失敗を警告し、その後も画面と標準出力のログを続ける',
    async (stage) => {
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      if (stage === 'open') {
        fs.mkdirSync(path.join(dir, 'app.log'));
      } else {
        const stream = new Writable({
          write(_chunk, _encoding, callback) {
            queueMicrotask(() => callback(new Error('disk full')));
          },
        });
        vi.spyOn(fs, 'createWriteStream').mockReturnValue(stream as fs.WriteStream);
      }
      const logger = new AppLogger(dir);
      const warned = new Promise<void>((resolve) => {
        logger.on('entry', (entry) => {
          if (entry.level === 'warn') {
            resolve();
          }
        });
      });
      logger.info('before failure');
      await warned;
      logger.info('after failure');
      await logger.close();
      expect(logger.recent().filter((entry) => entry.level === 'warn')).toHaveLength(1);
      expect(logger.recent().at(-1)?.message).toBe('after failure');
      expect(stdout).toHaveBeenCalledTimes(3);
    },
  );

  test('debug が大量に出ても info 以上は押し出されず、debug 抜きでも取り出せる', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = new AppLogger(dir, 'info');
    logger.info('[rec] first');
    for (let i = 0; i < 2500; i += 1) {
      logger.debug(`[lv1] [comments] chunk ${i}`);
    }
    logger.warn('[rec] last');
    await logger.close();

    const withoutDebug = logger.recent(1000, false);
    expect(withoutDebug.map((e) => e.message)).toEqual(['[rec] first', '[rec] last']);
    // debug 込みでも info 以上は全部残り、時刻順に並ぶ
    const withDebug = logger.recent(1000);
    expect(withDebug[0].message).toBe('[rec] first');
    expect(withDebug.at(-1)?.message).toBe('[rec] last');
    expect(withDebug.filter((e) => e.level === 'debug')).toHaveLength(1000);
    expect(withDebug[1].message).toBe('[lv1] [comments] chunk 1500');
  });

  test('ファイルが上限を超えたら書き込み中でも .1 に退避して続ける', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = new AppLogger(dir, 'info', 200);
    try {
      for (let i = 0; i < 10; i += 1) {
        logger.info(`[rec] line ${i} ${'x'.repeat(40)}`);
        // 3 行で上限 200 バイトを超える。退避された内容を確認してから次を書く
        if (i % 3 === 2) {
          await vi.waitFor(() => {
            const rotated = fs.readFileSync(path.join(dir, 'app.log.1'), 'utf8');
            expect(rotated.match(/line \d/g)).toEqual([
              `line ${i - 2}`,
              `line ${i - 1}`,
              `line ${i}`,
            ]);
          });
        }
      }
    } finally {
      await logger.close();
    }

    // 3 回の退避後、最後の 1 行だけが新しい app.log に残る
    const current = fs.readFileSync(path.join(dir, 'app.log'), 'utf8');
    expect(current.match(/line \d/g)).toEqual(['line 9']);
    expect(Buffer.byteLength(current)).toBeLessThan(200);
  });

  test('退避の途中に書かれた行も失わない', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // 1 行 70 バイト前後 × 20 行で、途中で 1 回だけ退避が起きる
    const logger = new AppLogger(dir, 'info', 1000);
    for (let i = 0; i < 20; i += 1) {
      logger.info(`[rec] line ${String(i).padStart(2, '0')} ${'x'.repeat(40)}`);
    }
    await logger.close();

    const rotated = fs.readFileSync(path.join(dir, 'app.log.1'), 'utf8');
    const current = fs.readFileSync(path.join(dir, 'app.log'), 'utf8');
    const lines = (rotated + current).match(/line \d\d/g) ?? [];
    expect(lines).toEqual(
      Array.from({ length: 20 }, (_, i) => `line ${String(i).padStart(2, '0')}`),
    );
  });

  test('出力レベルを debug に下げるとファイルにも debug が書かれる', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = new AppLogger(dir, 'info');
    logger.setOutputLevel('debug');
    logger.debug('[detector] verbose');
    await logger.close();
    expect(fs.readFileSync(path.join(dir, 'app.log'), 'utf8')).toContain('verbose');
  });

  test('entry イベントで 1 件ずつ通知する', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = new AppLogger(dir, 'info');
    const listener = vi.fn();
    logger.on('entry', listener);
    logger.warn('something');
    await logger.close();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ level: 'warn', message: 'something' });
  });
});

describe('AppLogger のオブジェクト整形', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-logger-'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('列挙されないプロパティしか無いオブジェクトも {} にせず、message や code を残す', async () => {
    const logger = new AppLogger(dir, 'info');
    // WebSocket の ErrorEvent と同じく、message が prototype の getter で本体は空
    const event = Object.create({
      get message() {
        return 'connection reset';
      },
      get error() {
        return { code: 'ECONNRESET' };
      },
    }) as object;
    logger.warn('[autopush] WebSocket error:', event);
    logger.info('plain', { a: 1 });
    await logger.close();

    const [first, second] = logger.recent();
    expect(first.message).toContain('message=connection reset');
    expect(first.message).toContain('error=ECONNRESET');
    expect(first.message).not.toContain('{}');
    expect(second.message).toBe('plain {"a":1}');
  });
});
