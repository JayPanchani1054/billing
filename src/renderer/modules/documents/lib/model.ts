/**
 * Pure helpers of the documents screens (tested in model.test.ts): labels, tones, schedule text,
 * export tables, due-list selection, budget-line editing and the budget column of reports.
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { formatDate } from '../../../../shared/dates.ts';
import { formatQty } from '../../../../shared/format.ts';
import type {
  BillsPendingKind,
  BillsPendingRow,
  BudgetBasis,
  BudgetLineKind,
  BudgetVarianceRow,
  DocumentBaseType,
  DocumentDecision,
  DocumentRow,
  DocumentStatus,
  RecurringDueRow,
  RecurringFrequency,
  RecurringSchedule,
} from '../../../../shared/types/documents.ts';
import type { ExportCell, ExportColumn } from '../../../app/index.ts';

export interface ExportTable {
  columns: ExportColumn[];
  rows: ExportCell[][];
  totals?: ExportCell[];
  landscape?: boolean;
}

/** What a documents mutation can change elsewhere (vouchers, books in scenario reports, stock pending lists). */
export const DOCUMENTS_INVALIDATES = ['documents', 'vouchers', 'reports', 'gst', 'outstanding', 'stock', 'dashboard', 'accounts', 'inventory', 'print'];

/** localStorage key of "recurring vouchers due" dismissed for a company on a working day. */
export function noticeStorageKey(companyId: string, date: string): string {
  return `pevqori:${companyId}:recurring-notice:${date}`;
}

// ───────────────────────────── Quotations ─────────────────────────────

export const DOC_LABEL: Record<DocumentBaseType, { one: string; many: string; register: string }> = {
  quotation: { one: 'Quotation', many: 'Quotations', register: 'Quotations' },
  proforma: { one: 'Proforma Invoice', many: 'Proforma Invoices', register: 'Proforma Invoices' },
};

