import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { AppSettings, TargetUser } from '../../shared/types';

export function defaultSettings(defaultOutputDir: string): AppSettings {
  return {
    outputDir: defaultOutputDir,
    targets: [],
    pollIntervalSec: 30,
    recordOngoingOnStart: true,
    pushEnabled: true,
    notificationsEnabled: true,
  };
}

/**
 * 設定の JSON ファイル永続化。書き込みは一時ファイル経由で置き換える
 */
export class SettingsStore extends EventEmitter<{ change: [settings: AppSettings] }> {
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
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<AppSettings>;
      return {
        ...defaults,
        ...raw,
        targets: Array.isArray(raw.targets) ? raw.targets : [],
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
