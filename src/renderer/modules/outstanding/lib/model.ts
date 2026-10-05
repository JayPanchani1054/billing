/**
 * Pure helpers for the outstanding screens (no React, no DOM — tested with node --test):
 * labels and tones, ageing-period text parsing, the party tree rows of 'outstanding.party', and the
 * export tables (Excel / CSV / generic print) of every outstanding report.
 *
 * Amounts are integer paise. Side reports are side-signed (positive = receivable / payable);
 * single-ledger results are Dr + / Cr −.
 */
import { formatMoney } from '../../../../shared/format.ts';
import type {
  AgeingResult,
  BillHistoryKind,
  InterestResult,
  LedgerBillsResult,
  OutstandingBillRow,
  OutstandingBillsResult,
  OutstandingRefType,
  OutstandingSide,
  PartySummaryResult,
  StatementResult,
} from '../../../../shared/types/outstanding.ts';
import type { ExportCell, ExportColumn } from '../../../app/lib/exportFormat.ts';

export type OutstandingView = 'parties' | 'bills' | 'ageing';

export const OUTSTANDING_VIEWS: ReadonlyArray<{ value: OutstandingView; label: string; key: string }> = [
  { value: 'parties', label: 'Parties', key: 'Ctrl+1' },
  { value: 'bills', label: 'Bills', key: 'Ctrl+2' },
  { value: 'ageing', label: 'Ageing', key: 'Ctrl+3' },
];

export interface SideText {
  /** Screen title. */
  title: string;
  /** 'Customer' / 'Supplier'. */
  party: string;
  parties: string;
  /** Column header for the side-signed amount. */
  amount: string;
  /** Screen id of this side and of the other one. */
  screen: string;
  otherScreen: string;
  otherTitle: string;
}

export const SIDE_TEXT: Readonly<Record<OutstandingSide, SideText>> = {
  receivable: {
    title: 'Receivables',
    party: 'Customer',
    parties: 'customers',
    amount: 'Receivable',
    screen: 'outstanding.receivables',
    otherScreen: 'outstanding.payables',
    otherTitle: 'Payables',
  },
  payable: {
    title: 'Payables',
    party: 'Supplier',
    parties: 'suppliers',
    amount: 'Payable',
    screen: 'outstanding.payables',
    otherScreen: 'outstanding.receivables',
    otherTitle: 'Receivables',
  },
};

const REF_LABELS: Readonly<Record<OutstandingRefType, string>> = {
  new: 'Bill',
  opening: 'Opening',
  advance: 'Advance',
  against: 'Against ref',
  on_account: 'On Account',
  fifo: 'FIFO',
};

export function refTypeLabel(t: OutstandingRefType): string {
  return REF_LABELS[t];
}

const HISTORY_LABELS: Readonly<Record<BillHistoryKind, string>> = {
  opening: 'Opening bill',
  new: 'New ref',
  against: 'Agst ref',
  advance: 'Advance',
  fifo: 'Debit/credit',
};

export function historyKindLabel(k: BillHistoryKind): string {
  return HISTORY_LABELS[k];
}

export type SeverityTone = 'neutral' | 'warning' | 'danger';

/** 0 → neutral (not overdue), 1–60 → warning, > 60 → danger. */
export function overdueTone(days: number): SeverityTone {
  return days <= 0 ? 'neutral' : days > 60 ? 'danger' : 'warning';
}

/** '45 days', '1 day', '' for not overdue. */
export function overdueText(days: number): string {
  if (days <= 0) return '';
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** Credit-limit bar tone: < 80% brand, 80–100% warning, > 100% danger. */
export function utilisationTone(pct: number | null): 'brand' | 'warning' | 'danger' {
  if (pct === null || pct < 80) return 'brand';
  return pct > 100 ? 'danger' : 'warning';
}

// ───────────────────────────── Ageing periods ─────────────────────────────

/** '30, 60, 90, 180' (commas, spaces or semicolons). */
export function bucketText(limits: readonly number[]): string {
  return limits.join(', ');
}

/**
 * Parse ageing periods typed by the user. Mirrors the server rule (1–12 increasing whole numbers of
 * days, each 1–3650) so mistakes are explained before the report runs.
 */
export function parseBucketText(text: string): { ok: true; buckets: number[] } | { ok: false; error: string } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return { ok: false, error: 'Enter the ageing periods in days, e.g. 30, 60, 90, 180' };
  if (parts.length > 12) return { ok: false, error: 'Enter at most 12 ageing periods' };
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return { ok: false, error: `“${p}” is not a whole number of days` };
    const n = Number(p);
    if (n < 1 || n > 3650) return { ok: false, error: 'Each ageing period must be from 1 to 3650 days' };
    if (out.length > 0 && n <= out[out.length - 1]) return { ok: false, error: 'Enter the periods in increasing order, e.g. 30, 60, 90, 180' };
    out.push(n);
  }
  return { ok: true, buckets: out };
}