export type BadgeTone = 'neutral' | 'brand' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export const STATUS_META: Record<DocumentStatus, { label: string; tone: BadgeTone }> = {
  open: { label: 'Open', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'warning' },
  converted: { label: 'Converted', tone: 'brand' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

export const TARGET_LABEL: Partial<Record<VoucherBaseType, string>> = { sales_order: 'Sales Order', sales: 'Sales Invoice' };

/** "Expires in 3 days" / "Expired 2 days ago" / "Expires today" (null without a validity date). */
export function expiryText(r: Pick<DocumentRow, 'daysToExpiry' | 'status'>): string | null {
  if (r.daysToExpiry === null || r.status === 'converted' || r.status === 'cancelled' || r.status === 'rejected') return null;
  const d = r.daysToExpiry;
  if (d === 0) return 'Expires today';
  if (d > 0) return `Expires in ${d} day${d === 1 ? '' : 's'}`;
  return `Expired ${-d} day${d === -1 ? '' : 's'} ago`;
}

/** Can the document be converted now (the server re-checks)? */
export function canConvert(status: DocumentStatus): boolean {
  return status === 'open' || status === 'accepted' || status === 'expired';
}

/**
 * The decision the status dialog starts on: the opposite of an accepted document's state (it is being
 * reopened or lost), otherwise "Accepted". Worked out once the document's status has loaded — the
 * dialog opens before it arrives.
 */
export function defaultDecision(status: DocumentStatus | undefined): DocumentDecision {
  return status === 'accepted' ? 'rejected' : 'accepted';
}

export function documentsExport(rows: readonly DocumentRow[], base: DocumentBaseType): ExportTable {
  return {
    columns: [
      { header: 'Date', kind: 'date', width: 12 },
      { header: `${DOC_LABEL[base].one} No.`, width: 12 },
      { header: 'Party', width: 30 },
      { header: 'Valid until', kind: 'date', width: 12 },
      { header: 'Status', width: 12 },
      { header: 'Converted into', width: 24 },
      { header: 'Amount', kind: 'amount', width: 16 },
    ],
    rows: rows.map((r) => [
      r.date,
      r.number ?? '',
      r.partyName ?? '',
      r.validUntil,
      STATUS_META[r.status].label,
      r.convertedTo ? `${r.convertedTo.voucherTypeName} ${r.convertedTo.number ?? ''} dt ${formatDate(r.convertedTo.date)}` : '',
      r.amount,
    ]),
    totals: ['', '', 'Total', null, null, null, rows.reduce((a, r) => a + r.amount, 0)],
  };
}

// ───────────────────────────── Recurring ─────────────────────────────

export const FREQUENCY_LABEL: Record<RecurringFrequency, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  half_yearly: 'Half-yearly',
  yearly: 'Yearly',
  every_n_days: 'Every N days',
};

const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${s}`;
};

/** "Monthly on the 5th", "Quarterly on the last day", "Every 14 days" (+ " until 31-Mar-2027"). */
export function scheduleText(s: RecurringSchedule): string {
  let base: string;
  if (s.frequency === 'every_n_days') base = `Every ${s.intervalDays ?? 1} day${(s.intervalDays ?? 1) === 1 ? '' : 's'}`;
  else {
    const dom = s.dayOfMonth ?? Number(s.startDate.slice(8, 10));
    base = `${FREQUENCY_LABEL[s.frequency]} on the ${dom === 0 ? 'last day' : ordinal(dom)}`;
  }
  return s.endDate ? `${base} until ${formatDate(s.endDate)}` : base;
}

/** Keys of the due rows selected for posting (default: all). Pure set arithmetic for the review list. */
export function toggleKey(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export interface PostItem {
  templateId: number;
  periodKey: string;
  amount?: number;
}

/** The post request for the selected rows (in date order), with per-row amount overrides. */
export function postItems(rows: readonly RecurringDueRow[], selected: ReadonlySet<string>, overrides: Readonly<Record<string, number | null>>): PostItem[] {
  return rows
    .filter((r) => selected.has(r.key))
    .map((r) => {
      const o = overrides[r.key];
      const item: PostItem = { templateId: r.templateId, periodKey: r.periodKey };
      if (typeof o === 'number' && o > 0 && r.overridable && o !== r.amount) item.amount = o;
      return item;
    });
}

export function dueExport(rows: readonly RecurringDueRow[]): ExportTable {
  return {
    columns: [
      { header: 'Date', kind: 'date', width: 12 },
      { header: 'Template', width: 30 },
      { header: 'Voucher type', width: 16 },
      { header: 'Party', width: 26 },
      { header: 'Period', width: 10 },
      { header: 'Days overdue', kind: 'number', width: 10 },
      { header: 'Amount (before tax)', kind: 'amount', width: 16 },
    ],
    rows: rows.map((r) => [r.date, r.templateName, r.voucherTypeName, r.partyName ?? '', r.periodKey, r.overdueDays, r.amount]),
    totals: ['', 'Total', null, null, null, null, rows.reduce((a, r) => a + (r.amount ?? 0), 0)],
  };
}

// ───────────────────────────── Bills pending ─────────────────────────────

export const BILLS_LABEL: Record<BillsPendingKind, { title: string; party: string; invoice: string }> = {
  sales: { title: 'Sales Bills Pending', party: 'Customer', invoice: 'Invoice now' },
  purchase: { title: 'Purchase Bills Pending', party: 'Supplier', invoice: 'Enter bill' },
};

export const NOTE_LABEL: Partial<Record<VoucherBaseType, string>> = {
  delivery_note: 'Delivery Note',
  rejection_in: 'Rejections In',
  receipt_note: 'Receipt Note',
  rejection_out: 'Rejections Out',
};

export function billsPendingExport(rows: readonly BillsPendingRow[], kind: BillsPendingKind): ExportTable {
  return {
    columns: [
      { header: 'Date', kind: 'date', width: 12 },
      { header: 'Note', width: 18 },
      { header: BILLS_LABEL[kind].party, width: 26 },
      { header: 'Item', width: 26 },
      { header: 'Quantity', width: 12 },
      { header: 'Billed', width: 12 },
      { header: 'Pending', width: 12 },
      { header: 'Age (days)', kind: 'number', width: 10 },
      { header: 'Pending value', kind: 'amount', width: 16 },
    ],
    rows: rows.map((r) => [
      r.noteDate,
      `${NOTE_LABEL[r.noteBaseType] ?? r.noteTypeName} ${r.noteNo ?? ''}`.trim(),
      r.partyName,
      r.itemName,
      formatQty(r.qty, 3, r.unit),
      formatQty(r.billedQty, 3, r.unit),
      formatQty(r.pendingQty, 3, r.unit),
      r.ageDays,
      r.pendingValue,
    ]),
    totals: ['', '', 'Total', '', '', '', '', null, rows.reduce((a, r) => a + r.pendingValue, 0)],
    landscape: true,
  };
}

/** Ageing bucket label for a pending note line. */
export function ageBucket(days: number): '0–7 days' | '8–30 days' | '31–90 days' | 'Over 90 days' {
  if (days <= 7) return '0–7 days';
  if (days <= 30) return '8–30 days';
  if (days <= 90) return '31–90 days';
  return 'Over 90 days';
}

// ───────────────────────────── Budgets ─────────────────────────────

export const BASIS_LABEL: Record<BudgetBasis, string> = { net_transactions: 'On nett transactions', closing_balance: 'On closing balance' };
export const LINE_KIND_LABEL: Record<BudgetLineKind, string> = { group: 'Group', ledger: 'Ledger', cost_centre: 'Cost centre' };

export interface BudgetLineDraft {
  key: string;
  kind: BudgetLineKind;
  refId: number | null;
  name: string;
  basis: BudgetBasis;
  /** Signed paise (Dr + / Cr −). */
  amount: number | null;
}

/** Lines ready to save (incomplete rows dropped) and the first problem, if any (for the form). */
export function budgetLinesForSave(lines: readonly BudgetLineDraft[]): { lines: Array<{ kind: BudgetLineKind; refId: number; basis: BudgetBasis; amount: number }>; problem: { key: string; message: string } | null } {
  const out: Array<{ kind: BudgetLineKind; refId: number; basis: BudgetBasis; amount: number }> = [];
  const seen = new Map<string, string>();
  for (const l of lines) {
    if (l.refId === null && (l.amount === null || l.amount === 0)) continue;
    if (l.refId === null) return { lines: out, problem: { key: l.key, message: `Pick the ${LINE_KIND_LABEL[l.kind].toLowerCase()} for this line, or clear the amount.` } };
    if (l.amount === null || l.amount === 0) return { lines: out, problem: { key: l.key, message: `Enter the budget amount for ${l.name || 'this line'}.` } };
    const k = `${l.kind}:${l.refId}`;
    if (seen.has(k)) return { lines: out, problem: { key: l.key, message: `${l.name} is already on another line.` } };
    seen.set(k, l.key);
    out.push({ kind: l.kind, refId: l.refId, basis: l.basis, amount: l.amount });
  }
  return { lines: out, problem: null };
}

/** Variance text: "₹ 1,369.86 over (1.39%)" side-aware labels are the screen's job; this is the % text. */
export function variancePctText(r: Pick<BudgetVarianceRow, 'variancePct'>): string {
  if (r.variancePct === null) return '—';
  const v = r.variancePct;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
}

export function varianceExport(rows: readonly BudgetVarianceRow[]): ExportTable {
  return {
    columns: [
      { header: 'Particulars', width: 30 },
      { header: 'Type', width: 12 },
      { header: 'Basis', width: 20 },
      { header: 'Budget', kind: 'drcr', width: 18 },
      { header: 'Actual', kind: 'drcr', width: 18 },
      { header: 'Variance', kind: 'drcr', width: 18 },
      { header: 'Variance %', kind: 'percent', width: 10 },
    ],
    rows: rows.map((r) => [r.name, LINE_KIND_LABEL[r.kind], BASIS_LABEL[r.basis], r.budget, r.actual, r.variance, r.variancePct]),
    landscape: true,
  };
}

// ───────────────────────────── Recurring form ─────────────────────────────

/** Day-of-month choices: 1st … 31st, then "Last day of the month" (0). */
export const DAY_OF_MONTH_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  ...Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: `${ordinal(i + 1)}${i + 1 >= 29 ? ' (or the month end)' : ''}` })),
  { value: 0, label: 'Last day of the month' },
];

export interface ScheduleDraft {
  frequency: RecurringFrequency;
  intervalDays: number | null;
  dayOfMonth: number | null;
  startDate: string | null;
  endDate: string | null;
}

/** First problem of a schedule being edited (the core re-checks), keyed by its field. */
export function scheduleProblem(s: ScheduleDraft): { field: 'intervalDays' | 'startDate' | 'endDate'; message: string } | null {
  if (s.frequency === 'every_n_days' && (s.intervalDays === null || !Number.isInteger(s.intervalDays) || s.intervalDays < 1 || s.intervalDays > 366)) {
    return { field: 'intervalDays', message: 'Enter the number of days between postings (1 to 366).' };
  }
  if (!s.startDate) return { field: 'startDate', message: 'Enter the date of the first posting.' };
  if (s.endDate && s.endDate < s.startDate) return { field: 'endDate', message: 'The end date is before the start date. Choose a later date, or leave it blank.' };
  return null;
}

/** The schedule part of 'documents.recurring.save' (day of month only for month-based frequencies). */
export function scheduleInput(s: ScheduleDraft & { startDate: string }): RecurringSchedule {
  const out: RecurringSchedule = { frequency: s.frequency, startDate: s.startDate, endDate: s.endDate ?? null };
  if (s.frequency === 'every_n_days') out.intervalDays = s.intervalDays;
  else out.dayOfMonth = s.dayOfMonth;
  return out;
}

/**
 * The amount to send with a save: only when the user changed it, the voucher has a single amount and
 * the new value is positive. `undefined` keeps the template's lines as they are.
 */
export function amountToSend(original: number | null, edited: number | null, overridable: boolean): number | undefined {
  if (!overridable || edited === null || edited <= 0) return undefined;
  return edited === original ? undefined : edited;
}

/** Due rows still ticked for posting (everything is ticked until the user unticks it). */
export function selectedKeys(rows: readonly RecurringDueRow[], unticked: ReadonlySet<string>): Set<string> {
  return new Set(rows.filter((r) => !unticked.has(r.key)).map((r) => r.key));
}

// ───────────────────────────── Bills pending views ─────────────────────────────

export type BillsView = 'lines' | 'party' | 'item';

export interface BillsGroupRow {
  key: string;
  name: string;
  /** Distinct notes with an unbilled balance. */
  notes: number;
  lines: number;
  pendingValue: number;
  /** Age of the oldest unbilled line (days). */
  oldestDays: number;
  /** Pending value by ageing bucket. */
  buckets: Record<ReturnType<typeof ageBucket>, number>;
  /** Item view only: pending quantity and unit (one item, one unit). */
  pendingQty?: number;
  unit?: string;
}

export const AGE_BUCKETS: ReadonlyArray<ReturnType<typeof ageBucket>> = ['0–7 days', '8–30 days', '31–90 days', 'Over 90 days'];

/** Bills pending summarised per party or per item (largest pending value first). */
export function groupBills(rows: readonly BillsPendingRow[], by: 'party' | 'item'): BillsGroupRow[] {
  const map = new Map<string, BillsGroupRow & { noteIds: Set<number> }>();
  for (const r of rows) {
    const key = by === 'party' ? `p:${r.partyLedgerId ?? r.partyName}` : `i:${r.itemId}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        name: by === 'party' ? r.partyName : r.itemName,
        notes: 0,
        lines: 0,
        pendingValue: 0,
        oldestDays: 0,
        buckets: { '0–7 days': 0, '8–30 days': 0, '31–90 days': 0, 'Over 90 days': 0 },
        noteIds: new Set<number>(),
        ...(by === 'item' ? { pendingQty: 0, unit: r.unit } : {}),
      };
      map.set(key, g);
    }
    g.noteIds.add(r.noteId);
    g.lines += 1;
    g.pendingValue += r.pendingValue;
    g.oldestDays = Math.max(g.oldestDays, r.ageDays);
    g.buckets[ageBucket(r.ageDays)] += r.pendingValue;
    if (by === 'item') g.pendingQty = Math.round(((g.pendingQty ?? 0) + r.pendingQty) * 1e6) / 1e6;
  }
  return [...map.values()]
    .map(({ noteIds, ...g }) => ({ ...g, notes: noteIds.size }))
    .sort((a, b) => b.pendingValue - a.pendingValue || a.name.localeCompare(b.name));
}

