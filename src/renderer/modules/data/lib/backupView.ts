/**
 * Pure presentation logic for the backup / restore / verify screens (tested in backupView.test.ts).
 */
import type { CompanyListItem } from '../../../../shared/types/app.ts';
import type { BackupCheck, BackupFileInfo, BackupVerifyResult, DataVerifyResult } from '../../../../shared/types/data.ts';

/** Same rule as the server (BACKUP_PASSWORD_MIN in src/core/modules/data/backup.ts). */
export const BACKUP_PASSWORD_MIN = 8;

export type StatusTone = 'success' | 'warning' | 'danger' | 'info';

export interface PasswordStrength {
  /** 0 = unusable (too short) … 4 = strong. */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  tone: StatusTone;
  /** One plain-English tip, or null when nothing to add. */
  tip: string | null;
}

/**
 * How hard a backup password is to guess. Length matters most; mixing letters, digits and symbols
 * helps. Never blocks a valid (8+ character) password — it only advises.
 */
export function passwordStrength(pw: string): PasswordStrength {
  if (pw.length === 0) return { score: 0, label: 'No password', tone: 'info', tip: null };
  if (pw.length < BACKUP_PASSWORD_MIN) {
    const left = BACKUP_PASSWORD_MIN - pw.length;
    return { score: 0, label: 'Too short', tone: 'danger', tip: `Add ${left} more character${left === 1 ? '' : 's'} (at least ${BACKUP_PASSWORD_MIN}).` };
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  const repeated = /^(.)\1+$/.test(pw) || /^(?:0123456789|1234567890|12345678|abcdefgh|password|qwerty)/i.test(pw);
  let score = 1;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (classes >= 3) score++;
  if (repeated) score = 1;
  const s = Math.min(4, score) as 1 | 2 | 3 | 4;
  const label = s === 1 ? 'Weak' : s === 2 ? 'Fair' : s === 3 ? 'Good' : 'Strong';
  const tone: StatusTone = s === 1 ? 'warning' : s === 2 ? 'warning' : 'success';
  const tip =
    s >= 4
      ? null
      : repeated
        ? 'Easy to guess — avoid repeated or common sequences.'
        : pw.length < 14
          ? 'A longer phrase (14+ characters) is much harder to guess.'
          : 'Mix capital letters, digits and a symbol.';
  return { score: s, label, tone, tip };
}

/** Problem with the password pair before creating an encrypted backup, or null. */
export function passwordProblem(pw: string, confirm: string): { field: 'password' | 'confirm'; message: string } | null {
  if (pw === '') return null;
  if (pw.length < BACKUP_PASSWORD_MIN) return { field: 'password', message: `Use at least ${BACKUP_PASSWORD_MIN} characters.` };
  if (pw !== confirm) return { field: 'confirm', message: 'The two passwords are different. Type the same password again.' };
  return null;
}

/** "Last backup" line for the backup screen: how fresh the newest backup is. */
export function backupFreshness(lastBackupAt: string | null, now: Date): { tone: StatusTone; title: string } {
  if (!lastBackupAt) return { tone: 'warning', title: 'This company has never been backed up' };
  const ms = now.getTime() - Date.parse(lastBackupAt);
  if (!Number.isFinite(ms)) return { tone: 'warning', title: 'The date of the last backup is unknown' };
  const hours = Math.max(0, Math.floor(ms / 3_600_000));
  const days = Math.floor(hours / 24);
  const ago = hours < 1 ? 'less than an hour ago' : hours < 24 ? `${hours} hour${hours === 1 ? '' : 's'} ago` : `${days} day${days === 1 ? '' : 's'} ago`;
  if (days >= 7) return { tone: 'danger', title: `Last backup ${ago} — back up now` };
  if (days >= 1) return { tone: 'warning', title: `Last backup ${ago}` };
  return { tone: 'success', title: `Last backup ${ago}` };
}

/** Status cell of a backup file in the list. */
export function backupRowStatus(b: BackupFileInfo): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' } {
  if (b.problem || !b.manifest) return { label: 'Unreadable', tone: 'danger' };
  if (b.manifest.encrypted) return { label: 'Password', tone: 'info' };
  return { label: b.manifest.kind === 'auto' ? 'Automatic' : 'Manual', tone: 'neutral' };
}

const CHECK_LABELS: Readonly<Record<BackupCheck['name'], string>> = {
  container: 'Backup file',
  checksum: 'File not damaged',
  password: 'Password',
  decompress: 'Unpacks',
  database_checksum: 'Data matches',
  integrity: 'Database intact',
  schema: 'Opens in this version',
  company: 'Company',
  edit_log: 'Edit log intact',
  attachments: 'Attached files',
};

export function checkLabel(name: BackupCheck['name']): string {
  return CHECK_LABELS[name] ?? name;
}

/** One-line outcome of a backup verification. */
export function verifyOutcome(r: BackupVerifyResult): { tone: StatusTone; title: string; message: string } {
  if (r.ok) {
    return {
      tone: 'success',
      title: 'The backup is good',
      message: `${r.companyName ?? 'The company'} can be restored from this file${r.counts ? ` (${r.counts.ledgers} ledgers, ${r.counts.vouchers} vouchers)` : ''}.`,
    };
  }
  if (r.needsPassword) return { tone: 'info', title: 'This backup has a password', message: 'Enter the password used when the backup was made to check its contents.' };
  const failed = r.checks.find((c) => c.ok === false);
  if (!r.supported && r.manifest) {
    return { tone: 'danger', title: 'Made by a newer version of Pevqori', message: failed?.message ?? 'Update Pevqori on this computer, then restore the backup.' };
  }
  return { tone: 'danger', title: 'This backup cannot be used', message: failed?.message ?? 'The file could not be read.' };
}

