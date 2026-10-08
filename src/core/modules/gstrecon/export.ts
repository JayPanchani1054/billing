/**
 * Exports of a reconciliation: a multi-sheet Excel workbook (Summary, Matched, Partial with differences,
 * Missing in Books, Missing in Portal, Duplicates, Accepted & Ignored, Supplier-wise) or one CSV of every
 * row; and the plain-text follow-up e-mail for a supplier. Amounts are written in RUPEES (paise / 100).
 */
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { normalizeGstin } from '../../../shared/gst/index.ts';
import type {
  FieldDiff,
  ReconExportResult,
  ReconRow,
  ReconSource,
  ReconSummary,
  SupplierFollowUp,
  TaxHeads,
} from '../../../shared/types/gstrecon.ts';
import { MATCH_METHOD_LABELS, PORTAL_DOC_TYPE_LABELS, RECON_SOURCE_LABELS, RECON_STATUS_LABELS } from '../../../shared/types/gstrecon.ts';
import type { Db } from '../../db/db.ts';
import { toCsv, type CsvValue } from '../../lib/csv.ts';
import { validation } from '../../lib/errors.ts';
import { encodeUtf8WithBom } from '../../lib/text.ts';
import { writeXlsx, type XlsxCell, type XlsxColumn, type XlsxSheet } from '../../lib/xlsx.ts';
import { buildSummary, getSupplierSummary, periodRows, readPeriod } from './queries.ts';
import { companyInfo } from './store.ts';
import { periodLabel, periodShort } from './values.ts';

const rs = (p: number | null | undefined): number | null => (p === null || p === undefined ? null : p / 100);
const amt = (p: number | null | undefined): XlsxCell => ({ v: rs(p), kind: 'amount' });
const headsTotal = (h: TaxHeads): number => h.igst + h.cgst + h.sgst + h.cess;

function diffValue(d: FieldDiff, side: 'portal' | 'books'): string {
  const v = d[side];
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number' && ['taxable', 'igst', 'cgst', 'sgst', 'cess', 'invoice_value', 'itc'].includes(d.field)) return formatMoney(v);
  if (d.field === 'date' && typeof v === 'string') return formatDate(v, 'DD-MM-YYYY');
  if (d.field === 'doc_type' && typeof v === 'string') return PORTAL_DOC_TYPE_LABELS[v as keyof typeof PORTAL_DOC_TYPE_LABELS] ?? v;
  return String(v);
}

/** 'Taxable value: portal 10,000.00 / books 9,000.00; Document date: 05-04-2026 / 06-04-2026' */
export function diffText(diffs: readonly FieldDiff[], only: 'mismatch' | 'all' = 'all'): string {
  return diffs
    .filter((d) => only === 'all' || d.severity === 'mismatch')
    .map((d) => `${d.label}: portal ${diffValue(d, 'portal')} / books ${diffValue(d, 'books')}`)
    .join('; ');
}

interface ColumnDef {
  header: string;
  kind?: XlsxColumn['kind'];
  width?: number;
  cell: (r: ReconRow) => XlsxCell;
  csv: (r: ReconRow) => CsvValue;
}

const money = (pick: (r: ReconRow) => number | null | undefined): Pick<ColumnDef, 'kind' | 'cell' | 'csv'> => ({
  kind: 'amount',
  cell: (r) => amt(pick(r)),
  csv: (r) => rs(pick(r)),
});
const textCol = (header: string, pick: (r: ReconRow) => string | null | undefined, width?: number): ColumnDef => ({
  header,
  width,
  cell: (r) => pick(r) ?? '',
  csv: (r) => pick(r) ?? '',
});
const dateCol = (header: string, pick: (r: ReconRow) => string | null | undefined): ColumnDef => ({
  header,
  kind: 'date',
  width: 12,
  cell: (r) => ({ v: pick(r) ?? null, kind: 'date' }),
  csv: (r) => (pick(r) ? formatDate(pick(r), 'DD-MM-YYYY') : ''),
});

