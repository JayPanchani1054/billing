/**
 * Generic table export for every report/list in the shell ('data.export.table'): rows arrive the way
 * the renderer displays them (amounts in PAISE, drcr signed paise, percent as 18 for 18%, ISO dates)
 * and leave as an .xlsx (real numbers, Indian number formats, rupees) or a formula-safe CSV.
 *
 *  - amount → rupees with the Indian amount format; drcr → an amount column (magnitude) followed by a
 *    narrow "Dr/Cr" text column in Excel, a single signed column ("… (Dr +/Cr -)") in CSV.
 *  - percent → Excel percentage (18 → 18.00%); CSV keeps 18.00.
 *  - text cells starting with = + - @ TAB CR are neutralised in CSV; Excel text is always a shared string.
 */
import { formatDate } from '../../../shared/dates.ts';
import type { ExportAuditInput, ExportAuditResult, ExportColumnKind, ExportFileResult, ExportTableCell, ExportTableColumn, ExportTableInput } from '../../../shared/types/data.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { neutraliseFormula, toCsv } from '../../lib/csv.ts';
import { encodeUtf8WithBom } from '../../lib/text.ts';
import { writeXlsx, type XlsxCell, type XlsxColumn, type XlsxKind } from '../../lib/xlsx.ts';
import { fileSlug, requirePermission } from './common.ts';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv';
export const ZIP_MIME = 'application/zip';

const XLSX_KIND: Record<ExportColumnKind, XlsxKind> = {
  text: 'text',
  number: 'number',
  amount: 'amount',
  date: 'date',
  percent: 'percent',
  integer: 'integer',
  drcr: 'amount',
  qty: 'number',
};

export function periodText(period: ExportTableInput['period']): string {
  if (!period) return '';
  if (typeof period === 'string') return period;
  return `${formatDate(period.from)} to ${formatDate(period.to)}`;
}

export function exportFileName(title: string, period: ExportTableInput['period'], ext: string): string {
  const p = period && typeof period !== 'string' ? `_${formatDate(period.from, 'DD-MM-YYYY')}_to_${formatDate(period.to, 'DD-MM-YYYY')}` : '';
  return `${fileSlug(title)}${p}.${ext}`;
}

/** Exact rupees text from integer paise ('-1234.50'). */
export function paiseText(p: number): string {
  const abs = Math.abs(Math.round(p));
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return p < 0 && abs !== 0 ? `-${text}` : text;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const asText = (v: ExportTableCell): XlsxCell => (v === null || v === '' ? null : { v: typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v), kind: 'text' });

function xlsxCells(col: ExportTableColumn, v: ExportTableCell, bold: boolean): XlsxCell[] {
  const kind = col.kind ?? 'text';
  const wrap = (c: XlsxCell): XlsxCell => (bold && c !== null && c !== undefined ? (typeof c === 'object' ? { ...c, bold: true } : { v: c, bold: true }) : c);
  if (kind === 'drcr') {
    if (!isNum(v)) return [wrap(asText(v)), null];
    return [wrap({ v: Math.abs(v) / 100, kind: 'amount' }), wrap({ v: v > 0 ? 'Dr' : v < 0 ? 'Cr' : '', kind: 'text' })];
  }
  if (typeof v === 'boolean') return [wrap({ v: v ? 'Yes' : 'No', kind: 'text' })];
  switch (kind) {
    case 'amount':
      return [wrap(isNum(v) ? { v: v / 100, kind: 'amount' } : asText(v))];
    case 'percent':
      return [wrap(isNum(v) ? { v: v / 100, kind: 'percent' } : asText(v))];
    case 'number':
    case 'qty':
    case 'integer':
      return [wrap(isNum(v) ? { v, kind: XLSX_KIND[kind] } : asText(v))];
    case 'date':
      return [wrap(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? { v, kind: 'date' } : asText(v))];
    default:
      return [wrap(asText(v))];
  }
}

function csvCell(col: ExportTableColumn, v: ExportTableCell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const kind = col.kind ?? 'text';
  if (isNum(v)) {
    switch (kind) {
      case 'amount':
      case 'drcr':
        return paiseText(v);
      case 'qty':
      case 'percent':
        return v.toFixed(col.decimals ?? 2);
      case 'number':
        return v.toFixed(col.decimals ?? 0);
      case 'integer':
        return String(Math.round(v));
      default:
        return String(v);
    }
  }
  // Any text (also text inside a numeric column) is neutralised against formula injection.
  return neutraliseFormula(String(v));
}

