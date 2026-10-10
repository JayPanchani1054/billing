/**
 * Pure helpers of the GST plus screens (set-off, electronic ledgers, composition returns, filing status,
 * amendments, advances, bills of entry) and of the voucher entry's GST details dialog (Alt+J).
 * Amounts stay in paise; export tables are formatted by the shared export path. Tests: gstplus.test.ts.
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import type {
  AdvanceVoucherRow,
  BoeReconRow,
  BoeRow,
  CashHeadAmount,
  CashMinorHead,
  Cmp08Summary,
  ElectronicCashLedger,
  ElectronicCreditLedger,
  GstAdjustmentNature,
  GstAmendmentRow,
  GstFiling,
  GstFilingForm,
  GstSetoffResult,
  Gstr1AdvancesSummary,
  Gstr4Summary,
  PendingAdvance,
  VoucherGstDetailsInput,
} from '../../../../shared/types/gst-plus.ts';
import { CASH_MINOR_HEADS, GST_ADJUSTMENT_LABELS } from '../../../../shared/types/gst-plus.ts';
import type { TaxAmounts, TaxHead } from '../../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../../shared/types/gst-returns.ts';
import type { TableExportDef } from '../../../app/lib/exportFormat.ts';

type ExportBody = Omit<TableExportDef, 'title' | 'company' | 'period'>;

export const HEAD_NAMES: Readonly<Record<TaxHead, string>> = { igst: 'IGST', cgst: 'CGST', sgst: 'SGST/UTGST', cess: 'Cess' };
export const MINOR_LABELS: Readonly<Record<CashMinorHead, string>> = { tax: 'Tax', interest: 'Interest', penalty: 'Penalty', fee: 'Fee', others: 'Others' };
export const FORM_LABELS: Readonly<Record<GstFilingForm, string>> = { gstr1: 'GSTR-1', gstr3b: 'GSTR-3B', cmp08: 'CMP-08', gstr4: 'GSTR-4' };

const taxCols = TAX_HEADS.map((h) => ({ header: HEAD_NAMES[h], kind: 'amount' as const }));
const taxCells = (t: TaxAmounts): number[] => [t.igst, t.cgst, t.sgst, t.cess];
export const taxSum = (t: TaxAmounts): number => t.igst + t.cgst + t.sgst + t.cess;

// ───────────────────────────── Challan defaults ─────────────────────────────

/**
 * Head-wise amounts to deposit for a set-off: what each minor head needs, less the cash already in the
 * electronic cash ledger for that major head (used against tax first, then interest, penalty, fee, others).
 */
/**
 * GST Set-off: the penalty / other amounts typed on the screen are only kept by posting the set-off,
 * so leaving with any typed (and nothing posted yet) asks first.
 */
export function setoffDirty(penalty: TaxAmounts, others: TaxAmounts, posted: unknown): boolean {
  if (posted !== null && posted !== undefined) return false;
  const any = (t: TaxAmounts): boolean => t.igst !== 0 || t.cgst !== 0 || t.sgst !== 0 || t.cess !== 0;
  return any(penalty) || any(others);
}

export function challanDefaults(s: Pick<GstSetoffResult, 'cash'>): CashHeadAmount[] {
  const out: CashHeadAmount[] = [];
  for (const row of s.cash) {
    let avail = Math.max(0, row.available);
    for (const m of CASH_MINOR_HEADS) {
      const need = row[m];
      const covered = Math.min(avail, need);
      avail -= covered;
      if (need - covered > 0) out.push({ head: row.head, minor: m, amount: need - covered });
    }
  }
  return out;
}

/** A complete head × minor grid (every combination, amount 0 when absent) for editing a challan. */
export function challanGrid(heads: readonly CashHeadAmount[]): Record<TaxHead, Record<CashMinorHead, number>> {
  const g = {} as Record<TaxHead, Record<CashMinorHead, number>>;
  for (const h of TAX_HEADS) {
    g[h] = { tax: 0, interest: 0, penalty: 0, fee: 0, others: 0 };
  }
  for (const x of heads) g[x.head][x.minor] += x.amount;
  return g;
}

