/**
 * GSTR-1 screen model (pure; see gstr1.test.ts): the table tiles shown on the summary, which
 * sections each tile opens, issue counts per tile and the export tables.
 *
 * Tiles follow the return's table numbers: 4A, 4B, 5, 6A, 6B, 6C, 7, 8, 9B, 11, 12, 13. Tables that
 * the core splits into several sections (6A WPAY/WOPAY, 6B SEWP/SEWOP, 9B CDNR/CDNUR, 11 advances
 * received/adjusted, 12 B2B/B2C) are combined into one tile with a tab per section.
 */
import type {
  GstIssue,
  Gstr1DocRow,
  Gstr1SectionId,
  Gstr1SectionResult,
  Gstr1SectionSummary,
  Gstr1Summary,
  TaxValue,
} from '../../../../shared/types/gst-returns.ts';
import type { TableExportDef } from '../../../app/export.ts';
import { hsnExport } from './reports.ts';

export type Gstr1TileId = '4A' | '4B' | '5' | '6A' | '6B' | '6C' | '7' | '8' | '9B' | '11' | '12' | '13';

export interface Gstr1TileDef {
  id: Gstr1TileId;
  title: string;
  /** One plain-language line under the title. */
  help: string;
  sections: readonly Gstr1SectionId[];
}

export const GSTR1_TILES: readonly Gstr1TileDef[] = [
  { id: '4A', title: 'B2B invoices', help: 'Sales to GST-registered buyers', sections: ['b2b'] },
  { id: '4B', title: 'B2B — reverse charge', help: 'Sales where the buyer pays the tax', sections: ['b2b_rcm'] },
  { id: '5', title: 'B2C large', help: 'Inter-state sales to consumers above the limit', sections: ['b2cl'] },
  { id: '6A', title: 'Exports', help: 'With and without payment of IGST', sections: ['exp_wp', 'exp_wop'] },
  { id: '6B', title: 'SEZ supplies', help: 'To SEZ units and developers', sections: ['sez_wp', 'sez_wop'] },
  { id: '6C', title: 'Deemed exports', help: 'Notified supplies treated as exports', sections: ['de'] },
  { id: '7', title: 'B2C others', help: 'Other consumer sales, by state and rate', sections: ['b2cs'] },
  { id: '8', title: 'Nil, exempt, non-GST', help: 'Supplies on which no GST is charged', sections: ['nil'] },
  { id: '9B', title: 'Credit / debit notes', help: 'Notes to registered and unregistered buyers', sections: ['cdnr', 'cdnur'] },
  { id: '11', title: 'Advances', help: 'Tax on advances received and adjusted', sections: ['at', 'atadj'] },
  { id: '12', title: 'HSN summary', help: 'Supplies by HSN/SAC code and rate', sections: ['hsn_b2b', 'hsn_b2c'] },
  { id: '13', title: 'Documents issued', help: 'Invoice and note number series', sections: ['doc'] },
];

/** Tab labels when a tile has several sections. */
export const SECTION_TAB_LABELS: Readonly<Record<Gstr1SectionId, string>> = {
  b2b: 'B2B',
  b2b_rcm: 'Reverse charge',
  b2cl: 'B2C large',
  exp_wp: 'With payment (WPAY)',
  exp_wop: 'Without payment (WOPAY)',
  sez_wp: 'With payment (SEWP)',
  sez_wop: 'Without payment (SEWOP)',
  de: 'Deemed exports',
  b2cs: 'B2C others',
  nil: 'Nil / exempt / non-GST',
  cdnr: 'Registered (CDNR)',
  cdnur: 'Unregistered (CDNUR)',
  at: 'Advances received',
  atadj: 'Advances adjusted',
  hsn_b2b: 'B2B',
  hsn_b2c: 'B2C',
  doc: 'Documents issued',
};

export function tileDef(id: string): Gstr1TileDef | null {
  return GSTR1_TILES.find((t) => t.id === id) ?? null;
}

export function tileOfSection(section: Gstr1SectionId): Gstr1TileId {
  const t = GSTR1_TILES.find((d) => d.sections.includes(section));
  return t ? t.id : '4A';
}

export interface Gstr1Tile extends TaxValue {
  id: Gstr1TileId;
  table: string;
  title: string;
  help: string;
  sections: readonly Gstr1SectionId[];
  count: number;
  countLabel: Gstr1SectionSummary['countLabel'];
  /** igst + cgst + sgst + cess. */
  tax: number;
  invoiceValue: number;
  errors: number;
  warnings: number;
  /** Nothing to report (no rows / documents and zero values). */
  empty: boolean;
  notes: string[];
}

export const taxOf = (t: { igst: number; cgst: number; sgst: number; cess: number }): number => t.igst + t.cgst + t.sgst + t.cess;

