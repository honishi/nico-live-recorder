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
    vi.restoreAllMocks();
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

  test('新規対象は末尾に追加し、既存対象の更新は位置を保つ', () => {
    const store = new SettingsStore(filePath, '/videos');
    store.upsertTarget(target('2', '2026-01-02T00:00:00Z'));
    store.upsertTarget(target('1', '2026-01-01T00:00:00Z'));
    store.upsertTarget({ ...target('2', '2026-01-02T00:00:00Z'), name: 'renamed' });

    expect(store.get().targets.map((t) => [t.userId, t.name])).toEqual([
      ['2', 'renamed'],
      ['1', 'user-1'],
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

  test('一括削除は重複・存在しない ID を無視し、保存と通知を一度にまとめる', () => {
    const original = ['1', '2', '3'].map((id) => target(id, `2026-01-0${id}T00:00:00Z`));
    const store = new SettingsStore(filePath, '/videos');
    store.update({ targets: original });
    const listener = vi.fn();
    store.on('change', listener);
    const write = vi.spyOn(fs, 'writeFileSync');

    const removed = store.removeTargets(['1', '3', '3', '999']);
    expect(removed).toEqual([original[0], original[2]]);
    expect(store.get().targets).toEqual([original[1]]);
    expect(new SettingsStore(filePath, '/other').get().targets).toEqual([original[1]]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    store.removeTargets([]);
    store.removeTargets(['1', '999']);
    expect(write).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('一括復元は現在の順序と再登録済みの内容を保ち、有効状態を復元する', () => {
    const original = ['1', '2', '3'].map((id) => target(id, `2026-01-0${id}T00:00:00Z`));
    original[0].enabled = false;
    const store = new SettingsStore(filePath, '/videos');
    store.update({ targets: original });
    const removed = store.removeTargets(['1', '2']);
    const registered = { ...original[1], name: '再登録', addedAt: '2026-02-01T00:00:00Z' };
    store.upsertTarget(registered);
    const listener = vi.fn();
    store.on('change', listener);
    const write = vi.spyOn(fs, 'writeFileSync');

    const restored = store.restoreTargets([...removed, removed[0]], ['1', '2', '3']);
    expect(restored.targets).toEqual([original[2], original[0], registered]);
    expect(new SettingsStore(filePath, '/other').get().targets).toEqual(restored.targets);
    expect(write).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    store.restoreTargets(removed);
    store.restoreTargets([]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('削除と復元の保存に失敗しても、メモリ・ファイル・通知を変更しない', () => {
    const store = new SettingsStore(filePath, '/videos');
    const original = target('1', '2026-01-01T00:00:00Z');
    store.upsertTarget(original);
    const listener = vi.fn();
    store.on('change', listener);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk failure');
    });

    expect(() => store.removeTargets(['1'])).toThrow('disk failure');
    expect(store.get().targets).toEqual([original]);
    expect(new SettingsStore(filePath, '/other').get().targets).toEqual([original]);
    expect(listener).not.toHaveBeenCalled();

    rename.mockRestore();
    const removed = store.removeTargets(['1']);
    listener.mockClear();
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk failure');
    });
    expect(() => store.restoreTargets(removed)).toThrow('disk failure');
    expect(store.get().targets).toEqual([]);
    expect(new SettingsStore(filePath, '/other').get().targets).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  test('移動した順序を再読み込みでも保ち、名前・有効状態・追加日時は変えない', () => {
    const store = new SettingsStore(filePath, '/videos');
    const original = ['1', '2', '3', '4'].map((id) => target(id, `2026-01-0${id}T00:00:00Z`));
    original[1].enabled = false;
    store.update({ targets: original });
    const listener = vi.fn();
    store.on('change', listener);
    const write = vi.spyOn(fs, 'writeFileSync');
    expect(store.moveTarget('4', '2').targets).toEqual([
      original[0],
      original[3],
      original[1],
      original[2],
    ]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(new SettingsStore(filePath, '/other').get().targets).toEqual(store.get().targets);
    expect(store.moveTarget('1', null).targets.map((t) => t.userId)).toEqual(['4', '2', '3', '1']);
    expect(store.moveTarget('1', '4').targets.map((t) => t.userId)).toEqual(['1', '4', '2', '3']);
    store.upsertTarget({ ...original[1], name: '変更後' });
    store.upsertTarget(target('5', '2025-01-01T00:00:00Z'));
    expect(store.get().targets.map((t) => t.userId)).toEqual(['1', '4', '2', '3', '5']);
  });

  test('同じ位置・存在しない行への移動は保存せず、保存失敗も元の順序を保つ', () => {
    const store = new SettingsStore(filePath, '/videos');
    const original = ['1', '2'].map((id) => target(id, `2026-01-0${id}T00:00:00Z`));
    store.update({ targets: original });
    const listener = vi.fn();
    store.on('change', listener);
    const write = vi.spyOn(fs, 'writeFileSync');
    for (const [id, beforeId] of [
      ['1', '1'],
      ['1', '2'],
      ['2', null],
      ['999', '1'],
      ['1', '999'],
    ]) {
      store.moveTarget(id!, beforeId);
    }
    expect(write).not.toHaveBeenCalled();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk failure');
    });
    expect(() => store.moveTarget('2', '1')).toThrow('disk failure');
    expect(store.get().targets).toEqual(original);
    expect(new SettingsStore(filePath, '/other').get().targets).toEqual(original);
    expect(listener).not.toHaveBeenCalled();
  });

  test('並び替え後の一括削除を取り消すと削除前の順序に戻る', () => {
    const store = new SettingsStore(filePath, '/videos');
    const original = ['3', '1', '4', '2'].map((id) => target(id, `2026-01-0${id}T00:00:00Z`));
    store.update({ targets: original });
    const previousOrder = original.map((t) => t.userId);
    const removed = store.removeTargets(['3', '1', '2']);
    expect(store.restoreTargets(removed, previousOrder).targets).toEqual(original);
    const all = store.removeTargets(previousOrder);
    expect(store.restoreTargets(all, previousOrder).targets).toEqual(original);
  });

  test('削除後に並び替えや追加をしても、取り消しで残った行の順序を巻き戻さない', () => {
    const store = new SettingsStore(filePath, '/videos');
    const original = ['1', '2', '3', '4'].map((id) => target(id, `2026-01-0${id}T00:00:00Z`));
    store.update({ targets: original });
    const removed = store.removeTargets(['2']);
    store.moveTarget('4', '1');
    store.upsertTarget(target('5', '2026-01-05T00:00:00Z'));
    expect(
      store.restoreTargets(removed, ['1', '2', '3', '4']).targets.map((t) => t.userId),
    ).toEqual(['4', '1', '2', '3', '5']);
  });

  test('壊れたファイルや欠けたキーは既定値で補う', () => {
    fs.writeFileSync(filePath, '{ not json', 'utf8');
    expect(new SettingsStore(filePath, '/videos').get()).toEqual(defaultSettings('/videos'));

    fs.writeFileSync(filePath, JSON.stringify({ pollIntervalSec: 60, targets: 'bad' }), 'utf8');
    const store = new SettingsStore(filePath, '/videos');
    expect(store.get()).toMatchObject({ pollIntervalSec: 60, targets: [], pushEnabled: true });
  });

  test('型や範囲が合わない値は既定値に戻す (ポーリング間隔が NaN になると API を連続で叩くため)', () => {
    const cases: unknown[] = ['30', NaN, 1, 0, -30, 100_000, null, true];
    for (const value of cases) {
      fs.writeFileSync(filePath, JSON.stringify({ pollIntervalSec: value }), 'utf8');
      expect(new SettingsStore(filePath, '/videos').get().pollIntervalSec, String(value)).toBe(30);
    }

    fs.writeFileSync(
      filePath,
      JSON.stringify({
        pollIntervalSec: 15,
        minFreeSpaceGb: 'lots',
        pushEnabled: 'yes',
        notificationsEnabled: 0,
        outputDir: '',
        window: 'no',
      }),
      'utf8',
    );
    expect(new SettingsStore(filePath, '/videos').get()).toMatchObject({
      pollIntervalSec: 15,
      minFreeSpaceGb: 5,
      pushEnabled: true,
      notificationsEnabled: true,
      outputDir: '/videos',
      window: undefined,
    });
  });
});