export function gridToHeads(g: Record<TaxHead, Record<CashMinorHead, number>>): CashHeadAmount[] {
  const out: CashHeadAmount[] = [];
  for (const h of TAX_HEADS) for (const m of CASH_MINOR_HEADS) if (g[h][m] > 0) out.push({ head: h, minor: m, amount: g[h][m] });
  return out;
}

/** CPIN: 14 digits; CIN: 17 characters (CPIN + 4-character bank code). Empty → null (no error). */
export function challanFieldErrors(f: { cpin: string; cin: string }): { cpin?: string; cin?: string } {
  const e: { cpin?: string; cin?: string } = {};
  if (!f.cpin.trim()) e.cpin = 'Enter the CPIN printed on the challan (14 digits).';
  else if (!/^\d{14}$/.test(f.cpin.trim())) e.cpin = 'A CPIN has 14 digits — check the challan.';
  if (f.cin.trim() && !/^[A-Za-z0-9]{17}$/.test(f.cin.trim())) e.cin = 'A CIN has 17 characters (the CPIN and the bank code) — check the paid challan.';
  return e;
}

// ───────────────────────────── Voucher entry: GST details (Alt+J) ─────────────────────────────

export type GstDetailsKind = 'advance' | 'refund' | 'challan' | 'adjust' | 'boe' | 'adjustment';

/** Which GST details a voucher of this base type can carry (the dialog shows that section). */
export function gstDetailsKinds(baseType: VoucherBaseType, outward: boolean): GstDetailsKind[] {
  switch (baseType) {
    case 'receipt':
      return ['advance'];
    case 'payment':
      return ['refund', 'challan'];
    case 'sales':
    case 'credit_note':
      return baseType === 'sales' ? ['adjust'] : [];
    case 'debit_note':
      return outward ? ['adjust'] : [];
    case 'purchase':
      return ['boe'];
    case 'journal':
      return ['adjustment'];
    default:
      return [];
  }
}

