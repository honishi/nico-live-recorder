import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { HistoryPage, HistoryQuery, RecordingInfo } from '../../shared/types';

const DEFAULT_LIMIT = 2000;
const SAVE_DELAY_MS = 500;
const PAGE_SIZE = 50;
const IN_PROGRESS = new Set<RecordingInfo['state']>(['starting', 'recording', 'finishing']);

function sortKey(info: RecordingInfo): string {
  return info.endedAt ?? info.startedAt;
}

/**
 * 録画履歴の永続化。userData 配下の JSON に新しい順で保存し、上限を超えた古いものから捨てる。
 * 書き込みは少し遅らせてまとめ、一時ファイル経由で置き換える
 */
export class HistoryStore {
  private entries: RecordingInfo[] = [];
  private saveTimer?: NodeJS.Timeout;
  private dirty = false;

  constructor(
    private readonly filePath: string,
    private readonly limit = DEFAULT_LIMIT,
  ) {
    this.load();
  }

  /** 前回の起動で終わらなかった録画は「中断」として残す */
  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      this.entries = Array.isArray(raw)
        ? raw.filter(
            (e): e is RecordingInfo =>
              typeof e === 'object' &&
              e !== null &&
              typeof (e as RecordingInfo).programId === 'string',
          )
        : [];
    } catch {
      this.entries = [];
    }
    let changed = false;
    for (const entry of this.entries) {
      if (IN_PROGRESS.has(entry.state)) {
        entry.state = 'failed';
        entry.error = 'アプリの終了により中断';
        entry.endedAt ??= entry.startedAt;
        changed = true;
      }
    }
    this.sortAndTrim();
    if (changed) {
      this.scheduleSave();
    }
  }

  all(): RecordingInfo[] {
    return [...this.entries];
  }

  get(programId: string): RecordingInfo | undefined {
    return this.entries.find((e) => e.programId === programId);
  }

  upsert(info: RecordingInfo): void {
    const copy = { ...info };
    const index = this.entries.findIndex((e) => e.programId === info.programId);
    if (index >= 0) {
      this.entries[index] = copy;
    } else {
      this.entries.unshift(copy);
    }
    this.sortAndTrim();
    this.scheduleSave();
  }

  remove(programId: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.programId !== programId);
    if (this.entries.length !== before) {
      this.scheduleSave();
      return true;
    }
    return false;
  }

  /** 当日に終わった録画 (録画タブの「直近の録画」用) */
  finishedToday(now = new Date()): RecordingInfo[] {
    return this.entries.filter((e) => {
      if (IN_PROGRESS.has(e.state) || !e.endedAt) {
        return false;
      }
      const d = new Date(e.endedAt);
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      );
    });
  }

  /** 絞り込み用の配信者名の一覧 */
  providers(): string[] {
    const finished = this.entries.filter((e) => !IN_PROGRESS.has(e.state));
    return [...new Set(finished.map(providerOf))].filter((p) => p.length > 0).sort();
  }

  /** 条件に合う終了済みの録画を新しい順で返す (ページングなし) */
  match(q: HistoryQuery = {}): RecordingInfo[] {
    const finished = this.entries.filter((e) => !IN_PROGRESS.has(e.state));
    const text = q.query?.trim().toLowerCase();
    return finished.filter((e) => {
      if (q.provider && providerOf(e) !== q.provider) {
        return false;
      }
      if (q.state && e.state !== q.state) {
        return false;
      }
      if (text) {
        return e.title.toLowerCase().includes(text) || providerOf(e).toLowerCase().includes(text);
      }
      return true;
    });
  }

  /** 履歴タブ用の絞り込みとページング (新しい順固定) */
  query(q: HistoryQuery = {}): HistoryPage {
    return HistoryStore.paginate(this.match(q), q, this.providers());
  }

  /** 絞り込み済みの一覧から 1 ページ分と合計を作る */
  static paginate(matched: RecordingInfo[], q: HistoryQuery, providers: string[]): HistoryPage {
    const offset = Math.max(0, q.offset ?? 0);
    const limit = Math.max(1, q.limit ?? PAGE_SIZE);
    return {
      items: matched.slice(offset, offset + limit),
      total: matched.length,
      // 削除済 (ファイルが無い) ものは合計に含めない
      totalBytes: matched.reduce((sum, e) => sum + (e.videoExists === false ? 0 : e.videoBytes), 0),
      providers,
    };
  }

  /** 終了時に確実に書き出す */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.dirty) {
      this.save();
    }
  }

  /** 録画ファイルが残っているかを確認して videoExists を埋める */
  static async checkExistence(items: RecordingInfo[]): Promise<RecordingInfo[]> {
    return Promise.all(
      items.map(async (info) => {
        if (IN_PROGRESS.has(info.state)) {
          return info;
        }
        if (!info.videoPath) {
          return { ...info, videoExists: false };
        }
        try {
          await fsp.access(info.videoPath);
          return { ...info, videoExists: true };
        } catch {
          return { ...info, videoExists: false };
        }
      }),
    );
  }

  private sortAndTrim(): void {
    this.entries.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    if (this.entries.length > this.limit) {
      this.entries.length = this.limit;
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
  }

  private save(): void {
    this.dirty = false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    // 表示用の一時的な項目 (videoExists) は保存しない
    const data = this.entries.map(({ videoExists: _exists, ...rest }) => rest);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

function providerOf(info: RecordingInfo): string {
  return info.providerName ?? info.providerId ?? '';
}
