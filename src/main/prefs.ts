/**
 * Shell-only preferences that belong to this desktop install rather than to a company or to the core
 * app config: currently the zoom factor. Stored as <userData>/shell-preferences.json (atomic writes,
 * validated on read). The theme lives in the core app config (runtime.getTheme/setTheme).
 */
import path from 'node:path';
import { readJsonFile, writeFileAtomicSync } from './files.ts';
import { ZOOM_MAX, ZOOM_MIN } from './config.ts';
import { describeError, log } from './log.ts';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface ShellPrefs {
  zoom: number;
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
  let current: ShellPrefs = { zoom: typeof stored.zoom === 'number' ? clampZoom(stored.zoom) : 1 };

  return {
    get: () => current,
    update(patch) {
      const zoom = typeof patch.zoom === 'number' ? clampZoom(patch.zoom) : current.zoom;
      if (zoom === current.zoom) return;
      current = { zoom };
      try {
        writeFileAtomicSync(file, JSON.stringify(current, null, 2));
      } catch (err) {
        log('warn', 'Could not save shell preferences', describeError(err));
      }
    },
  };
}