/** Drop empty sections so an untouched dialog sends nothing. */
export function cleanGstDetails(d: VoucherGstDetailsInput | undefined): VoucherGstDetailsInput | undefined {
  if (!d) return undefined;
  const out: VoucherGstDetailsInput = {};
  if (d.advance) out.advance = d.advance;
  if (d.advanceRefund && d.advanceRefund.amount > 0) out.advanceRefund = d.advanceRefund;
  if (d.advanceAdjustments && d.advanceAdjustments.some((a) => a.amount > 0)) out.advanceAdjustments = d.advanceAdjustments.filter((a) => a.amount > 0);
  if (d.billOfEntry && d.billOfEntry.number.trim()) out.billOfEntry = d.billOfEntry;
  if (d.adjustment) out.adjustment = d.adjustment;
  if (d.challan) out.challan = d.challan;
  if (d.setoff) out.setoff = d.setoff;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One line shown on the voucher screen while GST details are set. */
export function gstDetailsSummary(d: VoucherGstDetailsInput | undefined): string | null {
  const c = cleanGstDetails(d);
  if (!c) return null;
  const parts: string[] = [];
  if (c.advance) parts.push(c.advance.supplyType === 'goods' ? 'Advance for goods (no tax)' : `Advance @ ${c.advance.rate}%`);
  if (c.advanceRefund) parts.push('Refund of advance');
  if (c.advanceAdjustments) parts.push(`${c.advanceAdjustments.length} advance(s) adjusted`);
  if (c.billOfEntry) parts.push(`Bill of entry ${c.billOfEntry.number}`);
  if (c.adjustment) parts.push(GST_ADJUSTMENT_LABELS[c.adjustment.nature]);
  if (c.challan) parts.push(`GST challan ${c.challan.cpin}`);
  if (c.setoff) parts.push(`GST set-off ${c.setoff.period}`);
  return parts.join(' · ');
}

export const ADJUSTMENT_OPTIONS: ReadonlyArray<{ value: GstAdjustmentNature; label: string }> = (Object.keys(GST_ADJUSTMENT_LABELS) as GstAdjustmentNature[]).map((k) => ({
  value: k,
  label: GST_ADJUSTMENT_LABELS[k],
}));

// ───────────────────────────── Exports ─────────────────────────────

export function setoffExport(s: GstSetoffResult): ExportBody {
  const rows: Array<Array<string | number>> = [];
  for (const c of s.credit) rows.push([`Credit ${HEAD_NAMES[c.from]} used for ${HEAD_NAMES[c.to]}`, c.amount, '', '', '', '', '']);
  for (const c of s.cash) rows.push([`Cash ${HEAD_NAMES[c.head]}`, c.tax, c.interest, c.penalty, c.fee, c.others, c.total]);
  return {
    subtitle: s.composition ? 'Composition (CMP-08): paid in cash' : 'GSTR-3B 6.1 — credit utilisation and cash',
    columns: [{ header: 'Particulars' }, { header: 'Tax', kind: 'amount' }, { header: 'Interest', kind: 'amount' }, { header: 'Penalty', kind: 'amount' }, { header: 'Fee', kind: 'amount' }, { header: 'Others', kind: 'amount' }, { header: 'Total', kind: 'amount' }],
    rows,
    totals: ['Cash total', '', '', '', '', '', s.cashTotal],
  };
}

export function cashLedgerExport(l: ElectronicCashLedger): ExportBody {
  return {
    subtitle: 'Electronic cash ledger (books): deposits by challan, utilisation by set-off',
    columns: [{ header: 'Major head' }, { header: 'Minor head' }, { header: 'Opening', kind: 'amount' }, { header: 'Deposited', kind: 'amount' }, { header: 'Utilised', kind: 'amount' }, { header: 'Closing', kind: 'amount' }],
    rows: l.rows.filter((r) => r.opening || r.deposited || r.utilised || r.closing).map((r) => [HEAD_NAMES[r.head], MINOR_LABELS[r.minor], r.opening, r.deposited, r.utilised, r.closing]),
    totals: ['Total', '', l.totals.opening, l.totals.deposited, l.totals.utilised, l.totals.closing],
  };
}

export function creditLedgerExport(l: ElectronicCreditLedger): ExportBody {
  const sum = (k: 'opening' | 'accrued' | 'reversed' | 'utilised' | 'closing'): number => l.rows.reduce((s, r) => s + r[k], 0);
  return {
    subtitle: 'Electronic credit ledger (books): Input tax ledgers',
    columns: [{ header: 'Head' }, { header: 'Opening', kind: 'amount' }, { header: 'ITC accrued', kind: 'amount' }, { header: 'Reversed', kind: 'amount' }, { header: 'Utilised', kind: 'amount' }, { header: 'Closing', kind: 'amount' }],
    rows: l.rows.map((r) => [r.label, r.opening, r.accrued, r.reversed, r.utilised, r.closing]),
    totals: ['Total', sum('opening'), sum('accrued'), sum('reversed'), sum('utilised'), sum('closing')],
  };
}

export function cmp08TableExport(s: Cmp08Summary): ExportBody {
  return {
    subtitle: `Table 3 — self-assessed liability (${s.category}, ${s.rate}%)`,
    columns: [{ header: 'Sl.' }, { header: 'Description' }, { header: 'Value', kind: 'amount' }, ...taxCols],
    rows: s.table3.map((r) => [r.row, r.label, r.taxable, ...taxCells(r)]),
  };
}

export function gstr4TableExport(s: Gstr4Summary): ExportBody {
  const rows: Array<Array<string | number>> = [];
  for (const r of s.table4) rows.push([r.key, r.gstin ?? (r.rate !== null ? `${r.rate}%` : ''), r.partyName ?? r.label, r.taxable, ...taxCells(r)]);
  for (const q of s.table5) rows.push(['5', q.quarter, q.label, q.taxable, ...taxCells(q)]);
  for (const r of s.table6) rows.push(['6', `${r.rate}%`, r.kind === 'outward' ? 'Outward (composition rate)' : 'Inward under reverse charge', r.taxable, ...taxCells(r)]);
  return {
    subtitle: s.caption,
    columns: [{ header: 'Table' }, { header: 'GSTIN / quarter / rate' }, { header: 'Particulars' }, { header: 'Value', kind: 'amount' }, ...taxCols],
    rows,
  };
}

export function amendmentsExport(rows: readonly GstAmendmentRow[]): ExportBody {
  return {
    subtitle: 'Documents changed or added after their GSTR-1 was filed',
    columns: [
      { header: 'Table' },
      { header: 'Original no.' },
      { header: 'Original date', kind: 'date' },
      { header: 'Filed in' },
      { header: 'Reported in' },
      { header: 'Δ Taxable', kind: 'amount' },
      ...taxCols.map((c) => ({ ...c, header: `Δ ${c.header}` })),
    ],
    rows: rows.map((r) => [r.table === 'late' ? 'Added' : r.table, r.origNumber ?? '', r.origDate, r.originalPeriod, r.amendPeriod, r.delta.taxable, ...taxCells(r.delta)]),
  };
}

export function advancesExport(a: Gstr1AdvancesSummary): ExportBody {
  const rows: Array<Array<string | number>> = [];
  for (const r of a.received) rows.push(['11A', `${r.pos}-${r.posName}`, r.supplyKind, `${r.rate}%`, r.gross, r.taxable, ...taxCells(r)]);
  for (const r of a.adjusted) rows.push(['11B', `${r.pos}-${r.posName}`, r.supplyKind, `${r.rate}%`, r.gross, r.taxable, ...taxCells(r)]);
  return {
    subtitle: 'GSTR-1 Table 11: advances received (11A) and adjusted / refunded (11B)',
    columns: [{ header: 'Table' }, { header: 'Place of supply' }, { header: 'Supply' }, { header: 'Rate' }, { header: 'Advance (gross)', kind: 'amount' }, { header: 'Taxable', kind: 'amount' }, ...taxCols],
    rows,
    totals: ['Net (11A − 11B)', '', '', '', '', a.net.taxable, ...taxCells(a.net)],
  };
}

export function advanceKindLabel(r: Pick<AdvanceVoucherRow, 'kind'>): string {
  return r.kind === 'received' ? 'Received' : r.kind === 'adjusted' ? 'Adjusted' : 'Refunded';
}

export function boeExport(rows: readonly BoeRow[]): ExportBody {
  return {
    subtitle: 'Bills of entry recorded on import purchases',
    columns: [
      { header: 'BOE no.' },
      { header: 'BOE date', kind: 'date' },
      { header: 'Port' },
      { header: 'Supplier' },
      { header: 'Assessable value', kind: 'amount' },
      { header: 'Customs duty', kind: 'amount' },
      { header: 'IGST', kind: 'amount' },
      { header: 'Cess', kind: 'amount' },
    ],
    rows: rows.map((r) => [r.boeNo, r.boeDate, r.portCode ?? '', r.supplier ?? '', r.assessableValue, r.customsDuty, r.igst, r.cess]),
  };
}

export const BOE_STATUS_LABELS: Readonly<Record<BoeReconRow['status'], string>> = {
  matched: 'Matched',
  mismatch: 'Mismatch',
  missing_in_books: 'Not in books',
  missing_in_portal: 'Not in GSTR-2B',
};

// ───────────────────────────── Quarters (composition) ─────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Quarter key ('2026-27-Q1') of a month key ('042026'). */
export function quarterOfMonthKey(monthKey: string): string | null {
  const m = /^(\d{2})(\d{4})$/.exec(monthKey);
  if (!m) return null;
  const month = Number(m[1]);
  const year = Number(m[2]);
  const start = month >= 4 ? year : year - 1;
  const q = Math.floor(((month - 4 + 12) % 12) / 3) + 1;
  return `${start}-${String(start + 1).slice(-2)}-Q${q}`;
}

export function quarterLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})-Q([1-4])$/.exec(key);
  if (!m) return key;
  const q = Number(m[3]);
  const first = (3 + (q - 1) * 3) % 12;
  return `Q${q} (${MONTHS[first]}–${MONTHS[(first + 2) % 12]}) ${m[1]}-${m[2]}`;
}

