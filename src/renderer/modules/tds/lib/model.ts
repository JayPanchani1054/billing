/**
 * TDS/TCS renderer logic — pure (tested in model.test.ts): labels, choices, form checks, export
 * tables and the override editing of a voucher's `tds` input.
 */
import { addDays, formatDate, formatMonth } from '../../../../shared/dates.ts';
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
  TdsLedgerDetails,
  TdsLedgerSaveInput,
  TdsLineStatus,
  TdsNature,
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
export function lineSummary(l: Pick<TdsVoucherLine, 'kind' | 'section' | 'status' | 'amount' | 'rate' | 'base'>): string {
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

// ───────────────────────────── Ledger TDS details ─────────────────────────────

/** Editable TDS/TCS details of one ledger (tds.ledger.form). */
export interface LedgerDraft {
  role: TdsLedgerDetails['role'];
  applicable: boolean;
  natureId: number | null;
  deducteeType: DeducteeType | null;
  nonResident: boolean;
  pan: string;
  hasCertificate: boolean;
  certNumber: string;
  certRate: number | null;
  certFrom: string | null;
  certTo: string | null;
  certLimit: Paise | null;
  certNatureId: number | null;
  deductorTan: string;
}

export function ledgerDraftOf(d: TdsLedgerDetails): LedgerDraft {
  const c = d.certificate;
  return {
    role: d.role,
    applicable: d.applicable,
    natureId: d.natureId,
    deducteeType: d.deducteeType,
    nonResident: d.nonResident,
    pan: d.pan ?? '',
    hasCertificate: c !== null,
    certNumber: c?.number ?? '',
    certRate: c?.rate ?? null,
    certFrom: c?.validFrom ?? null,
    certTo: c?.validTo ?? null,
    certLimit: c?.limit ?? null,
    certNatureId: c?.natureId ?? null,
    deductorTan: d.deductorTan ?? '',
  };
}

/** Field errors of the ledger details form, keyed like the core's issue paths. */
export function ledgerErrors(d: LedgerDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (d.role === 'party') {
    const p = panError(d.pan);
    if (p) e.pan = p;
    if (d.hasCertificate) {
      if (!d.certNumber.trim()) e['certificate.number'] = 'Enter the certificate number (from TRACES).';
      if (d.certRate === null) e['certificate.rate'] = 'Enter the rate on the certificate (0 for nil deduction).';
      if (!d.certFrom) e['certificate.validFrom'] = 'Enter the date the certificate is valid from.';
      if (!d.certTo) e['certificate.validTo'] = 'Enter the date the certificate is valid to.';
      else if (d.certFrom && d.certTo < d.certFrom) e['certificate.validTo'] = 'The certificate ends before it starts.';
    }
    const t = tanError(d.deductorTan);
    if (t) e.deductorTan = t;
  } else if (d.applicable && d.natureId === null) {
    e.natureId = d.role === 'income' ? 'Choose the nature of goods so TCS can be worked out on sales.' : 'Choose the nature of payment so TDS can be worked out.';
  }
  return e;
}

export function ledgerSaveInput(ledgerId: number, d: LedgerDraft): TdsLedgerSaveInput {
  if (d.role !== 'party') return { ledgerId, applicable: d.applicable, natureId: d.applicable ? d.natureId : null };
  const out: TdsLedgerSaveInput = {
    ledgerId,
    applicable: d.applicable,
    natureId: d.natureId,
    deducteeType: d.deducteeType,
    nonResident: d.nonResident,
    pan: d.pan.trim().toUpperCase() || null,
    deductorTan: d.deductorTan.trim().toUpperCase() || null,
    certificate: null,
  };
  if (d.hasCertificate && d.certFrom && d.certTo) {
    out.certificate = {
      number: d.certNumber.trim(),
      rate: d.certRate ?? 0,
      validFrom: d.certFrom,
      validTo: d.certTo,
      limit: d.certLimit && d.certLimit > 0 ? d.certLimit : null,
      natureId: d.certNatureId,
    };
  }
  return out;
}

/**
 * Nature choices of the ledger details form: the natures of the kind the ledger takes (expense → TDS,
 * sales → TCS, party → either) whose feature is on, active ones only — an inactive nature stays listed
 * only while the ledger still uses it (`keep`), so a saved choice never shows blank.
 */
export function natureOptionsFor(
  natures: readonly Pick<TdsNature, 'id' | 'kind' | 'section' | 'name' | 'isActive'>[],
  role: TdsLedgerDetails['role'] | undefined,
  f: Pick<CompanyFeatures, 'tds' | 'tcs'> | null | undefined,
  keep: ReadonlyArray<number | null>,
): Array<{ value: string; label: string }> {
  const kindWanted = role === 'income' ? 'tcs' : role === 'expense' ? 'tds' : null;
  return natures
    .filter((n) => kindWanted === null || n.kind === kindWanted)
    .filter((n) => (n.kind === 'tds' ? !!f?.tds : !!f?.tcs))
    .filter((n) => n.isActive || keep.includes(n.id))
    .map((n) => ({ value: String(n.id), label: `${n.kind === 'tcs' ? 'TCS ' : ''}${n.section} — ${n.name}${n.isActive ? '' : ' (inactive)'}` }));
}

/** Earliest filing date of a quarterly statement: the day after the quarter ends (the core refuses earlier). */
export function earliestFilingDate(quarterEnd: string): string {
  return addDays(quarterEnd, 1);
}

export const ROLE_LABEL: Readonly<Record<TdsLedgerDetails['role'], string>> = {
  party: 'Parties (deductees)',
  expense: 'Expenses & assets',
  income: 'Sales & income',
};

// ───────────────────────────── Quarterly statement ─────────────────────────────

export const QUARTER_LABEL: Readonly<Record<Quarter, string>> = { 1: 'Q1 Apr–Jun', 2: 'Q2 Jul–Sep', 3: 'Q3 Oct–Dec', 4: 'Q4 Jan–Mar' };

/** Short status line of a statement for the return screen header. */
export function statementStatusText(d: Pick<TdsReturnData, 'dueDate' | 'filedOn' | 'tokenNo' | 'lateFee' | 'daysLate'>): string {
  const due = `due ${formatDate(d.dueDate)}`;
  if (d.filedOn) {
    const token = d.tokenNo ? `, token ${d.tokenNo}` : '';
    return d.daysLate > 0 ? `Filed on ${formatDate(d.filedOn)}${token} — ${d.daysLate} day(s) late, fee u/s 234E ${money(d.lateFee)}` : `Filed on ${formatDate(d.filedOn)}${token} (${due})`;
  }
  return d.daysLate > 0 ? `Not filed — ${d.daysLate} day(s) past the due date, fee u/s 234E so far ${money(d.lateFee)}` : `Not filed yet (${due})`;
}

export function returnChallansExport(d: TdsReturnData): ExportTable {
  return {
    columns: [
      { header: 'Sr.', kind: 'number', width: 5 },
      { header: 'Section', width: 9 },
      { header: 'Month', width: 9 },
      { header: 'BSR code', width: 9 },
      { header: 'Deposited', kind: 'date' },
      { header: 'Challan no.', width: 9 },
      { header: 'Tax', kind: 'amount' },
      { header: 'Interest', kind: 'amount' },
      { header: 'Fee', kind: 'amount' },
      { header: 'Others', kind: 'amount' },
      { header: 'Total', kind: 'amount' },
      { header: 'Allocated', kind: 'amount' },
    ],
    rows: d.challans.map((c) => [c.sr, c.section, c.period, c.bsrCode, c.depositDate, c.challanNo, c.tax + c.surcharge + c.cess, c.interest, c.fee, c.others, c.total, c.allocated]),
    totals: ['Total', null, null, null, null, null, null, null, null, null, d.totals.challanTotal, null],
    landscape: true,
  };
}

export const EXCEPTION_LABEL: Readonly<Record<TdsExceptionRow['type'], string>> = {
  no_party: 'No party',
  no_pan: 'No PAN',
  invalid_pan: 'Invalid PAN',
  below_threshold_deducted: 'Deducted below threshold',
  not_deducted: 'Not deducted',
  short_deducted: 'Short deducted',
  threshold_not_deducted: 'Threshold crossed, not deducted',
};

// ───────────────────────────── Voucher entry: override dialog ─────────────────────────────

/** One editable line of the "TDS / TCS on this voucher" dialog. */
export interface OverrideEdit {
  natureId: number;
  /** Computed by the server (before any override). */
  computed: Paise;
  /** Amount the user wants (null = blank → treated as the computed amount). */
  amount: Paise | null;
  reason: string;
}

export function overrideEditsOf(lines: readonly TdsVoucherLine[], cur: VoucherTdsInput | null | undefined): OverrideEdit[] {
  return lines.map((l) => {
    const o = cur?.overrides?.find((x) => x.natureId === l.natureId);
    return { natureId: l.natureId, computed: l.computed, amount: o ? o.amount : l.computed, reason: o?.reason ?? '' };
  });
}

/** Errors by natureId: a changed amount needs a reason (it is audited and shown in the exceptions). */
export function overrideErrors(edits: readonly OverrideEdit[]): Record<number, string> {
  const e: Record<number, string> = {};
  for (const x of edits) {
    const amount = x.amount ?? x.computed;
    if (amount < 0) e[x.natureId] = 'The amount cannot be negative.';
    else if (amount !== x.computed && !x.reason.trim()) e[x.natureId] = 'Say why the amount differs from the computed one.';
  }
  return e;
}

/**
 * The voucher's `tds` input after the dialog: an amount equal to the computed one drops the override
 * (automatic again); overrides of natures no longer on the voucher are kept untouched.
 */
export function applyOverrideEdits(cur: VoucherTdsInput | null | undefined, edits: readonly OverrideEdit[], natureId: number | null | undefined): VoucherTdsInput | null {
  let next: VoucherTdsInput | null = cur ? { ...cur } : null;
  for (const x of edits) {
    const amount = x.amount ?? x.computed;
    next = withOverride(next, x.natureId, amount === x.computed ? null : amount, x.reason);
  }
  if (natureId !== undefined) next = withNature(next, natureId);
  return next;
}

// ───────────────────────────── Gateway notice ─────────────────────────────

/**
 * What the Gateway notice says about one kind's outstanding (null = nothing to say): overdue
 * deposits first, then deposits due within `soonDays`, then overdue quarterly statements.
 */
export function dueNoticeText(d: Pick<TdsOutstandingResult, 'kind' | 'rows' | 'statements' | 'asOf'>, soonDays = 7): { tone: 'danger' | 'warning'; text: string } | null {
  const k = KIND_LABEL[d.kind];
  const overdue = d.rows.filter((r) => r.status === 'overdue');
  if (overdue.length > 0) {
    const amount = overdue.reduce((a, r) => a + r.balance, 0);
    const interest = overdue.reduce((a, r) => a + Math.max(0, r.interest - r.interestPaid), 0);
    return { tone: 'danger', text: `${k} of ${money(amount)} is overdue (${overdue.length} month/section). Interest so far ${money(interest)} — deposit it with a challan.` };
  }
  const limit = addDays(d.asOf, soonDays);
  const soon = d.rows.filter((r) => r.status === 'due' && r.dueDate <= limit);
  if (soon.length > 0) {
    const amount = soon.reduce((a, r) => a + r.balance, 0);
    const first = soon.reduce((a, r) => (r.dueDate < a ? r.dueDate : a), soon[0].dueDate);
    return { tone: 'warning', text: `${k} of ${money(amount)} is due by ${formatDate(first)}.` };
  }
  const late = d.statements.filter((s) => s.status === 'overdue');
  if (late.length > 0) {
    const s = late[0];
    return { tone: 'danger', text: `Form ${s.form} for ${s.label} was due on ${formatDate(s.dueDate)} and is not marked filed (late fee u/s 234E so far ${money(late.reduce((a, x) => a + x.lateFee, 0))}).` };
  }
  return null;
}

