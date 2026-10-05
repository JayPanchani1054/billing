/**
 * Per-installation app configuration at <userDataDir>/config.json (written atomically).
 * A corrupt file is preserved as config.json.corrupt-<timestamp> and replaced with defaults,
 * so a damaged config can never stop the app from starting. A file that merely cannot be read right
 * now (sharing violation, permissions) is left alone: defaults are used in memory and the file is
 * not overwritten until it can be read again — otherwise a transient error would silently reset the
 * user's chosen data folder.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileTimestamp, readJsonFile, writeJsonAtomic } from '../lib/fsutil.ts';
import type { Logger } from './logger.ts';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface AppConfig {
  /** Absolute data folder; null = the platform default (RuntimeOptions.defaultDataDir). */
  dataDir: string | null;
  firstRunComplete: boolean;
  theme: ThemeMode;
  /** Most-recently-opened first, max 10. */
  recentCompanyIds: string[];
  lastCompanyId: string | null;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  dataDir: null,
  firstRunComplete: false,
  theme: 'system',
  recentCompanyIds: [],
  lastCompanyId: null,
};

const MAX_RECENT = 10;

/** Accept only well-typed fields from a stored config; anything else falls back to defaults. */
function sanitize(raw: unknown): AppConfig {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: AppConfig = { ...DEFAULT_APP_CONFIG, recentCompanyIds: [] };
  if (typeof src.dataDir === 'string' && path.isAbsolute(src.dataDir)) out.dataDir = src.dataDir;
  if (typeof src.firstRunComplete === 'boolean') out.firstRunComplete = src.firstRunComplete;
  if (src.theme === 'system' || src.theme === 'light' || src.theme === 'dark') out.theme = src.theme;
  if (Array.isArray(src.recentCompanyIds))
    out.recentCompanyIds = [...new Set(src.recentCompanyIds.filter((x): x is string => typeof x === 'string'))].slice(0, MAX_RECENT);
  if (typeof src.lastCompanyId === 'string') out.lastCompanyId = src.lastCompanyId;
  return out;
}

export class AppConfigStore {
  readonly file: string;
  private readonly defaultDataDir: string;
  private readonly log: Logger['log'];
  private current: AppConfig;
  /** True while config.json exists but could not be read; writes are held back until it can. */
  private unreadable = false;

  constructor(userDataDir: string, defaultDataDir: string, log: Logger['log']) {
    this.file = path.join(userDataDir, 'config.json');
    this.defaultDataDir = path.resolve(defaultDataDir);
    this.log = log;
    this.current = this.load();
  }

  private load(): AppConfig {
    const r = readJsonFile(this.file);
    this.unreadable = r.status === 'unreadable';
    if (r.status === 'missing') return sanitize({});
    if (r.status === 'ok') return sanitize(r.value);
    if (r.status === 'unreadable') {
      this.log('warn', 'App config could not be read; using defaults for now', { error: r.error });
      return sanitize({});
    }
    const backup = `${this.file}.corrupt-${fileTimestamp()}`;
    try {
      fs.renameSync(this.file, backup);
    } catch {
      /* keep going with defaults even if the backup fails */
    }
    this.log('warn', 'App config was unreadable; started with defaults', { backup, error: r.error });
    return sanitize({});
  }

  get(): AppConfig {
    return { ...this.current, recentCompanyIds: [...this.current.recentCompanyIds] };
  }

  /** Effective data folder (configured or default). */
  get dataDir(): string {
    return this.current.dataDir ?? this.defaultDataDir;
  }

  update(patch: Partial<AppConfig>): AppConfig {
    if (this.unreadable) {
      // Try again: if the stored file is readable now, apply the patch on top of it.
      const reloaded = this.load();
      if (!this.unreadable) this.current = reloaded;
    }
    const next = sanitize({ ...this.current, ...patch });
    if (this.unreadable) {
      this.log('warn', 'App config change kept in memory only (config.json cannot be read)');
    } else {
      writeJsonAtomic(this.file, next);
    }
    this.current = next;
    return this.get();
  }

  /** Record that a company was opened (recent list + last company). */
  noteOpened(companyId: string): AppConfig {
    const recent = [companyId, ...this.current.recentCompanyIds.filter((id) => id !== companyId)].slice(0, MAX_RECENT);
    return this.update({ recentCompanyIds: recent, lastCompanyId: companyId });
  }

  /** Forget a company (deleted or moved away). */
  forget(companyId: string): AppConfig {
    return this.update({
      recentCompanyIds: this.current.recentCompanyIds.filter((id) => id !== companyId),
      lastCompanyId: this.current.lastCompanyId === companyId ? null : this.current.lastCompanyId,
    });
  }
}