/** Quarters covering the given month keys, newest first. */
export function quartersFrom(monthKeys: readonly string[]): Array<{ value: string; label: string }> {
  const keys = [...new Set(monthKeys.map(quarterOfMonthKey).filter((k): k is string => k !== null))].sort().reverse();
  return keys.map((k) => ({ value: k, label: quarterLabel(k) }));
}

/** The quarter to open: the requested one, else the one before the working date's quarter (being filed now), else the newest. */
export function initialQuarter(options: ReadonlyArray<{ value: string }>, workingDate: string, requested?: string | null): string | null {
  if (requested && options.some((o) => o.value === requested)) return requested;
  const cur = quarterOfMonthKey(`${workingDate.slice(5, 7)}${workingDate.slice(0, 4)}`);
  const idx = options.findIndex((o) => o.value === cur);
  if (idx >= 0 && idx + 1 < options.length) return options[idx + 1].value;
  return options[0]?.value ?? null;
}

// ───────────────────────────── Electronic ledgers ─────────────────────────────

/** Closing balance of the cash ledger as a major × minor grid (one row per major head). */
export function cashLedgerMatrix(l: Pick<ElectronicCashLedger, 'rows'>): Array<{ head: TaxHead; closing: Record<CashMinorHead, number>; total: number }> {
  return TAX_HEADS.map((head) => {
    const closing: Record<CashMinorHead, number> = { tax: 0, interest: 0, penalty: 0, fee: 0, others: 0 };
    for (const r of l.rows) if (r.head === head) closing[r.minor] += r.closing;
    return { head, closing, total: CASH_MINOR_HEADS.reduce((s, m) => s + closing[m], 0) };
  });
}