// ───────────────────────────── Bills view ─────────────────────────────

export interface KeyedBillRow extends OutstandingBillRow {
  key: string;
}

/** Stable unique keys for bill rows (a party can have two FIFO slices with the same label). */
export function keyBills(rows: readonly OutstandingBillRow[]): KeyedBillRow[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.ledgerId}|${r.refType}|${r.voucherId ?? ''}|${r.billName}|${r.billDate ?? ''}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...r, key: n === 0 ? base : `${base}#${n}` };
  });
}

// ───────────────────────────── Party screen tree ─────────────────────────────

export interface PartyTreeRow {
  key: string;
  level: 0 | 1;
  isBill: boolean;
  /** Bill name (bill rows) or history label (history rows). */
  label: string;
  refType: OutstandingRefType | null;
  date: string | null;
  dueDate: string | null;
  voucherId: number | null;
  voucherNumber: string | null;
  voucherType: string | null;
  /** Signed (Dr +, Cr −): original amount (bills) or the line amount (history). */
  amount: number;
  /** Signed: pending (bills) or running pending after the line (history). */
  pending: number;
  overdueDays: number;
}

/** Bills with their history lines underneath (pre-order, for a tree DataTable). */
export function partyTreeRows(r: Pick<LedgerBillsResult, 'bills'>): PartyTreeRow[] {
  const out: PartyTreeRow[] = [];
  r.bills.forEach((b, bi) => {
    const key = `b${bi}|${b.billName}`;
    out.push({
      key,
      level: 0,
      isBill: true,
      label: b.billName,
      refType: b.refType,
      date: b.billDate,
      dueDate: b.dueDate,
      voucherId: b.voucherId,
      voucherNumber: null,
      voucherType: null,
      amount: b.originalAmount,
      pending: b.pendingAmount,
      overdueDays: b.overdueDays,
    });
    b.history.forEach((h, hi) => {
      out.push({
        key: `${key}|h${hi}`,
        level: 1,
        isBill: false,
        label: historyKindLabel(h.kind),
        refType: null,
        date: h.date,
        dueDate: null,
        voucherId: h.voucherId,
        voucherNumber: h.voucherNumber,
        voucherType: h.voucherType,
        amount: h.amount,
        pending: h.runningPending,
        overdueDays: 0,
      });
    });
  });
  return out;
}

// ───────────────────────────── Export tables ─────────────────────────────

export interface ExportTable {
  columns: ExportColumn[];
  rows: ExportCell[][];
  totals?: ExportCell[];
  subtitle?: string;
  landscape?: boolean;
}

/** Side-signed → ledger-signed (Dr +, Cr −) so reports show Dr/Cr instead of a bare minus. */
export function ledgerSign(side: OutstandingSide): 1 | -1 {
  return side === 'receivable' ? 1 : -1;
}

export function partiesExport(r: PartySummaryResult): ExportTable {
  const t = SIDE_TEXT[r.side];
  const s = ledgerSign(r.side);
  return {
    subtitle: `${t.title} — party-wise`,
    landscape: true,
    columns: [
      { header: t.party, width: 32 },
      { header: 'Group', width: 18 },
      { header: `Total ${t.amount.toLowerCase()}`, kind: 'drcr' },
      { header: 'Overdue', kind: 'drcr' },
      { header: 'Not due', kind: 'drcr' },
      { header: 'Advance', kind: 'drcr' },
      { header: 'On account', kind: 'drcr' },
      { header: 'Oldest overdue (days)', kind: 'number' },
      { header: 'Credit limit', kind: 'amount' },
      { header: 'Limit used', kind: 'percent', decimals: 0 },
    ],
    rows: r.rows.map((p) => [
      p.ledgerName,
      p.groupName,
      p.pending * s,
      p.overdue * s,
      p.notDue * s,
      p.advance * s,
      p.onAccount * s,
      p.oldestDueDays || null,
      p.creditLimit,
      p.utilisationPercent,
    ]),
    totals: ['Total', '', r.totals.pending * s, r.totals.overdue * s, r.totals.notDue * s, r.totals.advance * s, r.totals.onAccount * s, null, null, null],
  };
}

export function billsExport(r: OutstandingBillsResult): ExportTable {
  const t = SIDE_TEXT[r.side];
  const s = ledgerSign(r.side);
  return {
    subtitle: `${t.title} — bill-wise`,
    landscape: true,
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Bill no.', width: 16 },
      { header: t.party, width: 30 },
      { header: 'Type', width: 10 },
      { header: 'Due date', kind: 'date' },
      { header: 'Overdue (days)', kind: 'number' },
      { header: 'Bill amount', kind: 'drcr' },
      { header: 'Pending', kind: 'drcr' },
    ],
    rows: r.rows.map((b) => [b.billDate, b.billName, b.ledgerName, refTypeLabel(b.refType), b.dueDate, b.overdueDays || null, b.originalAmount * s, b.pendingAmount * s]),
    totals: ['', 'Total', '', '', '', null, null, r.totals.pending * s],
  };
}