const COLS = {
  status: textCol('Status', (r) => RECON_STATUS_LABELS[r.status], 18),
  gstin: textCol('GSTIN', (r) => r.gstin, 17),
  name: textCol('Name', (r) => r.name, 28),
  docType: textCol('Type', (r) => PORTAL_DOC_TYPE_LABELS[r.docType], 11),
  portalNo: textCol('Doc no. (portal)', (r) => r.portal?.docNo, 18),
  portalDate: dateCol('Date (portal)', (r) => r.portal?.docDate),
  pos: textCol('POS', (r) => r.portal?.pos ?? r.books?.pos, 5),
  voucherNo: textCol('Voucher no.', (r) => (r.books ? `${r.books.voucherType} ${r.books.voucherNumber ?? ''}`.trim() : null), 16),
  booksNo: textCol('Doc no. (books)', (r) => r.books?.docNo, 18),
  booksDate: dateCol('Date (books)', (r) => r.books?.docDate),
  pTaxable: { header: 'Taxable (portal)', ...money((r) => r.portal?.taxable) },
  pIgst: { header: 'IGST (portal)', ...money((r) => r.portal?.igst) },
  pCgst: { header: 'CGST (portal)', ...money((r) => r.portal?.cgst) },
  pSgst: { header: 'SGST (portal)', ...money((r) => r.portal?.sgst) },
  pCess: { header: 'Cess (portal)', ...money((r) => r.portal?.cess) },
  pTax: { header: 'Tax (portal)', ...money((r) => r.portal?.tax) },
  bTaxable: { header: 'Taxable (books)', ...money((r) => r.books?.taxable) },
  bIgst: { header: 'IGST (books)', ...money((r) => r.books?.igst) },
  bCgst: { header: 'CGST (books)', ...money((r) => r.books?.cgst) },
  bSgst: { header: 'SGST (books)', ...money((r) => r.books?.sgst) },
  bCess: { header: 'Cess (books)', ...money((r) => r.books?.cess) },
  bTax: { header: 'Tax (books)', ...money((r) => r.books?.tax) },
  dTaxable: { header: 'Taxable diff.', ...money((r) => r.difference?.taxable) },
  dTax: { header: 'Tax diff.', ...money((r) => r.difference?.tax) },
  diffs: textCol('Differences', (r) => diffText(r.diffs), 60),
  method: textCol('Matched by', (r) => (r.method ? MATCH_METHOD_LABELS[r.method] : null), 20),
  itc: textCol('ITC available', (r) => (r.portal?.itcAvailable === null || r.portal === null ? null : r.portal.itcAvailable ? 'Yes' : 'No'), 10),
  reason: textCol('Reason', (r) => r.portal?.itcReason, 30),
  supplierPeriod: textCol('Supplier period', (r) => (r.portal?.supplierPeriod ? periodShort(r.portal.supplierPeriod) : null), 12),
  otherPeriod: textCol('Reported in', (r) => (r.otherPeriod ? periodShort(r.otherPeriod) : null), 12),
  suggestions: { header: 'Suggestions', kind: 'integer', cell: (r: ReconRow): XlsxCell => r.suggestionCount || null, csv: (r: ReconRow): CsvValue => r.suggestionCount } as ColumnDef,
  notes: textCol('Notes', (r) => r.notes.join(' '), 40),
  remarks: textCol('Remarks', (r) => r.remarks, 30),
} satisfies Record<string, ColumnDef>;

function sheet(name: string, cols: readonly ColumnDef[], rows: readonly ReconRow[], title: string[]): XlsxSheet {
  return {
    name,
    title,
    columns: cols.map((c) => ({ header: c.header, kind: c.kind, width: c.width })),
    rows: rows.map((r) => cols.map((c) => c.cell(r))),
    freezeHeader: true,
    autoFilter: rows.length > 0,
  };
}