/** IGST + CGST + SGST + cess of a ledger transaction. */
export function txnTotal(t: { igst: number; cgst: number; sgst: number; cess: number }): number {
  return t.igst + t.cgst + t.sgst + t.cess;
}

// ───────────────────────────── Composition rate form ─────────────────────────────

/** Inline errors of the composition rate dialog (the core validates again). */
export function rateFormErrors(f: { effectiveFrom: string | null; rate: number | null }): { effectiveFrom?: string; rate?: string } {
  const e: { effectiveFrom?: string; rate?: string } = {};
  if (!f.effectiveFrom) e.effectiveFrom = 'Enter the date from which the rate applies.';
  else if (f.effectiveFrom < '2017-07-01') e.effectiveFrom = 'GST (and the composition levy) started on 1 July 2017.';
  if (f.rate === null) e.rate = 'Enter the rate, e.g. 1 for 0.5% CGST + 0.5% SGST.';
  else if (f.rate <= 0 || f.rate > 28) e.rate = 'The rate must be more than 0% and at most 28%.';
  return e;
}

// ───────────────────────────── Filing status / amendments / pending advances / BOE recon ─────────────────────────────

/** Badge text of an amendment row's table. */
export function amendmentTableLabel(r: Pick<GstAmendmentRow, 'table' | 'original' | 'amended'>): string {
  if (r.table === 'late') return 'Added';
  const s = r.amended ?? r.original;
  const section = s?.section ? ` ${s.section.toUpperCase()}A` : '';
  return `${r.table}${r.table === '10' ? '' : section}`;
}

/** Screen that shows a filed return. */
export function filingRoute(f: Pick<GstFiling, 'form' | 'period'>): { screen: string; params: Record<string, unknown> } {
  switch (f.form) {
    case 'gstr1':
      return { screen: 'gst.gstr1', params: { period: f.period } };
    case 'gstr3b':
      return { screen: 'gst.gstr3b', params: { period: f.period } };
    case 'cmp08':
      return { screen: 'gst.cmp08', params: { period: f.period } };
    default:
      return { screen: 'gst.gstr4', params: { fy: f.period } };
  }
}

