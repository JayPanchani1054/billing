/**
 * Export & print helpers for tables and reports.
 *
 *   await exportTable(def, 'xlsx');   // 'data.export.table' route (data module); falls back to CSV
 *   await printReport(def);           // OS print dialog (bahi.native('print.print'))
 *   await savePdf(def);               // Save as PDF (bahi.native('print.savePdf'))
 *
 * `def.rows`: amounts ('amount'/'drcr' columns) in integer paise, dates as ISO strings.
 * All functions resolve null when the user cancels the save dialog.
 */
import { todayLocal } from '../../shared/dates.ts';
import { apiOptional, isMissingRoute } from './api.ts';
import { native } from './bridge.ts';
import { buildPrintHtml, exportFileName, toCsv } from './lib/exportFormat.ts';
import type { TableExportDef } from './lib/exportFormat.ts';

export type { ExportCell, ExportColumn, ExportColumnKind, TableExportDef } from './lib/exportFormat.ts';
export { escapeHtml, buildPrintHtml, toCsv } from './lib/exportFormat.ts';

export type ExportFormat = 'xlsx' | 'csv';

export interface ExportResult {
  path: string;
  format: ExportFormat | 'pdf';
  /** Excel was asked for but the Excel exporter is not available yet — saved as CSV instead. */
  fellBackToCsv?: boolean;
}

const FILTERS = {
  xlsx: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
  csv: [{ name: 'CSV (comma separated)', extensions: ['csv'] }],
  pdf: [{ name: 'PDF document', extensions: ['pdf'] }],
};

function isExportOutput(x: unknown): x is { bytes: Uint8Array; fileName: string } {
  return typeof x === 'object' && x !== null && (x as { bytes?: unknown }).bytes instanceof Uint8Array && typeof (x as { fileName?: unknown }).fileName === 'string';
}

async function saveCsv(def: TableExportDef, fellBack: boolean): Promise<ExportResult | null> {
  const saved = await native('dialog.saveFile', {
    title: `Export ${def.title}`,
    defaultName: exportFileName(def, 'csv'),
    filters: FILTERS.csv,
    data: toCsv(def),
  });
  return saved ? { path: saved.path, format: 'csv', fellBackToCsv: fellBack || undefined } : null;
}

/** Export a table to Excel or CSV and ask the user where to save it. */
export async function exportTable(def: TableExportDef, format: ExportFormat): Promise<ExportResult | null> {
  if (format === 'csv') return saveCsv(def, false);
  let out: unknown;
  try {
    out = await apiOptional('data.export.table', {
      title: def.title,
      subtitle: def.subtitle,
      company: def.company,
      period: def.period,
      columns: def.columns.map((c) => ({ header: c.header, kind: c.kind ?? 'text', width: c.width, decimals: c.decimals })),
      rows: def.rows,
      totals: def.totals,
      format,
    });
  } catch (err) {
    if (isMissingRoute(err)) return saveCsv(def, true);
    throw err;
  }
  if (!isExportOutput(out)) return saveCsv(def, true);
  const saved = await native('dialog.saveFile', {
    title: `Export ${def.title}`,
    defaultName: out.fileName || exportFileName(def, 'xlsx'),
    filters: FILTERS.xlsx,
    data: out.bytes,
  });
  return saved ? { path: saved.path, format: 'xlsx' } : null;
}

/** Print a table/report through the OS print dialog. Resolves true when it was sent to a printer. */
export async function printReport(def: TableExportDef): Promise<boolean> {
  const html = buildPrintHtml(def, { printedOn: todayLocal() });
  const r = await native('print.print', { html, landscape: def.landscape });
  return r.printed;
}

/** Save a table/report as a PDF (A4) chosen through a save dialog. */
export async function savePdf(def: TableExportDef): Promise<ExportResult | null> {
  const html = buildPrintHtml(def, { printedOn: todayLocal() });
  const saved = await native('print.savePdf', { html, defaultName: exportFileName(def, 'pdf'), pageSize: 'A4', landscape: def.landscape });
  return saved ? { path: saved.path, format: 'pdf' } : null;
}

/** Reveal a saved file in Explorer (silently ignored when not allowed). */
export function showInFolder(path: string): void {
  void native('shell.showItem', { path }).catch(() => undefined);
}
