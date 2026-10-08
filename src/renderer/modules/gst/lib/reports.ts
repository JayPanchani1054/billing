/**
 * Export tables for the GST registers and analysis screens, and the wording of generated return /
 * bulk files (pure; see reports.test.ts). Amounts stay in paise (the export helpers format them).
 */
import type {
  GstBulkJsonFile,
  GstExceptionsResult,
  GstHsnRow,
  GstItcResult,
  GstRegisterResult,
  Gstr9Row,
  Gstr9Summary,
  TaxAmounts,
} from '../../../../shared/types/gst-returns.ts';
import type { TableExportDef } from '../../../app/lib/exportFormat.ts';
import { ISSUE_CODE_LABELS } from './issues.ts';

type ExportBody = Omit<TableExportDef, 'title' | 'company' | 'period'>;

const taxCols = [
  { header: 'IGST', kind: 'amount' as const },
  { header: 'CGST', kind: 'amount' as const },
  { header: 'SGST/UTGST', kind: 'amount' as const },
  { header: 'Cess', kind: 'amount' as const },
];
const taxCells = (t: TaxAmounts): number[] => [t.igst, t.cgst, t.sgst, t.cess];

export function registerExport(r: GstRegisterResult): ExportBody {
  const purchase = r.kind === 'purchase';
  return {
    subtitle: purchase ? 'Purchases and purchase returns (returns shown negative)' : 'Sales, credit notes and debit notes (credit notes shown negative)',
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Voucher no.' },
      { header: 'Voucher type' },
      ...(purchase ? [{ header: 'Supplier inv. no.' }, { header: 'Supplier inv. date', kind: 'date' as const }] : []),
      { header: purchase ? 'Supplier' : 'Party' },
      { header: 'GSTIN' },
      { header: purchase ? 'Supplier state' : 'Place of supply' },
      { header: 'Type' },
      { header: 'Taxable value', kind: 'amount' },
      ...taxCols,
      { header: 'Exempt / nil / non-GST', kind: 'amount' },
      { header: 'Invoice value', kind: 'amount' },
    ],
    rows: r.rows.map((x) => [
      x.date,
      x.number ?? '',
      x.voucherTypeName,
      ...(purchase ? [x.supplierInvoiceNo ?? '', x.supplierInvoiceDate ?? ''] : []),
      x.partyName ?? '',
      x.gstin ?? '',
      x.stateName ? `${x.stateCode}-${x.stateName}` : x.stateCode,
      x.reverseCharge ? `${x.natureLabel} (RCM)` : x.natureLabel,
      x.taxable,
      ...taxCells(x),
      x.nonTaxable,
      x.invoiceValue,
    ]),
    totals: ['Total', '', '', ...(purchase ? ['', ''] : []), '', '', '', '', r.totals.taxable, ...taxCells(r.totals), r.totals.nonTaxable, r.totals.invoiceValue],
    landscape: true,
  };
}

export function hsnExport(rows: readonly GstHsnRow[], totals?: { taxable: number; igst: number; cgst: number; sgst: number; cess: number; total: number }): ExportBody {
  return {
    columns: [
      { header: 'HSN/SAC' },
      { header: 'Description' },
      { header: 'UQC' },
      { header: 'Quantity', kind: 'qty', decimals: 3 },
      { header: 'Rate', kind: 'percent' },
      { header: 'Taxable value', kind: 'amount' },
      ...taxCols,
      { header: 'Total value', kind: 'amount' },
    ],
    rows: rows.map((h) => [h.hsn || '(missing)', h.description, h.uqc, h.qty, h.rate, h.taxable, ...taxCells(h), h.total]),
    totals: totals ? ['Total', '', '', null, null, totals.taxable, ...taxCells(totals), totals.total] : undefined,
    landscape: true,
  };
}