function summarySheet(s: ReconSummary, title: string[], label: string): XlsxSheet {
  const head = (t: { count: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number; tax: number } | null, name: string, bold = false): XlsxCell[] =>
    t
      ? [{ v: name, bold }, t.count, amt(t.taxable), amt(t.igst), amt(t.cgst), amt(t.sgst), amt(t.cess), amt(t.tax)]
      : [{ v: name, bold }, null, null, null, null, null, null, null];
  const heads = (name: string, h: TaxHeads): XlsxCell[] => [name, null, null, amt(h.igst), amt(h.cgst), amt(h.sgst), amt(h.cess), amt(headsTotal(h))];
  const rows: XlsxCell[][] = [];
  for (const st of s.statuses) rows.push(head(st, st.label));
  rows.push([]);
  rows.push(head(s.portal, `As per ${label} (all documents)`, true));
  if (s.source === 'gstr2b') rows.push(head(s.portalItc, 'ITC available as per GSTR-2B', true));
  rows.push(head(s.books, s.source === 'gstr1' ? 'As per books (sales)' : 'As per books (purchases)', true));
  if (s.source !== 'gstr1') rows.push(head(s.booksItc, 'ITC as per books (eligible)', true));
  rows.push(
    s.difference
      ? [{ v: `Difference (${label} − books)`, bold: true }, null, amt(s.difference.taxable), amt(s.difference.igst), amt(s.difference.cgst), amt(s.difference.sgst), amt(s.difference.cess), amt(s.difference.tax)]
      : [{ v: 'Difference: run the reconciliation first', bold: true }],
  );
  rows.push([]);
  const inward = s.source !== 'gstr1';
  rows.push(heads(inward ? 'ITC at risk – not on the portal' : 'Tax in books not reported in GSTR-1', s.itcAtRisk.missingInPortal));
  rows.push(heads(inward ? 'ITC at risk – books higher than portal' : 'Books higher than GSTR-1', s.itcAtRisk.excessInBooks));
  if (inward) rows.push(heads(`ITC at risk – ITC not available as per ${label}`, s.itcAtRisk.itcNotAvailable));
  if (inward) rows.push(heads('ITC at risk – supplier credit notes not booked (reverse ITC)', s.itcAtRisk.creditNotesNotBooked));
  rows.push([{ v: inward ? 'Total ITC at risk' : 'Total books higher than GSTR-1', bold: true }, null, null, null, null, null, null, amt(s.itcAtRisk.total)]);
  rows.push(heads(inward ? 'ITC available but not booked – missing in books' : 'Reported in GSTR-1, not in books', s.itcNotBooked.missingInBooks));
  rows.push(heads(inward ? 'ITC available but not booked – books lower than portal' : 'GSTR-1 higher than books', s.itcNotBooked.shortInBooks));
  rows.push([{ v: inward ? 'Total ITC available but not booked' : 'Total GSTR-1 higher than books', bold: true }, null, null, null, null, null, null, amt(s.itcNotBooked.total)]);
  if (s.warnings.length > 0) {
    rows.push([]);
    for (const w of s.warnings) rows.push([w]);
  }
  return {
    name: 'Summary',
    title,
    columns: [
      { header: 'Particulars', width: 52 },
      { header: 'Documents', kind: 'integer', width: 10 },
      { header: 'Taxable value', kind: 'amount' },
      { header: 'IGST', kind: 'amount' },
      { header: 'CGST', kind: 'amount' },
      { header: 'SGST/UTGST', kind: 'amount' },
      { header: 'Cess', kind: 'amount' },
      { header: 'Total tax', kind: 'amount' },
    ],
    rows,
    freezeHeader: true,
  };
}

