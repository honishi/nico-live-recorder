import type { ReactElement } from 'react';
import type { RecordingInfo } from '@shared/types';

interface Props {
  recording: RecordingInfo;
  onShowFile: (path: string) => void;
}

export function ShowRecordingButton({ recording, onShowFile }: Props): ReactElement {
  return (
    <button
      type="button"
      className="btn btn-secondary sm"
      title="フォルダで表示"
      disabled={!recording.videoPath || recording.videoExists === false}
      onClick={() => recording.videoPath && onShowFile(recording.videoPath)}
      // 行のダブルクリックによるファイル表示と重複させない。
      onDoubleClick={(event) => event.stopPropagation()}
    >
      表示
    </button>
  );
}
