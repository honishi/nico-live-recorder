import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