export function ageingExport(r: AgeingResult): ExportTable {
  const t = SIDE_TEXT[r.side];
  const s = ledgerSign(r.side);
  return {
    subtitle: `${t.title} — ageing by ${r.basis === 'due_date' ? 'due date' : 'bill date'}`,
    landscape: true,
    columns: [
      { header: t.party, width: 30 },
      ...r.buckets.map((b): ExportColumn => ({ header: b.label, kind: 'drcr' })),
      { header: 'Advance', kind: 'drcr' },
      { header: 'On account', kind: 'drcr' },
      { header: 'Total', kind: 'drcr' },
    ],
    rows: r.rows.map((p) => [p.ledgerName, ...p.amounts.map((a) => a * s), p.advance * s, p.onAccount * s, p.total * s]),
    totals: ['Total', ...r.totals.amounts.map((a) => a * s), r.totals.advance * s, r.totals.onAccount * s, r.totals.total * s],
  };
}

export function interestExport(r: InterestResult): ExportTable {
  return {
    subtitle: `Simple interest, 365-day year, from the ${r.basis === 'due_date' ? 'due date' : 'bill date'}${r.graceDays ? ` + ${r.graceDays} grace days` : ''}`,
    landscape: true,
    columns: [
      { header: 'Party', width: 28 },
      { header: 'Bill no.', width: 14 },
      { header: 'Bill date', kind: 'date' },
      { header: 'Due date', kind: 'date' },
      { header: 'Interest from', kind: 'date' },
      { header: 'Principal', kind: 'amount' },
      { header: 'Rate %', kind: 'percent' },
      { header: 'Days', kind: 'number' },
      { header: 'Interest', kind: 'amount' },
      { header: 'Side', width: 10 },
    ],
    rows: r.rows.map((x) => [
      x.ledgerName,
      x.billName,
      x.billDate,
      x.dueDate,
      x.interestFrom,
      x.principal,
      x.ratePercent,
      x.days,
      x.interest,
      x.side === 'receivable' ? 'Receivable' : 'Payable',
    ]),
    totals: ['Total', '', '', '', '', null, null, null, r.totals.receivable + r.totals.payable, ''],
  };
}

/** Transactions of a statement as a table (Excel / CSV); the printed statement uses statementHtml. */
export function statementExport(s: StatementResult): ExportTable {
  return {
    subtitle: `Statement of account — ${s.party.name}`,
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Particulars', width: 28 },
      { header: 'Vch type', width: 14 },
      { header: 'Vch no.', width: 12 },
      { header: 'Debit', kind: 'amount' },
      { header: 'Credit', kind: 'amount' },
      { header: 'Balance', kind: 'drcr' },
    ],
    rows: [
      [s.from, 'Opening Balance', '', '', null, null, s.openingBalance],
      ...s.transactions.map((x): ExportCell[] => [x.date, x.particulars, x.voucherType, x.voucherNumber, x.debit || null, x.credit || null, x.balance]),
    ],
    totals: ['', 'Closing Balance', '', '', s.totals.debit, s.totals.credit, s.closingBalance],
  };
}

// ───────────────────────────── KPIs ─────────────────────────────

export interface Kpi {
  id: string;
  label: string;
  /** Paise (amount KPIs) or a count. */
  value: number;
  amount: boolean;
  caption: string;
}

export function summaryKpis(r: PartySummaryResult): Kpi[] {
  const t = r.totals;
  const unadjusted = t.advance + t.onAccount;
  const share = (part: number): string => (t.billsPending > 0 ? `${Math.round((part / t.billsPending) * 100)}% of bills` : '');
  return [
    { id: 'total', label: `Total ${SIDE_TEXT[r.side].amount.toLowerCase()}`, value: t.pending, amount: true, caption: `${t.partyCount} ${t.partyCount === 1 ? 'party' : 'parties'}` },
    { id: 'overdue', label: 'Overdue', value: t.overdue, amount: true, caption: share(t.overdue) },
    { id: 'notDue', label: 'Not yet due', value: t.notDue, amount: true, caption: share(t.notDue) },
    { id: 'unadjusted', label: 'Advances & on account', value: unadjusted, amount: true, caption: unadjusted === 0 ? 'Nothing unadjusted' : `Advances ${formatMoney(t.advance)} · On account ${formatMoney(t.onAccount)}` },
    { id: 'overLimit', label: 'Over credit limit', value: t.overLimitCount, amount: false, caption: t.overLimitCount === 0 ? 'All within limits' : `${t.overLimitCount === 1 ? 'party' : 'parties'} above their limit` },
  ];
}
