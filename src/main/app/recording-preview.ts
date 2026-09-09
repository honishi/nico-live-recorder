import type { RecordingPreview } from '../../shared/types';
import type { Logger } from '../core/logger';
import { extractPreviewImage } from '../core/nico/preview-image';
import type { VideoSample } from '../core/nico/video-sample';

const INTERVAL_MS = 5_000;
const LEASE_MS = 3_000;
const SAMPLE_FRESH_MS = 15_000;
const MAX_SAMPLE_BYTES = 16 * 1024 * 1024;
const MAX_INIT_BYTES = 1024 * 1024;

interface Entry {
  expiresAt: number;
  nextAt: number;
  sampleAt?: number;
  image?: RecordingPreview;
}

/** 表示中のカードだけを対象にし、アプリ全体で画像生成を1件に制限する。 */
export class RecordingPreviews {
  private readonly entries = new Map<string, Entry>();
  private running?: { programId: string; controller: AbortController };

  constructor(
    private readonly logger: Logger,
    private readonly extract: (
      sample: VideoSample,
      signal: AbortSignal,
    ) => Promise<Buffer> = extractPreviewImage,
  ) {}

  request(programId: string): RecordingPreview | undefined {
    const now = Date.now();
    let entry = this.entries.get(programId);
    if (!entry) {
      entry = { expiresAt: now + LEASE_MS, nextAt: 0 };
      this.entries.set(programId, entry);
    }
    entry.expiresAt = now + LEASE_MS;
    return entry.image;
  }

  /** 処理待ちの映像を溜めない。忙しい場合はその回を飛ばして次のセグメントを待つ。 */
  offer(programId: string, sample: VideoSample): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(id);
    }
    const entry = this.entries.get(programId);
    if (!entry) return;
    if (sample.data.length > MAX_SAMPLE_BYTES || (sample.init?.length ?? 0) > MAX_INIT_BYTES)
      return;
    entry.sampleAt = now;
    if (this.running || entry.nextAt > now) return;
    // 同時に届く複数番組を公平に扱う。画像化を待っている番組の次のサンプルに譲る。
    // 映像が途絶えた番組には待ち続けず、データ自体はどの番組も保留しない。
    const older = [...this.entries.values()].some(
      (other) =>
        other.nextAt < entry.nextAt &&
        other.sampleAt !== undefined &&
        now - other.sampleAt < SAMPLE_FRESH_MS,
    );
    if (older) return;
    entry.nextAt = now + INTERVAL_MS;
    const job = { programId, controller: new AbortController() };
    this.running = job;
    // 受付だけで直ちに戻り、画像生成の成功・失敗を録画処理から切り離す。
    void Promise.resolve()
      .then(() => this.extract(sample, job.controller.signal))
      .then((image) => {
        if (
          job.controller.signal.aborted ||
          this.entries.get(programId) !== entry ||
          entry.expiresAt <= Date.now()
        )
          return;
        entry.image = {
          dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`,
          capturedAt: now,
        };
      })
      .catch((error: unknown) => {
        if (!job.controller.signal.aborted)
          this.logger.debug(`[rec] preview unavailable for ${programId}`, error);
      })
      .finally(() => {
        if (this.running === job) this.running = undefined;
      });
  }

  remove(programId: string): void {
    this.entries.delete(programId);
    if (this.running?.programId === programId) this.running.controller.abort();
  }

  clear(): void {
    this.entries.clear();
    this.running?.controller.abort();
  }
}