export function filingsExport(rows: readonly GstFiling[]): ExportBody {
  return {
    subtitle: 'Returns marked filed',
    columns: [{ header: 'Return' }, { header: 'Period' }, { header: 'Filed on', kind: 'date' }, { header: 'ARN' }],
    rows: rows.map((r) => [FORM_LABELS[r.form], r.periodLabel, r.filedOn, r.arn ?? '']),
  };
}

export function pendingAdvancesExport(rows: readonly PendingAdvance[]): ExportBody {
  return {
    subtitle: 'Advances received and not yet invoiced or refunded',
    columns: [{ header: 'Date', kind: 'date' }, { header: 'Receipt no.' }, { header: 'Party' }, { header: 'POS' }, { header: 'Rate' }, { header: 'Advance', kind: 'amount' }, { header: 'Pending', kind: 'amount' }],
    rows: rows.map((r) => [r.date, r.number ?? '', r.partyName ?? '', r.pos, `${r.rate}%`, r.gross, r.pending]),
    totals: ['Total', '', '', '', '', rows.reduce((s, r) => s + r.gross, 0), rows.reduce((s, r) => s + r.pending, 0)],
  };
}

export function boeReconExport(rows: readonly BoeReconRow[]): ExportBody {
  return {
    subtitle: 'Bills of entry in the books vs GSTR-2B (IMPG / IMPGSEZ)',
    columns: [
      { header: 'Status' },
      { header: 'BOE no.' },
      { header: 'BOE date', kind: 'date' },
      { header: 'Port' },
      { header: 'IGST (books)', kind: 'amount' },
      { header: 'IGST (2B)', kind: 'amount' },
      { header: 'IGST difference', kind: 'amount' },
      { header: 'Cess difference', kind: 'amount' },
      { header: 'Note' },
    ],
    rows: rows.map((r) => [BOE_STATUS_LABELS[r.status], r.boeNo, r.boeDate ?? '', r.portCode ?? '', r.books?.igst ?? 0, r.portal?.igst ?? 0, r.igstDiff, r.cessDiff, r.note ?? '']),
  };
}

