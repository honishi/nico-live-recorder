import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { RecordingPreview as PreviewImage } from '@shared/types';
import { recordingPreviewImages } from '../lib/recording-preview-cache';

/** 画面内のカードだけ購読する。非表示・アンマウント時は生成も停止する。 */
export function RecordingPreview({
  programId,
  cacheKey,
  now,
}: {
  programId: string;
  cacheKey: string;
  now: number;
}): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<PreviewImage | undefined>(() =>
    recordingPreviewImages.get(cacheKey),
  );
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let disposed = false;
    let intersecting = false;
    let visible = false;
    let revision = 0;
    let lastImageAt = recordingPreviewImages.get(cacheKey)?.capturedAt;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // 前の要求が返ってから次を送る。非表示になった後の応答では画面を更新しない。
    const poll = async (currentRevision: number): Promise<void> => {
      try {
        const next = await window.api.getRecordingPreview(programId, true, lastImageAt);
        if (disposed || !visible || revision !== currentRevision) return;
        if (next) {
          lastImageAt = next.capturedAt;
          recordingPreviewImages.set(cacheKey, next);
          setImage(next);
          setFresh(true);
        }
      } catch {
        // 取得に失敗した回は最後の画像を残し、次の要求で回復を試す。
      }
      if (!disposed && visible && revision === currentRevision)
        timer = setTimeout(() => {
          void poll(currentRevision);
        }, 1_000);
    };
    const release = (): void => {
      void window.api.getRecordingPreview(programId, false).catch(() => {});
    };
    const updateVisibility = (): void => {
      const next = intersecting && !document.hidden;
      if (next === visible) return;
      visible = next;
      revision += 1;
      clearTimeout(timer);
      // 戻った直後はキャッシュを暗く表示し、新しい画像が届いた時だけ明るさを戻す。
      setFresh(false);
      if (visible) void poll(revision);
      else release();
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      updateVisibility();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', updateVisibility);
      release();
    };
  }, [programId, cacheKey]);

  const stale = image && (!fresh || now - image.capturedAt > 15_000);
  const description = image
    ? `受信映像のプレビュー（約5秒ごとに更新）。最終更新 ${new Date(image.capturedAt).toLocaleTimeString('ja-JP')}`
    : '受信映像のキーフレームを待っています';
  return (
    <div ref={container} className={`rec-preview ${stale ? 'stale' : ''}`} title={description}>
      {image ? (
        <img src={image.dataUrl} alt="受信映像のプレビュー" />
      ) : (
        <span>プレビュー待機中</span>
      )}
    </div>
  );
}
