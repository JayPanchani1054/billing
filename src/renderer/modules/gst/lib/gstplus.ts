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
  GstFilingForm,
  GstSetoffResult,
  Gstr1AdvancesSummary,
  Gstr4Summary,
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
