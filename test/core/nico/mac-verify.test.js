import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { verifyNotarizedApp } from '../../../scripts/mac/verify.mjs';

// macOS のツールと Gatekeeper の通信を置き換え、Windows の CI でも同じゲートを検証する。
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const app = path.resolve('NicoLiveRecorder.app');
const teamId = 'ABCDE12345';
const signature = [
  'Identifier=com.honishi.nico-live-recorder',
  'Authority=Developer ID Application: Example (ABCDE12345)',
  'TeamIdentifier=ABCDE12345',
  'CodeDirectory v=20500 size=458 flags=0x10000(runtime)',
  'Timestamp=Sep 6, 2026 at 3:00:00',
].join('\n');

function success(command, args) {
  let stderr = '';
  if (args.includes('--display')) stderr = signature;
  if (command === '/usr/sbin/spctl') stderr = `${app}: accepted\nsource=Notarized Developer ID\n`;
  return { status: 0, stdout: '', stderr };
}

beforeEach(() => {
  vi.resetAllMocks();
  spawnSync.mockImplementation(success);
});

describe('配布成果物の署名・公証ゲート', () => {
  test('アプリと両バイナリの署名、公証チケット、Gatekeeper の判定を検証する', () => {
    verifyNotarizedApp(app, teamId);
    for (const name of ['ffmpeg', 'ffprobe']) {
      expect(spawnSync).toHaveBeenCalledWith(
        '/usr/bin/codesign',
        ['--verify', '--strict', path.join(app, 'Contents', 'Resources', 'ffmpeg', name)],
        expect.any(Object),
      );
    }
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/bin/xcrun',
      ['stapler', 'validate', app],
      expect.any(Object),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      '/usr/sbin/spctl',
      ['--assess', '--type', 'execute', '--verbose=2', app],
      expect.any(Object),
    );
  });

  test.each([
    [
      'Authority=Developer ID Application:',
      'Authority=Apple Development:',
      'Developer ID 署名なし',
    ],
    ['TeamIdentifier=ABCDE12345', 'TeamIdentifier=OTHER12345', 'チーム不一致'],
    ['flags=0x10000(runtime)', 'flags=0x0(none)', 'Hardened Runtime なし'],
    ['Timestamp=', 'Signed Time=', 'タイムスタンプなし'],
    [
      'Identifier=com.honishi.nico-live-recorder',
      'Identifier=net.honishi.nico-live-recorder',
      'Bundle ID が不一致',
    ],
  ])('署名情報が条件を満たさなければ拒否する: %s', (from, to, message) => {
    spawnSync.mockImplementation((command, args) => {
      const result = success(command, args);
      result.stderr = result.stderr.replace(from, to);
      return result;
    });
    expect(() => verifyNotarizedApp(app, teamId)).toThrow(message);
  });

  test.each(['ffmpeg', 'ffprobe'])('同梱 %s の署名の破損を拒否する', (name) => {
    spawnSync.mockImplementation((command, args) => {
      if (args.includes('--verify') && args.at(-1).endsWith(`${path.sep}${name}`)) {
        return { status: 1, stderr: 'invalid signature' };
      }
      return success(command, args);
    });
    expect(() => verifyNotarizedApp(app, teamId)).toThrow('invalid signature');
  });

  test('チケットがない場合は失敗する', () => {
    spawnSync.mockImplementation((command, args) =>
      command === '/usr/bin/xcrun'
        ? { status: 65, stderr: 'ticket missing' }
        : success(command, args),
    );
    expect(() => verifyNotarizedApp(app, teamId)).toThrow('ticket missing');
  });

  test('Gatekeeper が別の理由で受け入れた場合も公証済みとして扱わない', () => {
    spawnSync.mockImplementation((command, args) =>
      command === '/usr/sbin/spctl'
        ? { status: 0, stderr: `${app}: accepted\nsource=Some Other Rule\n` }
        : success(command, args),
    );
    expect(() => verifyNotarizedApp(app, teamId)).toThrow('Developer ID の公証がありません');
  });

  test('Team ID 未設定の場合は検証を開始しない', () => {
    expect(() => verifyNotarizedApp(app, '')).toThrow('Apple Team ID');
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
