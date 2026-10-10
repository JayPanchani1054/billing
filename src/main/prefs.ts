/**
 * Shell-only preferences that belong to this desktop install rather than to a company or to the core
 * app config: the zoom factor and the in-app update choice (mode + last successful check, 2.0). Stored
 * as <userData>/shell-preferences.json (atomic writes, validated on read). The theme lives in the core
 * app config (runtime.getTheme/setTheme).
 */
import path from 'node:path';
import { readJsonFile, writeFileAtomicSync } from './files.ts';
import { ZOOM_MAX, ZOOM_MIN } from './config.ts';
import { describeError, log } from './log.ts';

export type ThemeMode = 'system' | 'light' | 'dark';

/** The user's own update choice; administrator policy and the environment can override it (updates/policy.ts). */
export interface UpdatePrefs {
  mode: 'manual' | 'weekly';
  /** ISO time of the last successful update check, or null. */
  lastCheck: string | null;
}

export interface ShellPrefs {
  zoom: number;
  updates?: UpdatePrefs;
}

/** Validate a stored `updates` value; anything unexpected is dropped (the default, manual, then applies). */
export function parseUpdatePrefs(raw: unknown): UpdatePrefs | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.mode !== 'manual' && r.mode !== 'weekly') return undefined;
  const last = typeof r.lastCheck === 'string' && r.lastCheck.length <= 40 && Number.isFinite(Date.parse(r.lastCheck)) ? r.lastCheck : null;
  return { mode: r.mode, lastCheck: last };
}

export function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) return 1;
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor)) * 100) / 100;
}

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'system' || v === 'light' || v === 'dark';
}

export interface PrefsStore {
  get(): Readonly<ShellPrefs>;
  update(patch: Partial<ShellPrefs>): void;
}

export function createPrefsStore(userDataDir: string): PrefsStore {
  const file = path.join(userDataDir, 'shell-preferences.json');
  const raw = readJsonFile(file);
  const stored = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const updates = parseUpdatePrefs(stored.updates);
  let current: ShellPrefs = { zoom: typeof stored.zoom === 'number' ? clampZoom(stored.zoom) : 1, ...(updates ? { updates } : {}) };

  return {
    get: () => current,
    update(patch) {
      const zoom = typeof patch.zoom === 'number' ? clampZoom(patch.zoom) : current.zoom;
      const nextUpdates = patch.updates !== undefined ? parseUpdatePrefs(patch.updates) : current.updates;
      const sameUpdates =
        nextUpdates?.mode === current.updates?.mode && nextUpdates?.lastCheck === current.updates?.lastCheck;
      if (zoom === current.zoom && sameUpdates) return;
      current = { zoom, ...(nextUpdates ? { updates: nextUpdates } : {}) };
      try {
        writeFileAtomicSync(file, JSON.stringify(current, null, 2));
      } catch (err) {
        log('warn', 'Could not save shell preferences', describeError(err));
      }
    },
  };
}
