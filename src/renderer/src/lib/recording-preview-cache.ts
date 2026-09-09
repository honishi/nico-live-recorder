import type { RecordingInfo, RecordingPreview } from '@shared/types';

/** タブのアンマウントをまたいで、表示済みの画像を録画パートごとに1枚だけ保持する。 */
export const recordingPreviewImages = new Map<string, RecordingPreview>();

export function recordingPreviewKey(recording: RecordingInfo): string {
  return `${recording.programId}:${recording.startedAt}:${recording.attempt ?? 1}`;
}

/** 終了した録画や古いパートの画像を、録画タブが非表示の間も解放する。 */
export function pruneRecordingPreviewImages(recordings: RecordingInfo[]): void {
  const active = new Set(
    recordings
      .filter((recording) => ['starting', 'recording', 'finishing'].includes(recording.state))
      .map(recordingPreviewKey),
  );
  for (const key of recordingPreviewImages.keys()) {
    if (!active.has(key)) recordingPreviewImages.delete(key);
  }
}
