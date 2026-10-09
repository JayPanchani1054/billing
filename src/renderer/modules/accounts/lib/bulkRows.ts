/**
 * Multiple ledger creation grid: row model, client checks (duplicates within the grid, GSTIN
 * checksum), conversion to accounts.ledger.bulkCreate input and mapping of the server's
 * `rows[i].<field>` errors back to grid rows (blank rows are skipped when sending).
 * Pure — tested in bulkRows.test.ts.
 */
import { normalizeGstin, validateGstin } from '../../../../shared/gst/gstin.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { LedgerBulkRowInput } from '../../../../shared/types/accounts.ts';

export interface BulkRow {
  key: string;
  name: string;
  groupId: number | null;
  /** Signed paise (Dr +, Cr −). */
  openingBalance: Paise | null;
  gstin: string;
  stateCode: string;
}

let seq = 0;
export function newBulkRow(groupId: number | null = null): BulkRow {
  seq += 1;
  return { key: `row-${seq}`, name: '', groupId, openingBalance: null, gstin: '', stateCode: '' };
}

export function isBlankRow(r: BulkRow): boolean {
  return r.name.trim() === '' && (r.openingBalance === null || r.openingBalance === 0) && r.gstin.trim() === '';
}

/** Errors keyed `<rowKey>.<field>`. */
export type BulkErrors = Record<string, string>;

export function validateBulkRows(rows: readonly BulkRow[], existingNames: ReadonlySet<string> = new Set()): BulkErrors {
  const e: BulkErrors = {};
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    if (isBlankRow(r)) return;
    const name = r.name.trim();
    const k = name.toLowerCase();
    if (!name) e[`${r.key}.name`] = 'Enter the ledger name';
    else if (seen.has(k)) e[`${r.key}.name`] = `Same name as row ${(seen.get(k) ?? 0) + 1}`;
    else if (existingNames.has(k)) e[`${r.key}.name`] = 'A ledger or group with this name already exists';
    if (name) seen.set(k, i);
    if (r.groupId === null) e[`${r.key}.groupId`] = 'Choose the group';
    const g = normalizeGstin(r.gstin);
    if (g) {
      const v = validateGstin(g);
      if (!v.valid) e[`${r.key}.gstin`] = v.error ?? 'GSTIN is not valid';
      else if (r.stateCode && v.stateCode && v.stateCode !== r.stateCode) e[`${r.key}.gstin`] = `This GSTIN belongs to state ${v.stateCode}, not ${r.stateCode}`;
    }
  });
  return e;
}

/** Input for accounts.ledger.bulkCreate plus the grid index of each sent row. */
export function bulkInput(rows: readonly BulkRow[]): { rows: LedgerBulkRowInput[]; rowKeys: string[] } {
  const out: LedgerBulkRowInput[] = [];
  const rowKeys: string[] = [];
  for (const r of rows) {
    if (isBlankRow(r)) continue;
    const g = normalizeGstin(r.gstin);
    const row: LedgerBulkRowInput = { name: r.name.trim(), groupId: r.groupId ?? 0 };
    if (r.openingBalance) row.openingBalance = r.openingBalance;
    if (g) row.gstin = g;
    if (r.stateCode) row.stateCode = r.stateCode;
    out.push(row);
    rowKeys.push(r.key);
  }
  return { rows: out, rowKeys };
}

/** Server paths `rows[i].field` → `<rowKey>.field`; other paths are returned under `_`. */
export function mapBulkServerErrors(errors: Readonly<Record<string, string>>, rowKeys: readonly string[]): BulkErrors {
  const out: BulkErrors = {};
  for (const [path, msg] of Object.entries(errors)) {
    const m = /^rows\[(\d+)\]\.?(.*)$/.exec(path);
    const key = m ? rowKeys[Number(m[1])] : undefined;
    if (m && key) out[`${key}.${m[2] || 'name'}`] = msg;
    else out._ = out._ ? `${out._} ${msg}` : msg;
  }
  return out;
}

/** GSTIN typed in a row: once valid, fill the row's state from it. */
export function applyRowGstin(r: BulkRow, raw: string): BulkRow {
  const gstin = normalizeGstin(raw).slice(0, 15);
  const v = validateGstin(gstin);
  return { ...r, gstin, stateCode: v.valid && v.stateCode ? v.stateCode : r.stateCode };
}

/** Σ Dr and Σ Cr of the openings entered (for the grid footer). */
export function bulkTotals(rows: readonly BulkRow[]): { debit: Paise; credit: Paise; count: number } {
  let debit = 0;
  let credit = 0;
  let count = 0;
  for (const r of rows) {
    if (isBlankRow(r)) continue;
    count += 1;
    const a = r.openingBalance ?? 0;
    if (a > 0) debit += a;
    else credit -= a;
  }
  return { debit, credit, count };
}

/**
 * Accessibility of a grid cell: the id of its error text and the aria-describedby for its control
 * (undefined while the cell has no error), so a screen reader reads the error with the field.
 */
export function cellErrorId(rowKey: string, field: string): string {
  return `bl-${rowKey}-${field}-err`.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function cellDescribedBy(errors: BulkErrors, rowKey: string, field: string): string | undefined {
  return errors[`${rowKey}.${field}`] ? cellErrorId(rowKey, field) : undefined;
}
