import { test, expect } from 'vitest';
import {
  createOutputDiagnostics,
  verifyScenarioDiagnostics,
} from '../../scripts/electron/diagnostics.mjs';

test('分割されたstderr警告と終了直前の改行なしエラーを保持する', () => {
  const errors = [];
  const diagnostics = createOutputDiagnostics(errors);
  diagnostics.append('stderr', '(node:1) UnhandledPromise');
  diagnostics.append('stdout', 'normal output\n');
  diagnostics.append('stderr', 'RejectionWarning: rejected\n');
  diagnostics.append('stderr', '(node:1) [DEP0001] DeprecationWarning: old API\n');
  diagnostics.append(
    'stderr',
    "(electron) 'webContents.canGoBack' is deprecated and will be removed.\n",
  );
  diagnostics.append('stdout', '2026-01-01T00:00:00Z ERROR shutdown failed');
  diagnostics.finish();
  expect(errors).toEqual([
    '(node:1) UnhandledPromiseRejectionWarning: rejected',
    '(node:1) [DEP0001] DeprecationWarning: old API',
    "(electron) 'webContents.canGoBack' is deprecated and will be removed.",
    '2026-01-01T00:00:00Z ERROR shutdown failed',
  ]);
});

test('二重起動側の出力終了で、稼働中の別ストリームを途中で検査しない', () => {
  const errors = [];
  const diagnostics = createOutputDiagnostics(errors);
  diagnostics.append('first', 'Deprecation');
  diagnostics.append('second', 'DeprecationWarning: second instance');
  diagnostics.finish('second');
  expect(errors).toEqual(['DeprecationWarning: second instance']);
  diagnostics.append('first', 'Warning: first instance\n');
  diagnostics.finish();
  expect(errors).toEqual([
    'DeprecationWarning: second instance',
    'DeprecationWarning: first instance',
  ]);
});

test('再起動前のインスタンスのエラーも最終検査で拒否する', async () => {
  await expect(
    verifyScenarioDiagnostics(
      [{ errors: ['old instance failure'] }, { errors: [] }],
      '/unused-nlr-test',
    ),
  ).rejects.toThrow('old instance failure');
});
