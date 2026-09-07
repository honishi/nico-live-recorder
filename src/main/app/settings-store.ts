import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { AppSettings, TargetUser, UiState, WindowBounds } from '../../shared/types';
import { MIN_FREE_SPACE_GB, numberInRange, POLL_INTERVAL_SEC } from '../../shared/limits';

export function defaultUiState(): UiState {
  return { tab: 'recordings', showDebug: false, autoScroll: true };
}

export function defaultSettings(defaultOutputDir: string): AppSettings {
  return {
    outputDir: defaultOutputDir,
    targets: [],
    pollIntervalSec: POLL_INTERVAL_SEC.default,
    recordOngoingOnStart: true,
    pushEnabled: true,
    notificationsEnabled: true,
    minFreeSpaceGb: MIN_FREE_SPACE_GB.default,
    ui: defaultUiState(),
  };
}

/**
 * 設定の JSON ファイル永続化。書き込みは一時ファイル経由で置き換える
 */
export class SettingsStore extends EventEmitter<{
  change: [settings: AppSettings];
  /** UI 状態だけが変わった (検知の再起動は不要) */
  ui: [ui: UiState];
}> {
  private settings: AppSettings;

  constructor(
    private readonly filePath: string,
    defaultOutputDir: string,
  ) {
    super();
    this.settings = this.load(defaultOutputDir);
  }

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  update(patch: Partial<AppSettings>): AppSettings {
    // 保存に失敗した場合は、メモリ内の設定と変更通知も更新しない
    const next = { ...this.settings, ...patch };
    this.persist(next);
    this.settings = next;
    this.emit('change', this.get());
    return this.get();
  }

  /** UI 状態とウィンドウ位置は検知の再起動に関係ないので change を出さずに保存する */
  updateUi(patch: Partial<UiState>): AppSettings {
    this.settings = { ...this.settings, ui: { ...this.settings.ui, ...patch } };
    this.persist();
    this.emit('ui', { ...this.settings.ui });
    return this.get();
  }

  setWindowBounds(bounds: WindowBounds): void {
    this.settings = { ...this.settings, window: bounds };
    this.persist();
  }

  upsertTarget(target: TargetUser): AppSettings {
    // 配列の順序を表示順とし、更新は元の位置、新規追加は末尾に置く
    const targets = [...this.settings.targets];
    const index = targets.findIndex((t) => t.userId === target.userId);
    if (index < 0) {
      targets.push(target);
    } else {
      targets[index] = target;
    }
    return this.update({ targets });
  }

  /** 最新の一覧で指定行の直前へ移動する。null は末尾で、消えた行への移動は無視する */
  moveTarget(userId: string, beforeUserId: string | null): AppSettings {
    const current = this.settings.targets;
    const target = current.find((item) => item.userId === userId);
    if (!target || userId === beforeUserId) {
      return this.get();
    }
    const targets = current.filter((item) => item.userId !== userId);
    const index =
      beforeUserId === null
        ? targets.length
        : targets.findIndex((item) => item.userId === beforeUserId);
    if (index < 0) {
      return this.get();
    }
    targets.splice(index, 0, target);
    if (targets.every((item, position) => item.userId === current[position].userId)) {
      return this.get();
    }
    return this.update({ targets });
  }

  removeTarget(userId: string): AppSettings {
    this.removeTargets([userId]);
    return this.get();
  }

  /** 削除直前の情報を返し、複数件でも保存と変更通知を一度にまとめる */
  removeTargets(userIds: readonly string[]): TargetUser[] {
    const ids = new Set(userIds);
    const removed = this.settings.targets.filter((target) => ids.has(target.userId));
    if (removed.length > 0) {
      this.update({ targets: this.settings.targets.filter((target) => !ids.has(target.userId)) });
    }
    return structuredClone(removed);
  }

  /** 現在の行順と再登録済みの内容を保ち、削除時に後続だった行の前へ復元する */
  restoreTargets(
    targets: readonly TargetUser[],
    previousOrder: readonly string[] = [],
  ): AppSettings {
    const restored = [...this.settings.targets];
    const existing = new Set(restored.map((target) => target.userId));
    const missing = new Map<string, TargetUser>();
    for (const target of targets) {
      if (!existing.has(target.userId) && !missing.has(target.userId)) {
        missing.set(target.userId, structuredClone(target));
      }
    }
    if (missing.size === 0) {
      return this.get();
    }
    // 後ろから戻せば、連続して削除した行も元の順序で挿入できる
    let nextId: string | undefined;
    for (const userId of [...previousOrder].reverse()) {
      const target = missing.get(userId);
      if (target) {
        const index =
          nextId === undefined
            ? restored.length
            : restored.findIndex((item) => item.userId === nextId);
        restored.splice(index, 0, target);
        existing.add(userId);
        missing.delete(userId);
      }
      if (existing.has(userId)) {
        nextId = userId;
      }
    }
    restored.push(...missing.values());
    return this.update({ targets: restored });
  }

  setTargetEnabled(userId: string, enabled: boolean): AppSettings {
    return this.update({
      targets: this.settings.targets.map((t) => (t.userId === userId ? { ...t, enabled } : t)),
    });
  }

  private load(defaultOutputDir: string): AppSettings {
    const defaults = defaultSettings(defaultOutputDir);
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<
        Record<keyof AppSettings, unknown>
      >;
      // 手で編集されたり壊れたりした値は既定値に戻す。特にポーリング間隔が NaN になると
      // setInterval が 1ms 扱いになり、API を連続で叩いてしまう
      return {
        ...defaults,
        outputDir:
          typeof raw.outputDir === 'string' && raw.outputDir.trim()
            ? raw.outputDir
            : defaults.outputDir,
        targets: Array.isArray(raw.targets) ? (raw.targets as TargetUser[]) : [],
        pollIntervalSec:
          numberInRange(raw.pollIntervalSec, POLL_INTERVAL_SEC) ?? defaults.pollIntervalSec,
        minFreeSpaceGb:
          numberInRange(raw.minFreeSpaceGb, MIN_FREE_SPACE_GB) ?? defaults.minFreeSpaceGb,
        recordOngoingOnStart: booleanOr(raw.recordOngoingOnStart, defaults.recordOngoingOnStart),
        pushEnabled: booleanOr(raw.pushEnabled, defaults.pushEnabled),
        notificationsEnabled: booleanOr(raw.notificationsEnabled, defaults.notificationsEnabled),
        window:
          typeof raw.window === 'object' && raw.window !== null
            ? (raw.window as WindowBounds)
            : undefined,
        ui: { ...defaults.ui, ...(typeof raw.ui === 'object' && raw.ui !== null ? raw.ui : {}) },
      };
    } catch {
      return defaults;
    }
  }

  private persist(settings = this.settings): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