export function itcExport(r: GstItcResult): ExportBody {
  return {
    subtitle: 'Input tax credit by supplier (net of purchase returns)',
    columns: [
      { header: 'Supplier' },
      { header: 'GSTIN' },
      { header: 'Documents', kind: 'number' },
      { header: 'Taxable value', kind: 'amount' },
      { header: 'Eligible IGST', kind: 'amount' },
      { header: 'Eligible CGST', kind: 'amount' },
      { header: 'Eligible SGST', kind: 'amount' },
      { header: 'Eligible cess', kind: 'amount' },
      { header: 'Blocked (s.17(5))', kind: 'amount' },
      { header: 'Under reverse charge', kind: 'amount' },
      { header: 'On imports', kind: 'amount' },
    ],
    rows: r.rows.map((x) => [
      x.partyName,
      x.gstin ?? '',
      x.documents,
      x.taxable,
      ...taxCells(x.eligible),
      sumTax(x.ineligible),
      sumTax(x.reverseCharge),
      sumTax(x.imports),
    ]),
    totals: ['Total', '', null, r.totals.taxable, ...taxCells(r.totals.eligible), sumTax(r.totals.ineligible), sumTax(r.totals.reverseCharge), sumTax(r.totals.imports)],
    landscape: true,
  };
}

export const sumTax = (t: TaxAmounts): number => t.igst + t.cgst + t.sgst + t.cess;

export function exceptionsExport(r: GstExceptionsResult): ExportBody {
  return {
    subtitle: `${r.counts.errors} errors · ${r.counts.warnings} warnings`,
    columns: [
      { header: 'Severity' },
      { header: 'Problem' },
      { header: 'Date', kind: 'date' },
      { header: 'Voucher' },
      { header: 'Party' },
      { header: 'What is wrong', width: 50 },
      { header: 'How to fix it', width: 50 },
    ],
    rows: r.issues.map((i) => [
      i.severity === 'error' ? 'Error' : 'Warning',
      ISSUE_CODE_LABELS[i.code] ?? i.code,
      i.date ?? '',
      [i.voucherTypeName, i.voucherNumber].filter(Boolean).join(' '),
      i.partyName ?? '',
      i.message,
      i.fix,
    ]),
    landscape: true,
  };
}

/** GSTR-9 tables 4–6 and 9 as one table. */
export function gstr9Export(s: Gstr9Summary): ExportBody {
  const tv = (part: string, r: Gstr9Row) => [part, r.key, r.label, r.taxable, ...taxCells(r)];
  return {
    subtitle: `${s.caption} · FY ${s.fy}${s.gstin ? ` · GSTIN ${s.gstin}` : ''}`,
    columns: [{ header: 'Part' }, { header: 'Table' }, { header: 'Description', width: 50 }, { header: 'Taxable value', kind: 'amount' }, ...taxCols],
    rows: [
      ...s.table4.map((r) => tv('II', r)),
      ...s.table5.map((r) => tv('II', r)),
      ...s.table6.map((r) => tv('III', r)),
      ...s.table9.flatMap((p) => [
        ['IV', '9', `${p.label} — tax payable`, p.payable, null, null, null, null],
        ['IV', '9', `${p.label} — paid through ITC (by credit head)`, null, ...taxCells(p.paidItc)],
        ['IV', '9', `${p.label} — paid in cash`, p.paidCash, null, null, null, null],
      ]),
    ],
    notes: s.notes.join(' '),
    landscape: true,
  };
}

// ───────────────────────────── Generated files ─────────────────────────────

/** Toast line after saving a bulk file. */
export function bulkFileMessage(f: Pick<GstBulkJsonFile, 'documents' | 'rejected' | 'warnings'>): string {
  const docs = `${f.documents} document${f.documents === 1 ? '' : 's'} in the file`;
  const rej = f.rejected.length > 0 ? ` · ${f.rejected.length} left out (see the list)` : '';
  const warn = f.warnings.length > 0 ? ` · ${f.warnings.length} note${f.warnings.length === 1 ? '' : 's'}` : '';
  return `${docs}${rej}${warn}`;
}