/** One tile per return table, values summed over its sections. */
export function buildTiles(summary: Gstr1Summary): Gstr1Tile[] {
  const byId = new Map(summary.sections.map((s) => [s.id, s]));
  return GSTR1_TILES.map((def) => {
    const secs = def.sections.map((id) => byId.get(id)).filter((s): s is Gstr1SectionSummary => !!s);
    const sum = (k: 'taxable' | 'igst' | 'cgst' | 'sgst' | 'cess' | 'count' | 'invoiceValue'): number => secs.reduce((a, s) => a + s[k], 0);
    const tileIssues = issuesForSections(summary.issues, def.sections);
    const errors = tileIssues.filter((i) => i.severity === 'error').length;
    const tile: Gstr1Tile = {
      id: def.id,
      table: def.id,
      title: def.title,
      help: def.help,
      sections: def.sections,
      count: sum('count'),
      countLabel: secs[0]?.countLabel ?? 'documents',
      taxable: sum('taxable'),
      igst: sum('igst'),
      cgst: sum('cgst'),
      sgst: sum('sgst'),
      cess: sum('cess'),
      tax: 0,
      invoiceValue: sum('invoiceValue'),
      errors,
      warnings: tileIssues.length - errors,
      empty: false,
      notes: secs.map((s) => s.note).filter((n): n is string => !!n),
    };
    tile.tax = taxOf(tile);
    tile.empty = tile.count === 0 && tile.taxable === 0 && tile.tax === 0;
    return tile;
  });
}

export function issuesForSections(issues: readonly GstIssue[], sections: readonly Gstr1SectionId[]): GstIssue[] {
  return issues.filter((i) => i.section !== null && sections.includes(i.section));
}

/** '3 documents', '1 row', '2 series'. */
export function countText(count: number, label: Gstr1SectionSummary['countLabel']): string {
  const unit = label === 'documents' ? 'document' : label === 'rows' ? 'row' : 'series';
  return `${count} ${unit}${count === 1 || unit === 'series' ? '' : 's'}`;
}

/** How a section's drill-down is laid out. */
export type SectionLayout = 'documents' | 'b2cs' | 'nil' | 'hsn' | 'doc' | 'advances';

export function sectionLayout(section: Gstr1SectionId): SectionLayout {
  switch (section) {
    case 'b2cs':
      return 'b2cs';
    case 'nil':
      return 'nil';
    case 'hsn_b2b':
    case 'hsn_b2c':
      return 'hsn';
    case 'doc':
      return 'doc';
    case 'at':
    case 'atadj':
      return 'advances';
    default:
      return 'documents';
  }
}

/** Document rows also listed for aggregate tables (the vouchers behind B2CS / nil / HSN rows). */
export function sectionHasDocuments(r: Gstr1SectionResult): boolean {
  return r.rows.length > 0;
}

/**
 * A document's invoice value with the row's sign, so the column adds up to the section total
 * (`Gstr1SectionResult.totals.invoiceValue` is signed; the row's `invoiceValue` is as on the document).
 */
export function signedInvoiceValue(r: Pick<Gstr1DocRow, 'invoiceValue' | 'sign'>): number {
  return r.sign * r.invoiceValue;
}

/** 'Credit note' / 'Debit note' / 'Invoice' for a document row. */
export function docKindLabel(r: Pick<Gstr1DocRow, 'noteType'>): string {
  return r.noteType === 'C' ? 'Credit note' : r.noteType === 'D' ? 'Debit note' : 'Invoice';
}

// ───────────────────────────── Export ─────────────────────────────

/** Excel / CSV / PDF table of the GSTR-1 summary (one row per tile plus the totals line). */
export function summaryExport(summary: Gstr1Summary): Omit<TableExportDef, 'title' | 'company' | 'period'> {
  const tiles = buildTiles(summary);
  return {
    subtitle: `Return period ${summary.period.label}${summary.gstin ? ` · GSTIN ${summary.gstin}` : ''}`,
    columns: [
      { header: 'Table' },
      { header: 'Description' },
      { header: 'Count', kind: 'number' },
      { header: 'Taxable value', kind: 'amount' },
      { header: 'IGST', kind: 'amount' },
      { header: 'CGST', kind: 'amount' },
      { header: 'SGST/UTGST', kind: 'amount' },
      { header: 'Cess', kind: 'amount' },
      { header: 'Total tax', kind: 'amount' },
    ],
    rows: tiles.map((t) => [t.table, t.title, t.count, t.taxable, t.igst, t.cgst, t.sgst, t.cess, t.tax]),
    totals: [
      '',
      'Tax on outward supplies (excl. 4B)',
      null,
      summary.totals.taxable,
      summary.totals.igst,
      summary.totals.cgst,
      summary.totals.sgst,
      summary.totals.cess,
      taxOf(summary.totals),
    ],
    landscape: true,
  };
}

