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
  return `bahi:${companyId}:recurring-notice:${date}`;
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

/**
 * Budget figure for a report row on a two-sided statement, made side-natural like the amounts there:
 * the left side of a P&L (expenses) and the right side of a Balance Sheet (assets) are Dr-natural; the
 * other sides Cr-natural. `byKey` values are Dr + / Cr −. null when the row has no budget.
 */
export function sideBudget(byKey: Readonly<Record<string, number>> | null, key: string, drNatural: boolean): number | null {
  if (!byKey) return null;
  const v = byKey[key];
  if (v === undefined) return null;
  return drNatural ? v : -v;
}
