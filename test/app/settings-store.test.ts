import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, SettingsStore } from '../../src/main/app/settings-store';
import type { TargetUser } from '../../src/shared/types';

const target = (userId: string, addedAt: string): TargetUser => ({
  userId,
  name: `user-${userId}`,
  enabled: true,
  addedAt,
});

describe('SettingsStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-settings-'));
    filePath = path.join(dir, 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ファイルが無ければ既定値で始まり、書き込むまでファイルを作らない', () => {
    const store = new SettingsStore(filePath, '/videos');
    expect(store.get()).toEqual(defaultSettings('/videos'));
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('update は保存して change を発火し、再読み込みで同じ内容になる', () => {
    const store = new SettingsStore(filePath, '/videos');
    const listener = vi.fn();
    store.on('change', listener);

    store.update({ pollIntervalSec: 45, pushEnabled: false });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ pollIntervalSec: 45, pushEnabled: false });
    expect(new SettingsStore(filePath, '/other').get()).toMatchObject({
      outputDir: '/videos',
      pollIntervalSec: 45,
      pushEnabled: false,
    });
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });

  test('get は複製を返し、呼び出し側の変更が内部に漏れない', () => {
    const store = new SettingsStore(filePath, '/videos');
    store.get().targets.push(target('1', '2026-01-01T00:00:00Z'));
    expect(store.get().targets).toHaveLength(0);
  });

  test('対象の追加は userId で置き換え、追加日時順に並ぶ', () => {
    const store = new SettingsStore(filePath, '/videos');
    store.upsertTarget(target('2', '2026-01-02T00:00:00Z'));
    store.upsertTarget(target('1', '2026-01-01T00:00:00Z'));
    store.upsertTarget({ ...target('2', '2026-01-02T00:00:00Z'), name: 'renamed' });

    expect(store.get().targets.map((t) => [t.userId, t.name])).toEqual([
      ['1', 'user-1'],
      ['2', 'renamed'],
    ]);
  });

  test('有効フラグの切り替えと削除', () => {
    const store = new SettingsStore(filePath, '/videos');
    store.upsertTarget(target('1', '2026-01-01T00:00:00Z'));
    store.setTargetEnabled('1', false);
    expect(store.get().targets[0].enabled).toBe(false);
    store.removeTarget('1');
    expect(store.get().targets).toHaveLength(0);
  });

  test('壊れたファイルや欠けたキーは既定値で補う', () => {
    fs.writeFileSync(filePath, '{ not json', 'utf8');
    expect(new SettingsStore(filePath, '/videos').get()).toEqual(defaultSettings('/videos'));

    fs.writeFileSync(filePath, JSON.stringify({ pollIntervalSec: 60, targets: 'bad' }), 'utf8');
    const store = new SettingsStore(filePath, '/videos');
    expect(store.get()).toMatchObject({ pollIntervalSec: 60, targets: [], pushEnabled: true });
  });
});