export function billsGroupExport(rows: readonly BillsGroupRow[], by: 'party' | 'item', kind: BillsPendingKind): ExportTable {
  return {
    columns: [
      { header: by === 'party' ? BILLS_LABEL[kind].party : 'Item', width: 30 },
      ...(by === 'item' ? [{ header: 'Pending qty', width: 14 }] : []),
      { header: 'Notes', kind: 'number', width: 8 },
      ...AGE_BUCKETS.map((b): ExportColumn => ({ header: b, kind: 'amount', width: 14 })),
      { header: 'Pending value', kind: 'amount', width: 16 },
    ],
    rows: rows.map((g) => [
      g.name,
      ...(by === 'item' ? [formatQty(g.pendingQty ?? 0, 3, g.unit)] : []),
      g.notes,
      ...AGE_BUCKETS.map((b) => g.buckets[b]),
      g.pendingValue,
    ]),
    totals: [
      'Total',
      ...(by === 'item' ? [''] : []),
      null,
      ...AGE_BUCKETS.map((b) => rows.reduce((a, g) => a + g.buckets[b], 0)),
      rows.reduce((a, g) => a + g.pendingValue, 0),
    ],
    landscape: true,
  };
}

// ───────────────────────────── Scenarios ─────────────────────────────

/** Base types whose vouchers post no ledger entries (they can never change a report). */
export const NO_LEDGER_BASES: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>([
  'sales_order',
  'purchase_order',
  'delivery_note',
  'receipt_note',
  'rejection_in',
  'rejection_out',
  'stock_journal',
  'physical_stock',
  'quotation',
  'proforma',
]);

