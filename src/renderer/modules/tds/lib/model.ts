/**
 * TDS/TCS renderer logic — pure (tested in model.test.ts): labels, choices, form checks, export
 * tables and the override editing of a voucher's `tds` input.
 */
import { formatDate, formatMonth } from '../../../../shared/dates.ts';
import { formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import { PAN_RE, quarterOf, TAN_RE, taxYearOf, type Quarter, type TdsForm } from '../../../../shared/tds/rules.ts';
import type {
  DeducteeType,
  PanStatus,
  TdsChallanRegister,
  TdsComputationResult,
  TdsExceptionRow,
  TdsKind,
  TdsLineStatus,
  TdsNatureRate,
  TdsOutstandingResult,
  TdsReceivableResult,
  TdsReturnData,
  TdsVoucherLine,
  VoucherTdsChallanInput,
  VoucherTdsInput,
} from '../../../../shared/types/tds.ts';
import type { CompanyFeatures } from '../../../../shared/settings.ts';
import type { VoucherBaseType } from '../../../../shared/constants.ts';

export const KIND_LABEL: Readonly<Record<TdsKind, string>> = { tds: 'TDS', tcs: 'TCS' };

export const DEDUCTEE_OPTIONS: ReadonlyArray<{ value: DeducteeType; label: string }> = [
  { value: 'company', label: 'Company' },
  { value: 'individual', label: 'Individual / HUF' },
  { value: 'firm', label: 'Firm / LLP' },
  { value: 'others', label: 'Others (AOP, BOI, trust, …)' },
];

export const STATUS_LABEL: Readonly<Record<TdsLineStatus, string>> = {
  deducted: 'Deducted',
  below_threshold: 'Below threshold',
  certificate: 'Lower / nil certificate',
  overridden_nil: 'Not deducted (changed)',
  no_party: 'No party',
};

export const PAN_LABEL: Readonly<Record<PanStatus, string>> = { valid: 'PAN valid', missing: 'No PAN', invalid: 'PAN invalid', not_applicable: '' };

/** Which kinds are on (F11) — the kinds a screen offers. */
export function enabledKinds(f: Pick<CompanyFeatures, 'tds' | 'tcs'> | null | undefined): TdsKind[] {
  const out: TdsKind[] = [];
  if (f?.tds) out.push('tds');
  if (f?.tcs) out.push('tcs');
  return out;
}

/** Kind a screen starts with: the requested one when it is on, else the first one on. */
export function initialKind(requested: TdsKind | undefined, f: Pick<CompanyFeatures, 'tds' | 'tcs'> | null | undefined): TdsKind | null {
  const on = enabledKinds(f);
  if (requested && on.includes(requested)) return requested;
  return on[0] ?? null;
}

/** Statement forms for a kind. */
export function formsFor(kind: TdsKind): TdsForm[] {
  return kind === 'tcs' ? ['27EQ'] : ['26Q', '27Q'];
}

/** Income-tax year + quarter a date falls in, and the quarters to offer (this year and the last two). */
export function quarterChoices(today: string): { fyStart: number; quarter: Quarter; years: number[] } {
  const fy = taxYearOf(today).startYear;
  return { fyStart: fy, quarter: quarterOf(today), years: [fy, fy - 1, fy - 2] };
}

export const fyLabel = (startYear: number): string => `${startYear}-${String(startYear + 1).slice(-2)}`;

/** Month choices for challans: the 18 months up to `today`, latest first ('YYYY-MM'). */
export function monthChoices(today: string, count = 18): Array<{ value: string; label: string }> {
  const [y0, m0] = today.split('-').map(Number);
  const out: Array<{ value: string; label: string }> = [];
  for (let i = 0; i < count; i++) {
    const t = y0 * 12 + (m0 - 1) - i;
    const y = Math.floor(t / 12);
    const m = (t % 12) + 1;
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push({ value: key, label: formatMonth(key) });
  }
  return out;
}

/** Previous month of a date ('YYYY-MM') — the month a challan usually pays for. */
export function previousMonth(today: string): string {
  const [y, m] = today.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// ───────────────────────────── Form checks ─────────────────────────────

export function panError(pan: string): string | undefined {
  const p = pan.trim().toUpperCase();
  if (p === '') return undefined;
  return PAN_RE.test(p) ? undefined : 'A PAN is 5 letters, 4 digits and a letter (e.g. AAAPA1234A); the 4th letter is the holder type (P, C, H, F, …).';
}

export function tanError(tan: string): string | undefined {
  const t = tan.trim().toUpperCase();
  if (t === '') return undefined;
  return TAN_RE.test(t) ? undefined : 'A TAN is 4 letters, 5 digits and a letter (e.g. MUMA12345B).';
}

export interface ChallanDraft {
  kind: TdsKind;
  section: string;
  period: string;
  date: string | null;
  depositDate: string | null;
  bankLedgerId: number | null;
  bsrCode: string;
  challanNo: string;
  minorHead: '200' | '400';
  tax: Paise | null;
  surcharge: Paise | null;
  cess: Paise | null;
  interest: Paise | null;
  fee: Paise | null;
  others: Paise | null;
}

export function challanErrors(d: ChallanDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.section) e.section = 'Choose the section the tax is paid for.';
  if (!/^\d{4}-\d{2}$/.test(d.period)) e.period = 'Choose the month of deduction.';
  if (!d.date) e.date = 'Enter the voucher date.';
  if (!d.depositDate) e.depositDate = 'Enter the date the tax was deposited (on the challan).';
  if (d.bankLedgerId === null) e.bankLedgerId = 'Choose the bank the tax was paid from.';
  if (!/^\d{7}$/.test(d.bsrCode.trim())) e.bsrCode = 'The BSR code has 7 digits (printed on the challan).';
  if (!/^\d{1,5}$/.test(d.challanNo.trim())) e.challanNo = 'The challan serial number has up to 5 digits.';
  const total = (d.tax ?? 0) + (d.surcharge ?? 0) + (d.cess ?? 0) + (d.interest ?? 0) + (d.fee ?? 0) + (d.others ?? 0);
  if (total <= 0) e.tax = 'Enter the tax (and any interest or fee) paid.';
  return e;
}

export function challanInput(d: ChallanDraft): VoucherTdsChallanInput {
  const out: VoucherTdsChallanInput = {
    kind: d.kind,
    section: d.section,
    period: d.period,
    bsrCode: d.bsrCode.trim(),
    challanNo: d.challanNo.trim(),
    depositDate: d.depositDate ?? '',
    minorHead: d.minorHead,
    tax: d.tax ?? 0,
  };
  if (d.surcharge) out.surcharge = d.surcharge;
  if (d.cess) out.cess = d.cess;
  if (d.interest) out.interest = d.interest;
  if (d.fee) out.fee = d.fee;
  if (d.others) out.others = d.others;
  return out;
}

export const challanTotal = (d: Pick<ChallanDraft, 'tax' | 'surcharge' | 'cess' | 'interest' | 'fee' | 'others'>): Paise =>
  (d.tax ?? 0) + (d.surcharge ?? 0) + (d.cess ?? 0) + (d.interest ?? 0) + (d.fee ?? 0) + (d.others ?? 0);

/** One editable rate row of the nature form (percent numbers, rupee thresholds as paise). */
export type RateDraft = Omit<TdsNatureRate, 'id'>;

export function blankRate(from: string): RateDraft {
  return {
    applicableFrom: from,
    rateIndividual: 0,
    rateCompany: 0,
    rateOthers: 0,
    rateNoPan: 20,
    thresholdSingle: null,
    thresholdAggregate: null,
    aggregatePeriod: 'fy',
    thresholdBasis: 'whole',
    baseIncludesGst: false,
    note: null,
  };
}

export function natureErrors(n: { name: string; section: string; rates: readonly RateDraft[] }): Record<string, string> {
  const e: Record<string, string> = {};
  if (!n.name.trim()) e.name = 'Enter the name, e.g. Payment to contractors.';
  if (!/^[0-9]{3}[A-Za-z0-9()]*$/.test(n.section.trim().replace(/\s+/g, ''))) e.section = 'Enter the section as in the Act, e.g. 194C, 194J(b), 206C(1F).';
  if (n.rates.length === 0) e.rates = 'Add at least one rate.';
  const seen = new Set<string>();
  n.rates.forEach((r, i) => {
    if (!r.applicableFrom) e[`rates[${i}].applicableFrom`] = 'Enter the date the rate applies from.';
    else if (seen.has(r.applicableFrom)) e[`rates[${i}].applicableFrom`] = `Two rates apply from ${formatDate(r.applicableFrom)}.`;
    seen.add(r.applicableFrom);
    if (r.thresholdBasis === 'excess' && r.thresholdAggregate === null) e[`rates[${i}].thresholdBasis`] = 'Tax on the excess needs a yearly threshold.';
  });
  return e;
}

// ───────────────────────────── Voucher entry: overrides ─────────────────────────────

/** Base types whose entry shows the TDS/TCS panel when the feature is on. */
export function tdsApplies(base: VoucherBaseType, f: Pick<CompanyFeatures, 'tds' | 'tcs'> | null | undefined): boolean {
  if (!f) return false;
  if (f.tds && (base === 'purchase' || base === 'journal' || base === 'payment')) return true;
  return !!f.tcs && base === 'sales';
}

/** Set (amount ≠ null) or remove the override of one nature. Empty result → undefined (automatic). */
export function withOverride(cur: VoucherTdsInput | null | undefined, natureId: number, amount: Paise | null, reason: string): VoucherTdsInput | null {
  const others = (cur?.overrides ?? []).filter((o) => o.natureId !== natureId);
  const overrides = amount === null ? others : [...others, { natureId, amount, reason: reason.trim() }];
  return compact({ ...cur, overrides });
}

export function withNature(cur: VoucherTdsInput | null | undefined, natureId: number | null): VoucherTdsInput | null {
  const next: VoucherTdsInput = { ...cur };
  if (natureId === null) delete next.natureId;
  else next.natureId = natureId;
  return compact(next);
}

function compact(t: VoucherTdsInput): VoucherTdsInput | null {
  const out: VoucherTdsInput = {};
  if (t.natureId !== undefined) out.natureId = t.natureId;
  if (t.overrides && t.overrides.length > 0) out.overrides = t.overrides;
  if (t.challan) out.challan = t.challan;
  return Object.keys(out).length > 0 ? out : null;
}

/** One-line summary of a computed line for the entry panel. */
export function lineSummary(l: TdsVoucherLine): string {
  const what = `${KIND_LABEL[l.kind]} u/s ${l.section}`;
  if (l.status === 'no_party') return `${what}: no party`;
  if (l.amount === 0) return `${what}: nil — ${STATUS_LABEL[l.status].toLowerCase()}`;
  return `${what} @ ${l.rate}% on ${money(l.base)}`;
}

const money = (p: Paise): string => formatMoney(p, { symbol: true });

// ───────────────────────────── Export tables ─────────────────────────────

type Cell = string | number | null;
interface ExportTable {
  columns: Array<{ header: string; kind?: 'text' | 'amount' | 'date' | 'number' | 'percent'; width?: number }>;
  rows: Cell[][];
  totals?: Cell[];
  notes?: string;
  landscape?: boolean;
}

export function computationExport(d: TdsComputationResult): ExportTable {
  return {
    columns: [
      { header: 'Party', width: 28 },
      { header: 'PAN', width: 12 },
      { header: 'Section', width: 10 },
      { header: 'Nature', width: 28 },
      { header: 'Lines', kind: 'number', width: 7 },
      { header: 'Credited / paid', kind: 'amount' },
      { header: 'Below threshold', kind: 'amount' },
      { header: 'Tax base', kind: 'amount' },
      { header: 'Deducted', kind: 'amount' },
      { header: 'Deposited', kind: 'amount' },
      { header: 'Balance', kind: 'amount' },
    ],
    rows: d.rows.map((r) => [r.partyName, r.pan ?? 'No PAN', r.section, r.natureName, r.count, r.credited, r.belowThreshold, r.base, r.deducted, r.deposited, r.balance]),
    totals: ['Total', null, null, null, d.totals.count, d.totals.credited, d.totals.belowThreshold, d.totals.base, d.totals.deducted, d.totals.deposited, d.totals.balance],
    landscape: true,
  };
}

export function outstandingExport(d: TdsOutstandingResult): ExportTable {
  return {
    columns: [
      { header: 'Month', width: 10 },
      { header: 'Section', width: 10 },
      { header: 'Deducted', kind: 'amount' },
      { header: 'Deposited', kind: 'amount' },
      { header: 'Balance', kind: 'amount' },
      { header: 'Due date', kind: 'date' },
      { header: 'Days overdue', kind: 'number' },
      { header: 'Interest', kind: 'amount' },
      { header: 'Interest paid', kind: 'amount' },
      { header: 'Status', width: 12 },
    ],
    rows: d.rows.map((r) => [r.periodLabel, r.section, r.deducted, r.deposited, r.balance, r.dueDate, r.daysOverdue, r.interest, r.interestPaid, OUTSTANDING_STATUS[r.status]]),
    totals: ['Total', null, d.totals.deducted, d.totals.deposited, d.totals.balance, null, null, d.totals.interest, d.totals.interestPaid, null],
    notes:
      `Interest: ${d.kind === 'tds' ? 's.201(1A)(ii) 1.5%' : 's.206C(7) 1%'} per month or part from the date of deduction to the date of payment, when paid after the due date. ` +
      `Late fee u/s 234E on statements: ${money(d.totals.lateFee)}.`,
    landscape: true,
  };
}

export const OUTSTANDING_STATUS: Readonly<Record<TdsOutstandingResult['rows'][number]['status'], string>> = {
  due: 'Due',
  overdue: 'Overdue',
  paid: 'Paid',
  paid_late: 'Paid late',
  excess: 'Excess paid',
  nothing_due: '—',
};

export function challansExport(d: TdsChallanRegister): ExportTable {
  return {
    columns: [
      { header: 'Deposited', kind: 'date' },
      { header: 'BSR code', width: 9 },
      { header: 'Challan no.', width: 9 },
      { header: 'Section', width: 9 },
      { header: 'Month', width: 10 },
      { header: 'Tax', kind: 'amount' },
      { header: 'Surcharge', kind: 'amount' },
      { header: 'Cess', kind: 'amount' },
      { header: 'Interest', kind: 'amount' },
      { header: 'Fee', kind: 'amount' },
      { header: 'Others', kind: 'amount' },
      { header: 'Total', kind: 'amount' },
      { header: 'Unconsumed', kind: 'amount' },
      { header: 'Voucher', width: 10 },
    ],
    rows: d.rows.map((r) => [r.depositDate, r.bsrCode, r.challanNo, r.section, r.periodLabel, r.tax, r.surcharge, r.cess, r.interest, r.fee, r.others, r.total, r.unconsumed, r.number ?? '']),
    totals: ['Total', null, null, null, null, d.totals.tax, d.totals.surcharge, d.totals.cess, d.totals.interest, d.totals.fee, d.totals.others, d.totals.total, d.totals.unconsumed, null],
    landscape: true,
  };
}

export function returnDeducteesExport(d: TdsReturnData): ExportTable {
  return {
    columns: [
      { header: 'Challan', kind: 'number', width: 7 },
      { header: 'Section', width: 9 },
      { header: 'Code', width: 5 },
      { header: 'PAN', width: 12 },
      { header: 'Name', width: 28 },
      { header: 'Paid / credited on', kind: 'date' },
      { header: 'Amount paid / credited', kind: 'amount' },
      { header: 'Tax', kind: 'amount' },
      { header: 'Deposited', kind: 'amount' },
      { header: 'Rate %', kind: 'percent' },
      { header: 'Reason', width: 6 },
    ],
    rows: d.deductees.map((x) => [x.challanSr, x.section, x.deducteeCode, x.pan, x.name, x.paymentDate, x.amountPaid, x.tax, x.deposited, x.rate, x.reasonCode]),
    totals: ['Total', null, null, null, null, null, d.totals.amountPaid, d.totals.tax, d.totals.deposited, null, null],
    notes: 'Reason: A = lower / nil deduction certificate (s.197), C = higher rate, no valid PAN.',
    landscape: true,
  };
}

export function exceptionsExport(rows: readonly TdsExceptionRow[]): ExportTable {
  return {
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Voucher', width: 14 },
      { header: 'Party', width: 24 },
      { header: 'Section', width: 9 },
      { header: 'Problem', width: 60 },
      { header: 'Shortfall', kind: 'amount' },
      { header: 'Interest', kind: 'amount' },
    ],
    rows: rows.map((r) => [r.date, `${r.typeName} ${r.number ?? ''}`.trim(), r.partyName ?? '', r.section, r.message, r.shortfall, r.interest]),
    landscape: true,
  };
}

export function receivableExport(d: TdsReceivableResult): ExportTable {
  return {
    columns: [
      { header: 'Customer / deductor', width: 30 },
      { header: 'TAN', width: 12 },
      { header: 'TDS in books', kind: 'amount' },
      { header: 'TDS in 26AS', kind: 'amount' },
      { header: 'Difference', kind: 'amount' },
      { header: 'Status', width: 14 },
    ],
    rows: d.rows.map((r) => [r.partyName, r.tan ?? '', r.books, r.form26as, r.difference, RECEIVABLE_STATUS[r.status]]),
    totals: ['Total', null, d.totals.books, d.totals.form26as, d.totals.difference, null],
  };
}

export const RECEIVABLE_STATUS: Readonly<Record<TdsReceivableResult['rows'][number]['status'], string>> = {
  matched: 'Matched',
  mismatch: 'Differs',
  books_only: 'Only in books',
  form26as_only: 'Only in 26AS',
};
