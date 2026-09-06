import { EventEmitter } from 'node:events';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { IPC } from '../../src/shared/types';
import { registerIpcHandlers, type IpcContext } from '../../src/main/app/ipc';

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