function buildCsv(input: ExportTableInput): string {
  const header = input.columns.map((col) => neutraliseFormula(col.kind === 'drcr' ? `${col.header} (Dr +/Cr -)` : col.header));
  const lines: string[][] = [header];
  for (const row of input.rows) lines.push(input.columns.map((col, i) => csvCell(col, row[i] ?? null)));
  if (input.totals) lines.push(input.columns.map((col, i) => csvCell(col, input.totals?.[i] ?? null)));
  // Cells are already neutralised/formatted above, so toCsv only quotes.
  return toCsv(lines, { neutraliseFormulas: false });
}

function buildXlsx(input: ExportTableInput, companyName: string): Uint8Array {
  const columns: XlsxColumn[] = [];
  for (const col of input.columns) {
    const kind = col.kind ?? 'text';
    columns.push({ header: col.header, kind: XLSX_KIND[kind], width: col.width });
    if (kind === 'drcr') columns.push({ header: 'Dr/Cr', kind: 'text', width: 6 });
  }
  const levels = input.levels ?? [];
  const toRow = (row: readonly ExportTableCell[], bold: boolean, level: number): XlsxCell[] => {
    const out: XlsxCell[] = [];
    input.columns.forEach((col, i) => {
      const cells = xlsxCells(col, row[i] ?? null, bold);
      if (i === 0 && level > 0 && cells[0] !== null && cells[0] !== undefined) {
        const c0 = cells[0];
        cells[0] = typeof c0 === 'object' ? { ...c0, indent: Math.min(15, level) } : { v: c0, indent: Math.min(15, level) };
      }
      out.push(...cells);
    });
    return out;
  };
  const rows: XlsxCell[][] = input.rows.map((r, i) => toRow(r, false, levels[i] ?? 0));
  if (input.totals) rows.push(toRow(input.totals, true, 0));
  if (input.notes) {
    rows.push([]);
    rows.push([{ v: input.notes, kind: 'text' }]);
  }
  const title = [companyName, input.title, input.subtitle ?? '', periodText(input.period)].filter((t) => t.trim() !== '');
  return writeXlsx({
    sheets: [{ name: input.title.slice(0, 31) || 'Report', columns, rows, title, freezeHeader: true, autoFilter: input.rows.length > 0 }],
    creator: 'Bahi ERP',
  });
}

export function exportTable(ctx: CompanyCtx, input: ExportTableInput): ExportFileResult {
  requirePermission(ctx, 'data.export');
  const companyName = input.company ?? ctx.company.name;
  let out: ExportFileResult;
  if (input.format === 'csv') {
    out = { bytes: encodeUtf8WithBom(buildCsv(input)), fileName: exportFileName(input.title, input.period, 'csv'), mimeType: CSV_MIME, rowCount: input.rows.length };
  } else {
    out = { bytes: buildXlsx(input, companyName), fileName: exportFileName(input.title, input.period, 'xlsx'), mimeType: XLSX_MIME, rowCount: input.rows.length };
  }
  ctx.db.transaction(() =>
    ctx.audit({
      action: 'export',
      entityType: 'report',
      entityLabel: input.title.slice(0, 200),
      after: { format: input.format, rows: input.rows.length, period: periodText(input.period) || undefined },
    }),
  );
  return out;
}

/**
 * 'data.export.audit': a report printed or saved as PDF by the shell (the printable HTML is built in
 * the renderer). Same rule and trail as Excel/CSV: the data.export permission, and an 'export' entry
 * in the edit log. Runs inside the route's transaction.
 */
export function auditReportOutput(ctx: CompanyCtx, input: ExportAuditInput): ExportAuditResult {
  requirePermission(ctx, 'data.export');
  ctx.audit({
    action: 'export',
    entityType: 'report',
    entityLabel: input.title.slice(0, 200),
    after: { format: input.format, rows: input.rows, period: periodText(input.period) || undefined },
  });
  return { ok: true };
}
