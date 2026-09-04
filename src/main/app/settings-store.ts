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
    this.settings = { ...this.settings, ...patch };
    this.persist();
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
    const targets = this.settings.targets.filter((t) => t.userId !== target.userId);
    targets.push(target);
    targets.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    return this.update({ targets });
  }

  removeTarget(userId: string): AppSettings {
    return this.update({ targets: this.settings.targets.filter((t) => t.userId !== userId) });
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

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
