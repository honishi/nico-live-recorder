import { EventEmitter } from 'node:events';
import { test, expect } from 'vitest';
import { observeElectronProcesses } from '../../scripts/electron/process-diagnostics.mjs';

test('正常終了以外のrenderer・GPU・utility終了を記録する', () => {
  const app = new EventEmitter();
  const errors = [];
  observeElectronProcesses(app, {}, (message) => errors.push(message));
  app.emit('render-process-gone', {}, {}, { reason: 'clean-exit' });
  app.emit('child-process-gone', {}, { type: 'Utility', reason: 'clean-exit' });
  expect(errors).toEqual([]);
  app.emit('render-process-gone', {}, {}, { reason: 'oom', exitCode: 1 });
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
  app.emit('child-process-gone', {}, { type: 'Utility', reason: 'killed', exitCode: 9 });
  expect(errors).toHaveLength(3);
  expect(errors[0]).toContain('render-process-gone');
  expect(errors[1]).toContain('"GPU"');
  expect(errors[2]).toContain('"Utility"');
});

test.each(['crashed', 'killed'])('意図的な%sの除外は対象rendererの次の終了だけに限る', (reason) => {
  const app = new EventEmitter();
  const state = {};
  const errors = [];
  observeElectronProcesses(app, state, (message) => errors.push(message));
  const intended = {};
  state.expectedRendererCrashes.add(intended);
  app.emit('render-process-gone', {}, {}, { reason: 'crashed' });
  expect(errors).toHaveLength(1);
  app.emit('render-process-gone', {}, intended, { reason });
  expect(errors).toHaveLength(1);
  app.emit('render-process-gone', {}, intended, { reason: 'crashed' });
  expect(errors).toHaveLength(2);
  state.expectedRendererCrashes.add(intended);
  app.emit('render-process-gone', {}, intended, { reason: 'oom' });
  expect(errors).toHaveLength(3);
});