export interface RestoreTarget {
  id: string;
  name: string;
  /** Why it cannot be replaced, or null. */
  disabledReason: string | null;
  /** Same company as the backup (by company folder id) — listed first. */
  sameCompany: boolean;
  securityEnabled: boolean;
}

/**
 * Companies a backup may replace: never the open one; the backup's own company first. (The server
 * also refuses a company with a different identity — the message comes back from the route.)
 */
export function restoreTargets(companies: readonly CompanyListItem[], openCompanyId: string | null, backupCompanyId: string | null): RestoreTarget[] {
  return companies
    .map((c) => ({
      id: c.id,
      name: c.name,
      sameCompany: backupCompanyId !== null && c.id === backupCompanyId,
      securityEnabled: c.securityEnabled,
      disabledReason: c.id === openCompanyId ? 'Open now — close it first (F3)' : null,
    }))
    .sort((a, b) => Number(b.sameCompany) - Number(a.sameCompany) || a.name.localeCompare(b.name, 'en-IN'));
}

/** Summary line of the data check. */
export function dataCheckSummary(r: DataVerifyResult): { tone: StatusTone; title: string; message: string } {
  const failed = r.checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    return { tone: 'success', title: 'Your books are in order', message: `All ${r.checks.length} checks passed.` };
  }
  const problems = failed.reduce((s, c) => s + c.count, 0);
  return {
    tone: failed.some((c) => c.name === 'integrity' || c.name === 'voucher_balance' || c.name === 'audit_chain') ? 'danger' : 'warning',
    title: `${failed.length} of ${r.checks.length} checks found problems`,
    // One line (2.1): what to do next lives in the screen's About (Enter opens a check; a damaged database → restore).
    message: `${problems} problem${problems === 1 ? '' : 's'} in total.`,
  };
}

/**
 * Elements that do something with Enter themselves (2.1): a wizard step whose one action is the title row's
 * primary runs it on Enter only where Enter has no other job — the page, a heading, a read-only table.
 */
export const ENTER_OWNERS =
  'button, a[href], input, select, textarea, [contenteditable="true"], [role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=tab], [role=combobox], [role=switch], [role=checkbox], [role=radio], [role=dialog], [role=alertdialog]';

/** Whether Enter on `target` should run the step's action (not when the focused element owns Enter). */
export function enterRunsStep(target: { closest(selector: string): unknown } | null): boolean {
  return !target || target.closest(ENTER_OWNERS) === null;
}

/** A wizard step (Import, XML data import, Restore). */
export interface StepDef {
  id: string;
  label: string;
}

/**
 * The wizard's progress as the title row's context words (2.1: one quiet line instead of a row of numbered
 * discs): "Step 2 of 4 · Choose file". Empty when `current` is not one of the steps.
 */
export function stepLine(steps: readonly StepDef[], current: string): string {
  const at = steps.findIndex((s) => s.id === current);
  if (at < 0) return '';
  return `Step ${at + 1} of ${steps.length} · ${steps[at].label}`;
}

/**
 * The Backup screen's state in words (2.1): `line` is the context run ("Last backup 3 hours ago · automatic
 * daily, newest 7 kept"); `alert` is set only when the freshness needs action (never backed up, stale, date
 * unknown) — the screen then shows it as a one-line banner with its title verbatim.
 */
export function backupStatusLine(
  fresh: { tone: StatusTone; title: string },
  auto: { on: boolean; keepLast: number } | null,
): { line: string; alert: { tone: StatusTone; title: string } | null } {
  const autoText = auto === null ? '' : auto.on ? `automatic daily, newest ${auto.keepLast} kept` : 'automatic backups off';
  const alert = fresh.tone === 'success' ? null : fresh;
  const head = alert ? '' : fresh.title;
  return { line: [head, autoText].filter(Boolean).join(' · '), alert };
}

/** Suggested file name prefix shown before the backup is written. */
export function backupFileNamePreview(companyName: string, now: Date): string {
  // Same rule as safeFileNamePart() on the server.
  const cleaned = companyName
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/g, '')
    .trim();
  const safe = !cleaned || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(cleaned) ? 'Company' : cleaned;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${safe}_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.pvqbak`;
}

export type RestoreStep = 'choose' | 'check' | 'restore' | 'done';

/** Where the restore wizard is: no file → choose; not verified → check; verified → restore; result → done. */
export function restoreStep(s: { hasFile: boolean; verified: boolean; restored: boolean }): RestoreStep {
  if (s.restored) return 'done';
  if (!s.hasFile) return 'choose';
  return s.verified ? 'restore' : 'check';
}

/** Problem with the restore choices, or null when the restore can run. */
export function restoreChoiceProblem(c: {
  mode: 'new' | 'replace';
  target: RestoreTarget | null;
  ownerPassword: string;
}): string | null {
  if (c.mode === 'new') return null;
  if (!c.target) return 'Choose the company to replace.';
  if (c.target.disabledReason) return `${c.target.name} cannot be replaced: ${c.target.disabledReason}.`;
  if (c.target.securityEnabled && c.ownerPassword === '') return `${c.target.name} is password-protected. Enter its owner password.`;
  return null;
}
