import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { silentLogger } from '../../src/main/core/logger';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import {
  IPC,
  type AppSettings,
  type FollowStatus,
  type TargetAddResult,
  type TargetRemovalResult,
  type TargetUser,
} from '../../src/shared/types';
import { registerIpcHandlers, type IpcContext } from '../../src/main/app/ipc';
import { SettingsStore } from '../../src/main/app/settings-store';

// ネイティブダイアログと IPC を差し替え、承認前にログアウトへ進まないことを確認する
const { handle, showMessageBox } = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: () => Promise<void>) => void>(),
  showMessageBox: vi.fn<(...args: unknown[]) => Promise<MessageBoxReturnValue>>(),
}));
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  Menu: {},
  shell: {},
  ipcMain: { handle },
  dialog: { showMessageBox },
}));

describe('ログアウトの確認', () => {
  let logout: () => Promise<void>;
  let performLogout: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let window: BrowserWindow;

  beforeEach(() => {
    handle.mockClear();
    showMessageBox.mockReset();
    performLogout = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    window = {} as BrowserWindow;
    const ctx = {
      auth: new EventEmitter(),
      manager: { logout: performLogout, getActiveRecordingCount: () => 2 },
      getMainWindow: () => window,
    } as unknown as IpcContext;
    registerIpcHandlers(ctx);
    logout = handle.mock.calls.find(([channel]) => channel === IPC.logout)![1];
  });

  test('停止件数を表示し、キャンセルでは録画停止や購読解除を実行しない', async () => {
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
    await logout();
    expect(showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        buttons: ['キャンセル', 'ログアウト'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    const options = showMessageBox.mock.calls[0][1] as MessageBoxOptions;
    expect(options.detail).toContain('2 件を終了');
    expect(performLogout).not.toHaveBeenCalled();
  });

  test('承認したときだけ終了処理を実行し、完了まで重複要求をまとめる', async () => {
    let confirm!: (value: MessageBoxReturnValue) => void;
    showMessageBox.mockReturnValue(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    let finish!: () => void;
    performLogout.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = logout();
    expect(logout()).toBe(pending);
    expect(performLogout).not.toHaveBeenCalled();
    confirm({ response: 1, checkboxChecked: false });
    await vi.waitFor(() => expect(performLogout).toHaveBeenCalledOnce());
    expect(logout()).toBe(pending);
    expect(showMessageBox).toHaveBeenCalledOnce();
    finish();
    await pending;
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
    await logout();
    expect(showMessageBox).toHaveBeenCalledTimes(2);
    expect(performLogout).toHaveBeenCalledOnce();
  });

  test('ダイアログ表示に失敗しても再操作できる', async () => {
    showMessageBox.mockRejectedValueOnce(new Error('dialog failed'));
    await expect(logout()).rejects.toThrow('dialog failed');
    expect(performLogout).not.toHaveBeenCalled();
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    await logout();
    expect(performLogout).toHaveBeenCalledOnce();
  });
});

describe('フォロー確認とログイン切替', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('Cookie取得中にアカウントが変わったら旧Cookieで通信しない', async () => {
    handle.mockClear();
    let finish!: (cookie: string) => void;
    const auth = Object.assign(new EventEmitter(), {
      revision: 0,
      getCookieHeader: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    registerIpcHandlers({ auth } as unknown as IpcContext);
    const checkFollow = handle.mock.calls.find(
      ([channel]) => channel === IPC.checkFollow,
    )![1] as unknown as (event: unknown, userId: string) => Promise<FollowStatus>;
    const pending = checkFollow({}, '1');
    auth.revision += 1;
    auth.emit('change', true);
    finish('old-cookie');
    expect(await pending).toMatchObject({ state: 'waiting' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('画面で503を受けた休止期間は対象追加にも適用する', async () => {
    handle.mockClear();
    const auth = Object.assign(new EventEmitter(), {
      revision: 0,
      getCookieHeader: async () => 'cookie',
    });
    const fetch = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    registerIpcHandlers({
      auth,
      logger: silentLogger,
      settings: { get: () => ({ targets: [{ userId: '2', name: 'target', enabled: true }] }) },
    } as unknown as IpcContext);
    const checkFollow = handle.mock.calls.find(
      ([channel]) => channel === IPC.checkFollow,
    )![1] as unknown as (event: unknown, userId: string) => Promise<FollowStatus>;
    const addTarget = handle.mock.calls.find(
      ([channel]) => channel === IPC.addTarget,
    )![1] as unknown as (event: unknown, input: string) => Promise<TargetAddResult>;
    expect(await checkFollow({}, '1')).toMatchObject({ state: 'paused' });
    expect((await addTarget({}, '2')).follow).toMatchObject({ state: 'paused' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// 保存は一時ディレクトリ、確認だけを偽ダイアログにし、実際の IPC ハンドラを通す
describe('録画対象の一括操作と並び替え', () => {
  let dir: string;
  let settings: SettingsStore;
  let remove: (
    event: unknown,
    ids: unknown,
    confirm?: unknown,
  ) => Promise<TargetRemovalResult | undefined>;
  let restore: (event: unknown, targets: unknown, previousOrder?: unknown) => AppSettings;
  let move: (event: unknown, userId: unknown, beforeUserId: unknown) => AppSettings;
  let setEnabled: (event: unknown, userIds: unknown, enabled: unknown) => AppSettings;
  const original: TargetUser[] = ['1', '2', '3'].map((userId) => ({
    userId,
    name: `配信者${userId}`,
    enabled: userId !== '2',
    addedAt: `2026-01-0${userId}T00:00:00Z`,
  }));

  beforeEach(() => {
    handle.mockClear();
    showMessageBox.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlr-bulk-ipc-'));
    settings = new SettingsStore(path.join(dir, 'settings.json'), path.join(dir, 'out'));
    settings.update({ targets: original });
    registerIpcHandlers({
      settings,
      auth: new EventEmitter(),
      getMainWindow: () => undefined,
    } as unknown as IpcContext);
    remove = handle.mock.calls.find(
      ([channel]) => channel === IPC.removeTargets,
    )![1] as unknown as typeof remove;
    restore = handle.mock.calls.find(
      ([channel]) => channel === IPC.restoreTargets,
    )![1] as unknown as typeof restore;
    move = handle.mock.calls.find(
      ([channel]) => channel === IPC.moveTarget,
    )![1] as unknown as typeof move;
    setEnabled = handle.mock.calls.find(
      ([channel]) => channel === IPC.setTargetsEnabled,
    )![1] as unknown as typeof setEnabled;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('確認の件数は重複を除き、キャンセルで設定を変更しない', async () => {
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
    expect(await remove({}, ['1', '2', '2', '999'])).toBeUndefined();
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '2 件の配信者を録画対象から削除しますか？',
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(settings.get().targets).toEqual(original);
  });

  test('確認中の重複要求を拒否し、確認後も別の対象の変更を保つ', async () => {
    let confirm!: (result: MessageBoxReturnValue) => void;
    showMessageBox.mockReturnValue(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    const pending = remove({}, ['1', '2', '2']);
    await expect(remove({}, ['3'])).rejects.toThrow('削除処理中');
    settings.setTargetEnabled('3', false);
    confirm({ response: 1, checkboxChecked: false });
    const result = await pending;
    expect(result?.removed).toEqual(original.slice(0, 2));
    expect(result?.settings.targets).toEqual([{ ...original[2], enabled: false }]);
    expect(showMessageBox).toHaveBeenCalledTimes(1);

    // 削除時の情報を戻し、確認後に行われた他の設定変更は維持する
    expect(restore({}, result!.removed, result!.previousOrder).targets).toEqual([
      original[0],
      original[1],
      { ...original[2], enabled: false },
    ]);
  });

  test('単体削除は確認なしで同じ処理を使い、0 件では確認も保存もしない', async () => {
    expect((await remove({}, ['2'], false))?.removed).toEqual([original[1]]);
    const listener = vi.fn();
    settings.on('change', listener);
    expect((await remove({}, ['2', '999']))?.removed).toEqual([]);
    expect((await remove({}, []))?.removed).toEqual([]);
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  test('不正な ID・復元データは全体を拒否する', async () => {
    for (const ids of [null, '1', [1], ['1', 'bad']]) {
      await expect(remove({}, ids)).rejects.toThrow('E_INVALID_INPUT');
    }
    await expect(remove({}, ['1'], 'yes')).rejects.toThrow('E_INVALID_INPUT');
    for (const targets of [
      null,
      {},
      [original[0], { ...original[1], enabled: 'yes' }],
      [{ ...original[0], addedAt: 'bad' }],
    ]) {
      expect(() => restore({}, targets)).toThrow('E_INVALID_INPUT');
    }
    expect(settings.get().targets).toEqual(original);
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  test('一括の有効状態変更は入力全体を検証し、指定した配信者だけを変更する', () => {
    for (const [ids, enabled] of [
      [null, true],
      ['1', true],
      [['1', 2], false],
      [['1'], 'false'],
      [['1'], null],
    ]) {
      expect(() => setEnabled({}, ids, enabled)).toThrow('E_INVALID_INPUT');
    }
    expect(settings.get().targets).toEqual(original);
    const result = setEnabled({}, ['1', '2', '2', '999'], false);
    expect(result.targets).toEqual([{ ...original[0], enabled: false }, original[1], original[2]]);
    expect(setEnabled({}, ['1', '2'], true).targets).toEqual(
      original.map((target) => ({ ...target, enabled: true })),
    );
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  test('順序変更の IPC は ID を検証し、保存した順序を返す', () => {
    for (const [userId, beforeUserId] of [
      [1, null],
      ['1', false],
      ['1', 'bad'],
      ['1', undefined],
    ]) {
      expect(() => move({}, userId, beforeUserId)).toThrow('E_INVALID_INPUT');
    }
    expect(() => restore({}, [], ['bad'])).toThrow('E_INVALID_INPUT');
    expect(settings.get().targets).toEqual(original);
    expect(move({}, '3', '1').targets.map((t) => t.userId)).toEqual(['3', '1', '2']);
    expect(move({}, '3', null).targets).toEqual(original);
  });

  test('確認・保存の失敗を呼び出し元へ返し、再試行を妨げない', async () => {
    showMessageBox.mockRejectedValueOnce(new Error('dialog failed'));
    await expect(remove({}, ['1'])).rejects.toThrow('dialog failed');
    expect(settings.get().targets).toEqual(original);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk failed');
    });
    await expect(remove({}, ['1'], false)).rejects.toThrow('disk failed');
    expect(settings.get().targets).toEqual(original);
    rename.mockRestore();
    expect((await remove({}, ['1'], false))?.removed).toEqual([original[0]]);
  });
});