/** Build the export file. */
export function exportReconFile(db: Db, input: { period: string; source: ReconSource; format: 'xlsx' | 'csv' }): ReconExportResult {
  const rp = readPeriod(db, input.source, input.period);
  const summary = buildSummary(db, input.source, rp);
  const rows = periodRows(db, input.source, rp.key);
  const company = companyInfo(db);
  const label = RECON_SOURCE_LABELS[input.source];
  const base = `${label}_Reconciliation_${rp.key}`;
  const tol = summary.run?.tolerance;
  const title = [
    `${company.name}${company.gstin ? ` (GSTIN ${company.gstin})` : ''}`,
    `${label} vs books — ${summary.periodLabel}`,
    summary.run
      ? `Reconciled on ${summary.run.runAt.slice(0, 10)}; tolerance ₹ ${formatMoney(tol?.amountPaise ?? 100)} per head, ${tol?.dateDays ?? 0} day(s)${summary.stale ? ` — ${summary.staleReason}` : ''}`
      : 'Not reconciled yet',
  ];

  if (input.format === 'csv') {
    const cols = [
      COLS.status, COLS.gstin, COLS.name, COLS.docType, COLS.portalNo, COLS.portalDate, COLS.voucherNo, COLS.booksNo, COLS.booksDate,
      COLS.pTaxable, COLS.bTaxable, COLS.pIgst, COLS.bIgst, COLS.pCgst, COLS.bCgst, COLS.pSgst, COLS.bSgst, COLS.pCess, COLS.bCess,
      COLS.pTax, COLS.bTax, COLS.dTax, COLS.diffs, COLS.method, COLS.itc, COLS.otherPeriod, COLS.notes, COLS.remarks,
    ];
    const csv = toCsv([cols.map((c) => c.header), ...rows.map((r) => cols.map((c) => c.csv(r)))]);
    return { fileName: `${base}.csv`, bytes: encodeUtf8WithBom(csv) };
  }

  const by = (pred: (r: ReconRow) => boolean): ReconRow[] => rows.filter(pred);
  const matchedCols = [COLS.gstin, COLS.name, COLS.docType, COLS.portalNo, COLS.portalDate, COLS.voucherNo, COLS.booksNo, COLS.booksDate, COLS.pTaxable, COLS.pTax, COLS.bTaxable, COLS.bTax, COLS.dTax, COLS.method, COLS.diffs];
  const partialCols = [
    COLS.gstin, COLS.name, COLS.docType, COLS.portalNo, COLS.portalDate, COLS.voucherNo, COLS.booksNo, COLS.booksDate,
    COLS.pTaxable, COLS.bTaxable, COLS.dTaxable, COLS.pIgst, COLS.bIgst, COLS.pCgst, COLS.bCgst, COLS.pSgst, COLS.bSgst, COLS.pCess, COLS.bCess, COLS.dTax,
    COLS.diffs, COLS.notes,
  ];
  const portalCols = [COLS.gstin, COLS.name, COLS.docType, COLS.portalNo, COLS.portalDate, COLS.pos, COLS.pTaxable, COLS.pIgst, COLS.pCgst, COLS.pSgst, COLS.pCess, COLS.pTax, ...(input.source === 'gstr2b' ? [COLS.itc, COLS.reason] : []), COLS.supplierPeriod, COLS.suggestions, COLS.notes];
  const booksCols = [COLS.gstin, COLS.name, COLS.docType, COLS.voucherNo, COLS.booksNo, COLS.booksDate, COLS.bTaxable, COLS.bIgst, COLS.bCgst, COLS.bSgst, COLS.bCess, COLS.bTax, COLS.otherPeriod, COLS.suggestions, COLS.notes];
  const otherCols = [COLS.status, COLS.gstin, COLS.name, COLS.docType, COLS.portalNo, COLS.portalDate, COLS.voucherNo, COLS.booksNo, COLS.booksDate, COLS.pTax, COLS.bTax, COLS.dTax, COLS.diffs, COLS.notes, COLS.remarks];

  const suppliers = getSupplierSummary(db, { period: rp.key, source: input.source });
  const supplierSheet: XlsxSheet = {
    name: input.source === 'gstr1' ? 'Customer-wise' : 'Supplier-wise',
    title,
    columns: [
      { header: 'GSTIN', width: 17 },
      { header: 'Name', width: 30 },
      { header: 'Docs (portal)', kind: 'integer' },
      { header: 'Docs (books)', kind: 'integer' },
      { header: 'Matched', kind: 'integer' },
      { header: 'Partial', kind: 'integer' },
      { header: 'Missing in books', kind: 'integer' },
      { header: 'Missing in portal', kind: 'integer' },
      { header: 'Open', kind: 'integer' },
      { header: 'Taxable (portal)', kind: 'amount' },
      { header: 'Taxable (books)', kind: 'amount' },
      { header: 'Tax (portal)', kind: 'amount' },
      { header: 'Tax (books)', kind: 'amount' },
      { header: 'Tax diff.', kind: 'amount' },
    ],
    rows: suppliers.map((s) => [
      s.gstin || '(no GSTIN)',
      s.name ?? '',
      s.portalCount,
      s.booksCount,
      s.counts.matched ?? 0,
      s.counts.partial ?? 0,
      s.counts.missing_in_books ?? 0,
      s.counts.missing_in_portal ?? 0,
      s.openCount,
      amt(s.portalTaxable),
      amt(s.booksTaxable),
      amt(s.portalTax),
      amt(s.booksTax),
      amt(s.taxDifference),
    ]),
    freezeHeader: true,
    autoFilter: suppliers.length > 0,
  };

  const bytes = writeXlsx({
    creator: 'Bahi ERP',
    sheets: [
      summarySheet(summary, title, label),
      sheet('Matched', matchedCols, by((r) => r.status === 'matched'), title),
      sheet('Partial', partialCols, by((r) => r.status === 'partial'), title),
      sheet('Missing in Books', portalCols, by((r) => r.status === 'missing_in_books'), title),
      sheet('Missing in Portal', booksCols, by((r) => r.status === 'missing_in_portal'), title),
      sheet('Duplicates', otherCols, by((r) => r.status === 'duplicate'), title),
      sheet('Accepted & Ignored', otherCols, by((r) => r.status === 'accepted' || r.status === 'ignored'), title),
      supplierSheet,
    ],
  });
  return { fileName: `${base}.xlsx`, bytes };
}