/** Keep only the GST details a voucher of this base type can carry (e.g. after F10 changed the type). */
export function gstDetailsForBase(d: VoucherGstDetailsInput | undefined, baseType: VoucherBaseType): VoucherGstDetailsInput | undefined {
  const c = cleanGstDetails(d);
  if (!c) return undefined;
  const out: VoucherGstDetailsInput = {};
  if (baseType === 'receipt' && c.advance) out.advance = c.advance;
  if (baseType === 'payment') {
    if (c.advanceRefund) out.advanceRefund = c.advanceRefund;
    if (c.challan) out.challan = c.challan;
  }
  if ((baseType === 'sales' || baseType === 'debit_note') && c.advanceAdjustments) out.advanceAdjustments = c.advanceAdjustments;
  if (baseType === 'purchase' && c.billOfEntry) out.billOfEntry = c.billOfEntry;
  if (baseType === 'journal') {
    if (c.adjustment) out.adjustment = c.adjustment;
    if (c.setoff) out.setoff = c.setoff;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Return period typed in the GST details dialog (stat adjustment / challan): a month '092026' or a
 * quarter '2026-27-Q2' whose second year follows the first. Empty is allowed (the voucher date's period).
 */
export function periodKeyError(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  if (/^(0[1-9]|1[0-2])\d{4}$/.test(s)) return undefined;
  const q = /^(\d{4})-(\d{2})-Q[1-4]$/.exec(s);
  if (q && String(Number(q[1]) + 1).slice(-2) === q[2]) return undefined;
  return "Type a month as 092026 (MMYYYY) or a quarter as 2026-27-Q2.";
}

/** Inline errors of the bill of entry section (the gst voucher hook validates again). */
export function boeFieldErrors(f: { number: string; date: string | null; portCode: string; assessableValue: number | null; igst: number | null }): {
  number?: string;
  date?: string;
  portCode?: string;
  assessableValue?: string;
  igst?: string;
} {
  const e: { number?: string; date?: string; portCode?: string; assessableValue?: string; igst?: string } = {};
  if (!f.number.trim()) e.number = 'Enter the bill of entry number.';
  else if (!/^[A-Za-z0-9/-]{1,20}$/.test(f.number.trim())) e.number = 'Type the bill of entry number as printed (letters, digits, / or -).';
  if (!f.date) e.date = 'Enter the bill of entry date.';
  if (f.portCode.trim() && !/^[A-Za-z0-9]{6}$/.test(f.portCode.trim())) e.portCode = 'A port code has six characters, e.g. INNSA1.';
  if (f.assessableValue === null || f.assessableValue <= 0) e.assessableValue = 'Enter the assessable value shown on the BOE.';
  if (f.igst === null || f.igst < 0) e.igst = 'Enter the IGST paid at customs (0 if none).';
  return e;
}

// ───────────────────────────── Composition due dates (dashboard card) ─────────────────────────────

export interface CompositionDue {
  form: 'cmp08' | 'gstr4';
  /** Quarter key ('2026-27-Q1') or financial year ('2025-26'). */
  period: string;
  label: string;
  dueDate: string;
  filed: boolean;
  /** Not filed and the working date is after the due date. */
  overdue: boolean;
}

const QUARTER_DUE: ReadonlyArray<{ month: string; nextYear: boolean }> = [
  { month: '07', nextYear: false },
  { month: '10', nextYear: false },
  { month: '01', nextYear: true },
  { month: '04', nextYear: true },
];

/** CMP-08 due date (18th of the month after the quarter — Rule 62(1)(i)) of a quarter key. */
export function cmp08DueDate(quarterKey: string): string | null {
  const m = /^(\d{4})-\d{2}-Q([1-4])$/.exec(quarterKey);
  if (!m) return null;
  const start = Number(m[1]);
  const d = QUARTER_DUE[Number(m[2]) - 1];
  return `${d.nextYear ? start + 1 : start}-${d.month}-18`;
}

/**
 * What a composition taxpayer has to file around the working date: CMP-08 for the previous quarter
 * (and the current one, next), and GSTR-4 for the previous financial year (due 30 April, Rule 62(1)(ii)
 * as amended for FY 2021-22 onwards) until it is marked filed. Due dates are as notified; the government
 * sometimes extends them — the card says so.
 */
export function compositionDues(workingDate: string, filings: ReadonlyArray<{ form: string; period: string }>): CompositionDue[] {
  const isFiled = (form: string, period: string): boolean => filings.some((f) => f.form === form && f.period === period);
  const cur = quarterOfMonthKey(`${workingDate.slice(5, 7)}${workingDate.slice(0, 4)}`);
  if (!cur) return [];
  const m = /^(\d{4})-\d{2}-Q([1-4])$/.exec(cur);
  if (!m) return [];
  const start = Number(m[1]);
  const q = Number(m[2]);
  const key = (s: number, n: number): string => `${s}-${String(s + 1).slice(-2)}-Q${n}`;
  const prev = q === 1 ? key(start - 1, 4) : key(start, q - 1);
  const out: CompositionDue[] = [];
  for (const period of [prev, cur]) {
    const dueDate = cmp08DueDate(period) as string;
    const filed = isFiled('cmp08', period);
    if (period === cur && filed) continue;
    out.push({ form: 'cmp08', period, label: `CMP-08 ${quarterLabel(period)}`, dueDate, filed, overdue: !filed && workingDate > dueDate });
  }
  const prevFy = `${start - 1}-${String(start).slice(-2)}`;
  if (!isFiled('gstr4', prevFy)) {
    const dueDate = `${start}-04-30`;
    out.push({ form: 'gstr4', period: prevFy, label: `GSTR-4 FY ${prevFy}`, dueDate, filed: false, overdue: workingDate > dueDate });
  }
  return out;
}
