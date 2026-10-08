/**
 * Pure logic of the statement import wizard: the column-role editor (one role per column, Withdrawal/Deposit
 * vs a single Amount), mapping checks mirroring the server, header captions, issue grouping and summary text.
 */
import type {
  BankPresetId,
  StatementAmountSign,
  StatementColumnMap,
  StatementColumnRole,
  StatementDateOrder,
  StatementImportResult,
  StatementIssue,
  StatementMapping,
  StatementPreview,
} from '../../../../shared/types/banking.ts';
import { STATEMENT_COLUMN_ROLES } from '../../../../shared/types/banking.ts';

export const ROLE_LABEL: Record<StatementColumnRole, string> = {
  date: 'Date',
  valueDate: 'Value date',
  description: 'Narration',
  reference: 'Cheque / Ref. no.',
  debit: 'Withdrawal (Dr)',
  credit: 'Deposit (Cr)',
  amount: 'Amount (single column)',
  drCr: 'Dr / Cr of amount',
  balance: 'Balance',
  balanceDrCr: 'Dr / Cr of balance',
};

/** Editable mapping: roles may be unset while the user works. */
export interface MappingDraft {
  preset: BankPresetId;
  sheet: string | null;
  delimiter: StatementMapping['delimiter'];
  headerRow: number;
  columns: Partial<Record<StatementColumnRole, number>>;
  dateOrder: StatementDateOrder;
  amountSign: StatementAmountSign;
}

export function draftFromMapping(m: StatementMapping): MappingDraft {
  const columns: MappingDraft['columns'] = {};
  for (const role of STATEMENT_COLUMN_ROLES) {
    const idx = m.columns[role];
    if (typeof idx === 'number') columns[role] = idx;
  }
  return {
    preset: m.preset,
    sheet: m.sheet ?? null,
    delimiter: m.delimiter ?? null,
    headerRow: m.headerRow,
    columns,
    dateOrder: m.dateOrder,
    amountSign: m.amountSign ?? 'deposit_positive',
  };
}

/** A blank draft (nothing recognised): heading on the given row, no columns. */
export function blankDraft(headerRow = 0, sheet: string | null = null): MappingDraft {
  return { preset: 'generic', sheet, delimiter: null, headerRow, columns: {}, dateOrder: 'auto', amountSign: 'deposit_positive' };
}

export function roleOfColumn(d: MappingDraft, col: number): StatementColumnRole | null {
  for (const role of STATEMENT_COLUMN_ROLES) if (d.columns[role] === col) return role;
  return null;
}

/**
 * Give column `col` a role (null = ignore the column). A role sits on one column only; Withdrawal/Deposit and
 * the single Amount (+ its Dr/Cr) exclude each other.
 */
export function assignRole(d: MappingDraft, col: number, role: StatementColumnRole | null): MappingDraft {
  const columns: MappingDraft['columns'] = {};
  for (const r of STATEMENT_COLUMN_ROLES) {
    const idx = d.columns[r];
    if (idx === undefined || idx === col || r === role) continue;
    columns[r] = idx;
  }
  if (role !== null) {
    columns[role] = col;
    if (role === 'debit' || role === 'credit') {
      delete columns.amount;
      delete columns.drCr;
    }
    if (role === 'amount' || role === 'drCr') {
      delete columns.debit;
      delete columns.credit;
    }
  }
  return { ...d, columns };
}

/** What still prevents an import with this draft (empty when it can be previewed/imported). */
export function draftProblems(d: MappingDraft, columnCount: number): string[] {
  const out: string[] = [];
  const c = d.columns;
  if (c.date === undefined) out.push('Choose the Date column.');
  const split = c.debit !== undefined || c.credit !== undefined;
  if (!split && c.amount === undefined) out.push('Choose the Withdrawal and Deposit columns, or a single Amount column.');
  if (c.drCr !== undefined && c.amount === undefined) out.push('A Dr/Cr column needs the Amount column it belongs to.');
  if (c.balanceDrCr !== undefined && c.balance === undefined) out.push('A balance Dr/Cr column needs the Balance column.');
  for (const role of STATEMENT_COLUMN_ROLES) {
    const idx = c[role];
    if (idx !== undefined && idx >= columnCount) out.push(`${ROLE_LABEL[role]} points at column ${idx + 1}, but the heading row has ${columnCount} columns.`);
  }
  return out;
}

