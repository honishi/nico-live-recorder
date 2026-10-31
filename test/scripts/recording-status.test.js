import { test, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { waitForRecording } from '../../scripts/electron/recording-status.mjs';

test('同じ番組の古いパートではなく、待機条件を満たした録画を返す', async () => {
  const recordings = [
    { programId: 'lv42', state: 'done', videoPath: 'old.ts' },
    { programId: 'lv42', state: 'recording', videoPath: 'current.ts' },
  ];
  const app = {
    evaluate: (expression) =>
      runInNewContext(expression, {
        setTimeout,
        clearTimeout,
        window: {
          api: { onStatusChanged: () => () => {}, getStatus: async () => ({ recordings }) },
        },
      }),
  };
  expect(await waitForRecording(app, 'recording.state === "recording"')).toEqual(recordings[1]);
});
