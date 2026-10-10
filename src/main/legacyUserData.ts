/**
 * Formats written by builds before the rename: those builds kept the installation's settings in a
 * userData folder named after the old product name ("<appData>/<old name>", "<old name> Dev" for
 * unpackaged runs) and, unless the user chose another data folder, the companies in
 * "<Documents>/<old name>". Every legacy token of the Electron shell lives in this module.
 *
 * On the first launch of a renamed build, migrateLegacyUserData copies the settings files once —
 * app config (incl. the chosen data folder), backup-folder approvals, shell preferences, the window
 * position, and the edit-log anchors with their key — into the new userData folder. It never
 * overwrites a new folder that already holds any of them, never deletes or moves the old folder, and
 * never moves company data: when the old config used the default data folder and that folder exists,
 * the new config points at it explicitly, so the companies open exactly where they are.
 *
 * The anchor key is sealed with Electron safeStorage. On Windows that seal uses an encryption key that
 * Chromium keeps (DPAPI-protected) in the userData folder's "Local State" file, so a sealed key is only
 * usable together with the old "Local State" — which is why the migration runs before the 'ready'
 * event, before Chromium reads that file. When the sealed key cannot travel (another OS, or the new
 * folder already has its own "Local State"), the anchors and their key are left behind together: the
 * companies then simply start new check-points, rather than old ones failing to verify under a new key
 * (which would be reported as tampering).
 */
import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_BACKUP_EXTENSION } from '../core/lib/legacyNames.ts';
import { BACKUP_EXTENSION } from '../shared/types/data.ts';

/** Product name of builds before the rename (their userData and default data folder names). */
export const LEGACY_PRODUCT_NAME = 'Bahi ERP';

/** App settings that carry over as they are. */
export const SETTINGS_FILES: readonly string[] = ['config.json', 'backup-folders.json', 'shell-preferences.json', 'window-state.json'];
/** The edit-log anchor key and the anchors signed with it: they carry over together or not at all. */
export const ANCHOR_KEY_FILE = 'audit-anchor.key';
export const ANCHORS_FILE = 'audit-anchors.json';
/** Chromium's browser-wide state; holds the key that safeStorage seals with on Windows. */
export const BROWSER_STATE_FILE = 'Local State';

/** Every settings file of a userData folder that carries over (the rest is Chromium cache / logs). */
export const MIGRATED_FILES: readonly string[] = [...SETTINGS_FILES, ANCHOR_KEY_FILE, ANCHORS_FILE];

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
  /** Defaults to process.platform (tests pass it explicitly). */
  platform?: NodeJS.Platform;
}

export interface LegacyMigrationResult {
  status: 'migrated' | 'no_legacy' | 'already_set_up';
  /** The old userData folder looked at. */
  from: string;
  /** Files copied into the new userData folder. */
  copied: string[];
  /** Files present in the old folder but deliberately not copied, with the reason. */
  skipped: { file: string; reason: string }[];
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

/** Whether the anchor key file holds an OS-sealed key (unreadable / unknown → treated as sealed). */
function keyIsSealed(file: string): boolean {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return !(v !== null && typeof v === 'object' && (v as Record<string, unknown>).sealed === false);
  } catch {
    return true;
  }
}

/** Copy the old installation's settings into the new userData folder once (see the module comment). */
export function migrateLegacyUserData(opts: LegacyMigrationOptions): LegacyMigrationResult {
  const platform = opts.platform ?? process.platform;
  const from = path.join(opts.appDataDir, legacyProfileName(opts.dev));
  const to = opts.userDataDir;
  const result: LegacyMigrationResult = { status: 'no_legacy', from, copied: [], skipped: [], dataDir: null };
  if (path.resolve(from) === path.resolve(to)) return result;
  const present = MIGRATED_FILES.filter((f) => isFile(path.join(from, f)));
  if (present.length === 0) return result;
  if (MIGRATED_FILES.some((f) => fs.existsSync(path.join(to, f)))) return { ...result, status: 'already_set_up' };

  fs.mkdirSync(to, { recursive: true });
  /** Copy without ever overwriting; one unreadable file never blocks the rest (each store falls back to its defaults). */
  const copy = (f: string): boolean => {
    try {
      fs.copyFileSync(path.join(from, f), path.join(to, f), fs.constants.COPYFILE_EXCL);
      result.copied.push(f);
      return true;
    } catch {
      return false;
    }
  };
  for (const f of SETTINGS_FILES) if (present.includes(f)) copy(f);

  // The anchors only mean something with the key they were signed with.
  if (present.includes(ANCHOR_KEY_FILE)) {
    let portable = !keyIsSealed(path.join(from, ANCHOR_KEY_FILE));
    let reason = '';
    if (!portable) {
      if (platform !== 'win32') reason = 'the key is sealed for the old product name';
      else if (!isFile(path.join(from, BROWSER_STATE_FILE))) reason = 'the key that sealed it was not found';
      else if (fs.existsSync(path.join(to, BROWSER_STATE_FILE))) reason = 'the new folder already has its own sealing key';
      else portable = copy(BROWSER_STATE_FILE);
      if (!portable && !reason) reason = 'the sealing key could not be copied';
    }
    if (portable && copy(ANCHOR_KEY_FILE)) {
      if (present.includes(ANCHORS_FILE)) copy(ANCHORS_FILE);
    } else {
      for (const f of [ANCHOR_KEY_FILE, ANCHORS_FILE]) {
        if (present.includes(f)) result.skipped.push({ file: f, reason: reason || 'could not be copied' });
      }
    }
  } else if (present.includes(ANCHORS_FILE)) {
    result.skipped.push({ file: ANCHORS_FILE, reason: 'its key is missing' });
  }
  result.status = 'migrated';

  // Companies in the old default data folder stay where they are: point the new config at it.
  const configFile = path.join(to, 'config.json');
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

/**
 * Extensions of a file-open filter: one that offers backups also offers the extension of backups made
 * before the rename (they are still verified and restored). Other filters are returned unchanged.
 */
export function withLegacyBackupExtension(extensions: readonly string[]): string[] {
  const current = BACKUP_EXTENSION.slice(1);
  const legacy = LEGACY_BACKUP_EXTENSION.slice(1);
  return extensions.includes(current) && !extensions.includes(legacy) ? [...extensions, legacy] : [...extensions];
}