export function toMapping(d: MappingDraft): StatementMapping | null {
  if (d.columns.date === undefined) return null;
  const columns: StatementColumnMap = { date: d.columns.date };
  for (const role of STATEMENT_COLUMN_ROLES) {
    const idx = d.columns[role];
    if (role !== 'date' && idx !== undefined) columns[role] = idx;
  }
  return {
    preset: d.preset,
    sheet: d.sheet,
    delimiter: d.delimiter,
    headerRow: d.headerRow,
    columns,
    dateOrder: d.dateOrder,
    amountSign: d.amountSign,
  };
}

/** Column captions of the heading row ('Column 3' for blank cells), padded to the widest of the first rows. */
export function columnCaptions(raw: readonly (readonly string[])[], headerRow: number): string[] {
  const width = raw.reduce((w, r) => Math.max(w, r.length), 0);
  const header = raw[headerRow] ?? [];
  return Array.from({ length: width }, (_, i) => {
    const t = (header[i] ?? '').trim();
    return t === '' ? `Column ${i + 1}` : t;
  });
}

export interface IssueGroup {
  reason: string;
  level: StatementIssue['level'];
  count: number;
  /** First rows (≤ 8) for the message. */
  rows: number[];
}

/** Group skipped-row reasons: warnings first, then by count. Reasons naming a value are grouped by their prefix. */
export function groupIssues(issues: readonly StatementIssue[]): IssueGroup[] {
  const map = new Map<string, IssueGroup>();
  for (const i of issues) {
    const reason = i.reason.replace(/\s*"[^"]*"$/, '').replace(/^Running balance does not agree.*$/, 'Running balance does not agree');
    const key = `${i.level}|${reason}`;
    const g = map.get(key) ?? { reason, level: i.level, count: 0, rows: [] };
    g.count++;
    if (g.rows.length < 8 && i.row > 0) g.rows.push(i.row);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => (a.level === b.level ? b.count - a.count : a.level === 'warning' ? -1 : 1));
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** One line under the preview: "42 transactions from 01-Apr-2026 to 30-Apr-2026 · 3 already imported · 5 rows skipped". */
export function previewSummaryText(p: Pick<StatementPreview, 'summary'>, fmtDate: (iso: string | null) => string): string {
  const s = p.summary;
  if (s.lineCount === 0) return 'No transactions found with this mapping.';
  const parts = [`${plural(s.lineCount, 'transaction')} from ${fmtDate(s.from)} to ${fmtDate(s.to)}`];
  if (s.duplicates > 0) parts.push(`${plural(s.duplicates, 'line')} already imported (will be skipped)`);
  if (s.skippedRows > 0) parts.push(`${plural(s.skippedRows, 'row')} skipped`);
  if (s.order === 'descending') parts.push('newest-first file read bottom-up');
  return parts.join(' · ');
}

/** Problems worth a warning banner before importing. */
export function previewWarnings(p: Pick<StatementPreview, 'summary' | 'lines'>): string[] {
  const out: string[] = [];
  const b = p.summary.balanceCheck;
  if (b.swappedLikely) {
    out.push('The running balance only adds up with withdrawals and deposits the other way round — the Withdrawal and Deposit columns are probably swapped.');
  } else if (b.mismatches > 0) {
    out.push(
      `The running balance does not agree on ${plural(b.mismatches, 'row')}${b.firstMismatchRow ? ` (first at row ${b.firstMismatchRow})` : ''}. Some rows may have been skipped or read wrongly — check the skipped rows below.`,
    );
  }
  if (p.summary.lineCount > 0 && p.summary.duplicates === p.summary.lineCount) out.push('Every transaction in this file has already been imported for this bank. Importing it again adds nothing.');
  return out;
}

export function importResultText(r: StatementImportResult): string {
  if (r.imported === 0) return `Nothing new to import — all ${plural(r.duplicates, 'transaction')} were imported before.`;
  const parts = [`Imported ${plural(r.imported, 'transaction')}`];
  if (r.duplicates > 0) parts.push(`skipped ${plural(r.duplicates, 'duplicate')}`);
  if (r.skippedRows > 0) parts.push(`${plural(r.skippedRows, 'row')} ${r.skippedRows === 1 ? 'was not a transaction' : 'were not transactions'}`);
  return `${parts.join(', ')}.`;
}

export const DATE_ORDER_OPTIONS: ReadonlyArray<{ value: StatementDateOrder; label: string }> = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'dmy', label: 'Day / Month / Year (Indian)' },
  { value: 'mdy', label: 'Month / Day / Year' },
  { value: 'ymd', label: 'Year - Month - Day' },
];

export const AMOUNT_SIGN_OPTIONS: ReadonlyArray<{ value: StatementAmountSign; label: string }> = [
  { value: 'deposit_positive', label: 'Deposits are positive, withdrawals negative' },
  { value: 'withdrawal_positive', label: 'Withdrawals are positive, deposits negative' },
];
