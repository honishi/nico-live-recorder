import type { RecordingInfo, RecordingPreview } from '../../../src/shared/types';
import {
  pruneRecordingPreviewImages,
  recordingPreviewImages,
  recordingPreviewKey,
} from '../../../src/renderer/src/lib/recording-preview-cache';

const recording: RecordingInfo = {
  programId: 'lv1',
  title: 'テスト放送',
  source: 'manual',
  state: 'recording',
  startedAt: '2026-09-09T00:00:00.000Z',
  commentCount: 0,
  videoBytes: 0,
  outputDir: '/recordings',
};
const image: RecordingPreview = { dataUrl: 'data:image/jpeg;base64,old', capturedAt: 1 };

describe('録画プレビューのキャッシュ', () => {
  // モジュール内の共有キャッシュを各テストの前後で空にし、状態を持ち越さない。
  beforeEach(() => recordingPreviewImages.clear());
  afterEach(() => recordingPreviewImages.clear());

  test('番組・開始日時・パートでキーを分け、未指定のパートは1として扱う', () => {
    const keys = [
      recording,
      { ...recording, programId: 'lv2' },
      { ...recording, startedAt: '2026-09-09T01:00:00.000Z' },
      { ...recording, attempt: 2 },
    ].map(recordingPreviewKey);
    expect(new Set(keys).size).toBe(4);
    expect(recordingPreviewKey({ ...recording, attempt: 1 })).toBe(keys[0]);
  });

  test('進行中の現パートだけ保持し、終了・旧パート・一覧外の画像を解放する', () => {
    const current: RecordingInfo[] = [
      { ...recording, state: 'starting', attempt: 2 },
      { ...recording, programId: 'lv2', state: 'recording', startedAt: '2026-09-09T01:00:00.000Z' },
      { ...recording, programId: 'lv3', state: 'finishing' },
      { ...recording, programId: 'lv4', state: 'done' },
      { ...recording, programId: 'lv5', state: 'failed' },
    ];
    const old = [recording, { ...recording, programId: 'lv2' }, { ...recording, programId: 'lv6' }];
    for (const item of [...current, ...old]) {
      recordingPreviewImages.set(recordingPreviewKey(item), image);
    }
    pruneRecordingPreviewImages(current);
    expect([...recordingPreviewImages.entries()]).toEqual(
      current.slice(0, 3).map((item) => [recordingPreviewKey(item), image]),
    );
    pruneRecordingPreviewImages([]);
    expect(recordingPreviewImages.size).toBe(0);
  });
});
