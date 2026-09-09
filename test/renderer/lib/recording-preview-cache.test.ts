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

  test.each<{ state: RecordingInfo['state']; keep: boolean }>([
    { state: 'starting', keep: true },
    { state: 'recording', keep: true },
    { state: 'finishing', keep: true },
    { state: 'done', keep: false },
    { state: 'failed', keep: false },
  ])('$state の状態に応じて画像を保持・解放する', ({ state, keep }) => {
    const key = recordingPreviewKey(recording);
    recordingPreviewImages.set(key, image);

    pruneRecordingPreviewImages([{ ...recording, state }]);

    expect(recordingPreviewImages.size).toBe(keep ? 1 : 0);
    expect(recordingPreviewImages.get(key)).toBe(keep ? image : undefined);
  });

  test.each([
    { label: '別パートへの再開', current: { ...recording, attempt: 2 } },
    {
      label: '同一番組の録り直し',
      current: { ...recording, startedAt: '2026-09-09T01:00:00.000Z' },
    },
  ])('$label で古い画像だけを解放する', ({ current }) => {
    const oldKey = recordingPreviewKey(recording);
    const currentKey = recordingPreviewKey(current);
    const other = { ...recording, programId: 'lv2' };
    const otherKey = recordingPreviewKey(other);
    const currentImage = { ...image, dataUrl: 'data:image/jpeg;base64,new', capturedAt: 2 };
    recordingPreviewImages.set(oldKey, image);
    recordingPreviewImages.set(currentKey, currentImage);
    recordingPreviewImages.set(otherKey, image);

    // 録画一覧の更新だけで旧パートを解放し、現在のパートと他番組には触れない。
    pruneRecordingPreviewImages([current, other]);

    expect(recordingPreviewImages.has(oldKey)).toBe(false);
    expect(recordingPreviewImages.size).toBe(2);
    expect(recordingPreviewImages.get(currentKey)).toBe(currentImage);
    expect(recordingPreviewImages.get(otherKey)).toBe(image);
  });

  test('録画一覧から消えた番組の画像も解放する', () => {
    recordingPreviewImages.set(recordingPreviewKey(recording), image);
    recordingPreviewImages.set(recordingPreviewKey({ ...recording, programId: 'lv2' }), image);

    pruneRecordingPreviewImages([]);

    expect(recordingPreviewImages.size).toBe(0);
  });
});