type SectionExport = Omit<TableExportDef, 'company' | 'period'> & { period: string };

const sumBy = <T>(rows: readonly T[], f: (r: T) => number): number => rows.reduce((a, r) => a + f(r), 0);

/** Excel / CSV / PDF table of one GSTR-1 section drill-down (aggregate rows or documents), with totals. */
export function sectionExport(d: Gstr1SectionResult): SectionExport {
  const title = `GSTR-1 Table ${d.table} ${d.title}`;
  const period = d.period.label;
  const layout = sectionLayout(d.section);
  if (layout === 'hsn') {
    const rows = d.hsn ?? [];
    const totals = {
      taxable: sumBy(rows, (r) => r.taxable),
      igst: sumBy(rows, (r) => r.igst),
      cgst: sumBy(rows, (r) => r.cgst),
      sgst: sumBy(rows, (r) => r.sgst),
      cess: sumBy(rows, (r) => r.cess),
      total: sumBy(rows, (r) => r.total),
    };
    return { ...hsnExport(rows, totals), title, period };
  }
  if (layout === 'b2cs') {
    const rows = d.b2cs ?? [];
    return {
      title,
      period,
      columns: [
        { header: 'Place of supply' },
        { header: 'Supply' },
        { header: 'Rate', kind: 'percent' },
        { header: 'Documents', kind: 'number' },
        { header: 'Taxable value', kind: 'amount' },
        { header: 'IGST', kind: 'amount' },
        { header: 'CGST', kind: 'amount' },
        { header: 'SGST/UTGST', kind: 'amount' },
        { header: 'Cess', kind: 'amount' },
      ],
      rows: rows.map((r) => [`${r.pos}-${r.posName}`, r.supplyType === 'INTER' ? 'Inter-state' : 'Intra-state', r.rate, r.documents, r.taxable, r.igst, r.cgst, r.sgst, r.cess]),
      totals: [
        'Total',
        '',
        null,
        sumBy(rows, (r) => r.documents),
        sumBy(rows, (r) => r.taxable),
        sumBy(rows, (r) => r.igst),
        sumBy(rows, (r) => r.cgst),
        sumBy(rows, (r) => r.sgst),
        sumBy(rows, (r) => r.cess),
      ],
    };
  }
  if (layout === 'nil') {
    const rows = d.nil ?? [];
    return {
      title,
      period,
      columns: [{ header: 'Description' }, { header: 'Nil rated', kind: 'amount' }, { header: 'Exempted', kind: 'amount' }, { header: 'Non-GST', kind: 'amount' }],
      rows: rows.map((r) => [r.label, r.nil, r.exempt, r.nonGst]),
      totals: ['Total', sumBy(rows, (r) => r.nil), sumBy(rows, (r) => r.exempt), sumBy(rows, (r) => r.nonGst)],
    };
  }
  if (layout === 'doc') {
    const rows = d.docs ?? [];
    return {
      title,
      period,
      columns: [
        { header: 'Nature of document' },
        { header: 'Voucher type' },
        { header: 'From' },
        { header: 'To' },
        { header: 'Total', kind: 'number' },
        { header: 'Cancelled', kind: 'number' },
        { header: 'Net issued', kind: 'number' },
      ],
      rows: rows.map((r) => [r.docTypeLabel, r.voucherTypeName, r.from, r.to, r.total, r.cancelled, r.net]),
      totals: ['Total', '', '', '', sumBy(rows, (r) => r.total), sumBy(rows, (r) => r.cancelled), sumBy(rows, (r) => r.net)],
    };
  }
  return {
    title,
    period,
    subtitle: 'Credit notes and other documents that reduce the table are shown as negative amounts.',
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Number' },
      { header: 'Document' },
      { header: 'Party' },
      { header: 'GSTIN' },
      { header: 'Place of supply' },
      { header: 'Original invoice' },
      { header: 'Invoice value', kind: 'amount' },
      { header: 'Taxable value', kind: 'amount' },
      { header: 'IGST', kind: 'amount' },
      { header: 'CGST', kind: 'amount' },
      { header: 'SGST/UTGST', kind: 'amount' },
      { header: 'Cess', kind: 'amount' },
    ],
    rows: d.rows.map((r) => [
      r.date,
      r.number ?? '',
      docKindLabel(r),
      r.partyName ?? '',
      r.gstin ?? '',
      r.pos ? `${r.pos}-${r.posName}` : '',
      [r.originalInvoiceNo, r.originalInvoiceDate].filter(Boolean).join(' · '),
      signedInvoiceValue(r),
      r.taxable,
      r.igst,
      r.cgst,
      r.sgst,
      r.cess,
    ]),
    totals: ['Total', '', '', '', '', '', '', d.totals.invoiceValue, d.totals.taxable, d.totals.igst, d.totals.cgst, d.totals.sgst, d.totals.cess],
    landscape: true,
  };
}
