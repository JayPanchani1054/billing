/**
 * Formats written by builds before the rename: those builds kept the installation's settings in a
 * userData folder named after the old product name ("<appData>/<old name>", "<old name> Dev" for
 * unpackaged runs) and, unless the user chose another data folder, the companies in
 * "<Documents>/<old name>". Every legacy token of the Electron shell lives in this module.
 *
 * On the first launch of a renamed build, migrateLegacyUserData copies the settings files once —
 * app config (incl. the chosen data folder), edit-log anchors and their key, backup-folder approvals,
 * shell preferences and the window position — into the new userData folder. It never overwrites a new
 * folder that already holds any of them, never deletes the old folder, and never moves company data:
 * when the old config used the default data folder and that folder exists, the new config points at it
 * explicitly, so the companies open exactly where they are.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Product name of builds before the rename (their userData and default data folder names). */
export const LEGACY_PRODUCT_NAME = 'Bahi ERP';

/** Settings files of a userData folder that carry over (the rest is Chromium cache / logs). */
export const MIGRATED_FILES: readonly string[] = [
  'config.json',
  'audit-anchors.json',
  'audit-anchor.key',
  'backup-folders.json',
  'shell-preferences.json',
  'window-state.json',
];

export function legacyProfileName(dev: boolean): string {
  return dev ? `${LEGACY_PRODUCT_NAME} Dev` : LEGACY_PRODUCT_NAME;
}

export interface LegacyMigrationOptions {
  /** app.getPath('appData'). */
  appDataDir: string;
  /** The new userData folder (app.getPath('userData')). */
  userDataDir: string;
  /** The Documents folder (parent of the default data folder). */
  documentsDir: string;
  /** The new default data folder (<Documents>/<new profile name>). */
  defaultDataDir: string;
  /** Unpackaged run ("… Dev" profile names). */
  dev: boolean;
}

export interface LegacyMigrationResult {
  status: 'migrated' | 'no_legacy' | 'already_set_up';
  /** The old userData folder looked at. */
  from: string;
  /** Files copied into the new userData folder. */
  copied: string[];
  /** Data folder written into the new config (the old default data folder), or null. */
  dataDir: string | null;
}

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Copy the old installation's settings into the new userData folder once (see the module comment). */
export function migrateLegacyUserData(opts: LegacyMigrationOptions): LegacyMigrationResult {
  const from = path.join(opts.appDataDir, legacyProfileName(opts.dev));
  const result: LegacyMigrationResult = { status: 'no_legacy', from, copied: [], dataDir: null };
  if (path.resolve(from) === path.resolve(opts.userDataDir)) return result;
  const present = MIGRATED_FILES.filter((f) => isFile(path.join(from, f)));
  if (present.length === 0) return result;
  if (MIGRATED_FILES.some((f) => fs.existsSync(path.join(opts.userDataDir, f)))) return { ...result, status: 'already_set_up' };

  fs.mkdirSync(opts.userDataDir, { recursive: true });
  for (const f of present) {
    try {
      fs.copyFileSync(path.join(from, f), path.join(opts.userDataDir, f), fs.constants.COPYFILE_EXCL);
      result.copied.push(f);
    } catch {
      /* one unreadable file never blocks the rest (each store falls back to its defaults) */
    }
  }
  result.status = 'migrated';

  // Companies in the old default data folder stay where they are: point the new config at it.
  const configFile = path.join(opts.userDataDir, 'config.json');
  const oldDefault = path.join(opts.documentsDir, legacyProfileName(opts.dev));
  if (result.copied.includes('config.json') && isDir(oldDefault) && !fs.existsSync(opts.defaultDataDir)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as unknown;
      if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
        const c = config as Record<string, unknown>;
        if (typeof c.dataDir !== 'string' || c.dataDir === '') {
          const tmp = `${configFile}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify({ ...c, dataDir: oldDefault }, null, 2));
          fs.renameSync(tmp, configFile);
          result.dataDir = oldDefault;
        }
      }
    } catch {
      /* a damaged config is handled (kept aside, defaults used) by the core's config store */
    }
  }
  return result;
}