/** Provisional base types a scenario usually includes (Tally: memorandum, reversing journal, optional). */
export const PROVISIONAL_BASES: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>(['memorandum', 'reversing_journal']);

/** First problem of a scenario being edited (mirrors the core rules). */
export function scenarioProblem(s: { name: string; includeActuals: boolean; include: readonly number[]; exclude: readonly number[] }): { field: 'name' | 'includeTypeIds' | 'excludeTypeIds'; message: string } | null {
  if (!s.name.trim()) return { field: 'name', message: 'Give the scenario a name (e.g. "Provisional – with provisions").' };
  if (s.include.some((id) => s.exclude.includes(id))) return { field: 'excludeTypeIds', message: 'A voucher type cannot be both included and excluded.' };
  if (!s.includeActuals && s.exclude.length > 0) return { field: 'excludeTypeIds', message: 'Excluding voucher types only matters when actuals are included.' };
  if (!s.includeActuals && s.include.length === 0) return { field: 'includeTypeIds', message: 'Without actuals, include at least one voucher type — otherwise the reports would be empty.' };
  return null;
}

/** Toggle an id in a list (keeps order of first selection). */
export function toggleId(list: readonly number[], id: number): number[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

// ───────────────────────────── Order pre-close ─────────────────────────────

/** Quantity with only the decimals it needs (up to 3): "3 kg", "2.5 kg", "1.125 kg". */
export function qtyText(q: number, unit?: string): string {
  const r = Math.round(q * 1000) / 1000;
  const dp = Number.isInteger(r) ? 0 : Number.isInteger(r * 10) ? 1 : Number.isInteger(r * 100) ? 2 : 3;
  return formatQty(r, dp, unit);
}

export interface PrecloseLine {
  itemId: number;
  itemName: string;
  unit: string;
  pendingQty: number;
}

/** Pending quantity per item of one order (an item on several lines is summed), in first-line order. */
export function precloseLines(rows: ReadonlyArray<{ orderId: number; itemId: number; itemName: string; unit: string; pendingQty: number }>, orderId: number): PrecloseLine[] {
  const out = new Map<number, PrecloseLine>();
  for (const r of rows) {
    if (r.orderId !== orderId || r.pendingQty <= 0) continue;
    const l = out.get(r.itemId) ?? { itemId: r.itemId, itemName: r.itemName, unit: r.unit, pendingQty: 0 };
    l.pendingQty = Math.round((l.pendingQty + r.pendingQty) * 1e6) / 1e6;
    out.set(r.itemId, l);
  }
  return [...out.values()];
}

/**
 * The items to close: a quantity per item (default: the whole pending balance; 0 / blank = keep it
 * open). The whole balance is sent without `qty` (the core closes what is pending on the date).
 * `problem` names the first item asked to close more than is pending.
 */
export function precloseItems(lines: readonly PrecloseLine[], qty: Readonly<Record<number, number | null>>): { items: Array<{ itemId: number; qty?: number }>; problem: { itemId: number; message: string } | null } {
  const items: Array<{ itemId: number; qty?: number }> = [];
  for (const l of lines) {
    const q = l.itemId in qty ? qty[l.itemId] : l.pendingQty;
    if (q === null || q <= 0) continue;
    if (q > l.pendingQty + 1e-9) return { items, problem: { itemId: l.itemId, message: `Only ${qtyText(l.pendingQty, l.unit)} of ${l.itemName} is pending.` } };
    items.push(Math.abs(q - l.pendingQty) < 1e-9 ? { itemId: l.itemId } : { itemId: l.itemId, qty: q });
  }
  return { items, problem: null };
}

// ───────────────────────────── Budget variance drill-down ─────────────────────────────

/**
 * Where Enter on a variance row goes: a ledger → its Ledger Vouchers; a group → its Group Summary
 * (P&L basis for a net-transactions budget, so the summary's total is the "actual"; Trial-Balance
 * basis for a closing-balance budget); a cost centre → the Cost Centres report for the period.
 */
export function varianceDrill(r: Pick<BudgetVarianceRow, 'kind' | 'refId' | 'basis'>, from: string, to: string, scenarioId: number | null = null): { screen: string; params: Record<string, unknown> } {
  if (r.kind === 'ledger') return { screen: 'reports.ledger', params: { ledgerId: r.refId, from, to } };
  // Group Summary follows the scenario the variance was run under (so its total is the "actual" shown);
  // Ledger Vouchers and cost centres always show the books.
  if (r.kind === 'group') {
    return { screen: 'reports.groupSummary', params: { groupId: r.refId, from, to, basis: r.basis === 'net_transactions' ? 'profitLoss' : 'trialBalance', ...(scenarioId !== null ? { scenarioId } : {}) } };
  }
  return { screen: 'reports.costCentres', params: { from, to } };
}

/** Over / under / on budget, in words that do not depend on the Dr/Cr side. */
export function varianceStatus(r: Pick<BudgetVarianceRow, 'budget' | 'actual' | 'overBudget'>): { label: string; tone: BadgeTone } {
  if (r.budget === 0) return { label: r.actual === 0 ? 'No budget' : 'Not budgeted', tone: 'neutral' };
  if (r.actual === r.budget) return { label: 'On budget', tone: 'success' };
  return r.overBudget ? { label: 'Over budget', tone: 'warning' } : { label: 'Within budget', tone: 'info' };
}