// ───────────────────────────── Supplier follow-up ─────────────────────────────

const dmy = (iso: string | null | undefined): string => formatDate(iso, 'DD-MM-YYYY');
const inr = (p: number): string => `₹ ${formatMoney(p)}`;
const docWord = (r: ReconRow): string => PORTAL_DOC_TYPE_LABELS[r.docType];

/** Plain-text e-mail asking a supplier to fix what their GSTR-1 is missing or has wrong. */
export function buildSupplierFollowUp(db: Db, input: { period: string; supplierGstin: string; source?: ReconSource }): SupplierFollowUp {
  const source = input.source ?? 'gstr2b';
  if (source === 'gstr1') {
    throw validation([{ path: 'source', message: 'The follow-up e-mail is for suppliers. Choose GSTR-2B or GSTR-2A.' }]);
  }
  const rp = readPeriod(db, source, input.period);
  const gstin = normalizeGstin(input.supplierGstin);
  const rows = periodRows(db, source, rp.key).filter((r) => r.gstin === gstin);
  const company = companyInfo(db);
  const label = RECON_SOURCE_LABELS[source];
  const name = rows.map((r) => r.portal?.name ?? r.books?.partyName ?? null).find((n) => n) ?? null;
  // Reported by the supplier in another month: no need to report again, only mentioned for information.
  const missingInPortal = rows.filter((r) => r.status === 'missing_in_portal' && r.otherPeriod === null);
  const otherPeriod = rows.filter((r) => r.status === 'missing_in_portal' && r.otherPeriod !== null);
  // Only differences the supplier can correct (a voucher entered twice is ours to fix, not theirs).
  const supplierDiffs = (r: ReconRow): FieldDiff[] => r.diffs.filter((x) => x.severity === 'mismatch' && x.field !== 'books_period' && x.field !== 'gstin');
  const mismatched = rows.filter((r) => (r.status === 'partial' || r.status === 'duplicate') && r.portal !== null && r.books !== null && supplierDiffs(r).length > 0);
  const missingInBooks = rows.filter((r) => r.status === 'missing_in_books');
  // Reported again although an earlier/later return already carries it (same voucher matched there).
  const reportedTwice = rows.filter((r) => r.status === 'duplicate' && r.kind === 'portal' && r.books === null && r.otherPeriod !== null);
  const period = periodLabel(rp.key);

  const lines: string[] = [];
  lines.push(`Dear ${name ?? 'Sir/Madam'}${gstin ? ` (GSTIN ${gstin})` : ''},`);
  lines.push('');
  lines.push(
    `While reconciling our ${label} for ${period} with our purchase records, we found the following differences in documents issued by you to ${company.name}${company.gstin ? ` (GSTIN ${company.gstin})` : ''}.`,
  );
  let section = 0;
  const letter = (): string => String.fromCharCode(65 + section++);
  if (missingInPortal.length > 0) {
    lines.push('');
    lines.push(`${letter()}. Documents not appearing in our ${label} — please report them in your GSTR-1/IFF:`);
    missingInPortal.forEach((r, i) => {
      const b = r.books;
      if (!b) return;
      lines.push(`  ${i + 1}. ${docWord(r)} ${b.docNo} dated ${dmy(b.docDate)} — taxable value ${inr(b.taxable)}, tax ${inr(b.tax)}`);
    });
  }
  if (otherPeriod.length > 0) {
    lines.push('');
    lines.push(`${letter()}. Documents you reported in another month's return — no action needed unless the date or month is wrong:`);
    otherPeriod.forEach((r, i) => {
      const b = r.books;
      if (!b) return;
      lines.push(`  ${i + 1}. ${docWord(r)} ${b.docNo} dated ${dmy(b.docDate)} — reported in your return for ${periodLabel(r.otherPeriod as string)}`);
    });
  }
  if (mismatched.length > 0) {
    lines.push('');
    lines.push(`${letter()}. Documents reported with different details — please verify and amend:`);
    mismatched.forEach((r, i) => {
      const p = r.portal;
      if (!p) return;
      lines.push(`  ${i + 1}. ${docWord(r)} ${p.docNo} dated ${dmy(p.docDate)}:`);
      for (const d of supplierDiffs(r)) {
        lines.push(`       ${d.label}: as per our books ${diffValue(d, 'books')}, as per your return ${diffValue(d, 'portal')}`);
      }
    });
  }
  if (reportedTwice.length > 0) {
    lines.push('');
    lines.push(`${letter()}. Documents reported in more than one return — please check and remove the duplicate:`);
    reportedTwice.forEach((r, i) => {
      const p = r.portal;
      if (!p) return;
      lines.push(`  ${i + 1}. ${docWord(r)} ${p.docNo} dated ${dmy(p.docDate)} — also in your return for ${periodLabel(r.otherPeriod as string)}`);
    });
  }
  if (missingInBooks.length > 0) {
    lines.push('');
    lines.push(`${letter()}. Documents in your return that we could not find in our books — please send us a copy:`);
    missingInBooks.forEach((r, i) => {
      const p = r.portal;
      if (!p) return;
      lines.push(`  ${i + 1}. ${docWord(r)} ${p.docNo} dated ${dmy(p.docDate)} — taxable value ${inr(p.taxable)}, tax ${inr(p.tax)}`);
    });
  }
  const actionNeeded = missingInPortal.length + mismatched.length + reportedTwice.length + missingInBooks.length > 0;
  if (!actionNeeded) {
    lines.push('');
    lines.push(`${section === 0 ? 'All' : 'Otherwise, all'} your documents for this period match our records. Thank you.`);
  } else {
    lines.push('');
    lines.push('Kindly correct these in your next return so that we can claim the input tax credit, and confirm once done.');
  }
  lines.push('');
  lines.push('Regards,');
  lines.push(company.name);
  if (company.gstin) lines.push(`GSTIN ${company.gstin}`);

  return {
    gstin,
    name,
    subject: `GST reconciliation for ${period}: ${actionNeeded ? 'differences in your documents' : 'no differences'} — ${company.name}`,
    body: lines.join('\n'),
    counts: { missingInPortal: missingInPortal.length, mismatched: mismatched.length, missingInBooks: missingInBooks.length },
  };
}
