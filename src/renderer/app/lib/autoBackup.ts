/**
 * Automatic backup (F12 › Backup › "Back up automatically") — how the shell drives
 * 'data.backup.auto' and what it tells the user. Pure (tested in autoBackup.test.ts).
 *
 *  - after the company opens (or a user logs in): trigger 'open', a few seconds later so the first
 *    screen loads first — catches up when the last session ended without a backup;
 *  - before F3 / Ctrl+Q close the company: trigger 'close', waited for at most
 *    AUTO_BACKUP_CLOSE_WAIT_MS so closing never hangs (the core finishes it before closing the database);
 *  - closing the window / quitting from the OS: the core runtime runs it itself on shutdown.
 * The core writes at most one automatic backup per 24 hours.
 */

export const AUTO_BACKUP_OPEN_DELAY_MS = 4_000;
export const AUTO_BACKUP_CLOSE_WAIT_MS = 15_000;
/** Show "Backing up…" only when the backup is actually taking a moment. */
export const AUTO_BACKUP_PROGRESS_DELAY_MS = 400;

export interface AutoBackupNotice {
  tone: 'success' | 'warning';
  title: string;
  message?: string;
  /** Offer to open the Backup screen. */
  openBackup?: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

/** What to show for a 'data.backup.auto' result (null = nothing to say: off, recent, new company). */
export function autoBackupNotice(result: unknown): AutoBackupNotice | null {
  if (!isObj(result)) return null;
  if (result.reason === 'created' && result.ran === true) {
    const backup = isObj(result.backup) ? result.backup : null;
    const file = backup && typeof backup.fileName === 'string' ? backup.fileName : null;
    return { tone: 'success', title: 'Backed up automatically', message: file ? `Saved ${file}.` : undefined };
  }
  if (result.reason === 'failed') {
    const why = typeof result.error === 'string' && result.error.trim() ? result.error.trim() : 'The automatic backup could not be written.';
    return { tone: 'warning', title: 'Automatic backup failed', message: `${why} Back up from Data › Backup, or choose another folder in F12 › Backup.`, openBackup: true };
  }
  return null;
}

/** Resolve with the promise's value, or 'timeout' after `ms` (the promise keeps running). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
