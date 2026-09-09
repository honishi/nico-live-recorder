/** 復号済みの1セグメントと、そのセグメントに対応する fMP4 初期化情報。 */
export interface VideoSample {
  data: Buffer;
  init?: Buffer;
}

export type VideoSampleListener = (sample: VideoSample) => void;

/** プレビューの障害や処理待ちを録画へ伝えない。受け手は同期的に受付だけを行う。 */
export function offerVideoSample(
  listener: VideoSampleListener | undefined,
  data: Buffer,
  init?: Buffer,
): void {
  try {
    listener?.({ data, init });
  } catch {
    // 補助画像を作れなくても映像・音声の保存を続ける。
  }
}
