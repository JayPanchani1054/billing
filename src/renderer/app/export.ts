/**
 * Export & print helpers for tables and reports.
 *
 *   await exportTable(def, 'xlsx' | 'csv');   // 'data.export.table' route builds the file
 *   await printReport(def);                   // OS print dialog (bahi.native('print.print'))
 *   await savePdf(def);                       // Save as PDF (bahi.native('print.savePdf'))
 *
 * Every one of them goes through the core first, so the `data.export` permission and the
 * 'export' edit-log entry apply equally to Excel, CSV, PDF and Print: Excel/CSV bytes come from
 * 'data.export.table'; print and PDF (whose HTML is built here) are authorised and logged by
 * 'data.export.audit' before anything is printed or saved. A user without the permission gets
 * ApiError('FORBIDDEN') and nothing leaves the app.
 *
 * `def.rows`: amounts ('amount'/'drcr' columns) in integer paise, dates as ISO strings.
 * exportTable/savePdf resolve null when the user cancels the save dialog.
 */
import type { Permission } from '../../shared/constants.ts';
import { todayLocal } from '../../shared/dates.ts';
import { api } from './api.ts';
import { native } from './bridge.ts';
import { buildPrintHtml, exportFileName } from './lib/exportFormat.ts';
import type { ExportCell, TableExportDef } from './lib/exportFormat.ts';

export type { ExportCell, ExportColumn, ExportColumnKind, TableExportDef } from './lib/exportFormat.ts';
export { escapeHtml, buildPrintHtml, toCsv } from './lib/exportFormat.ts';

export type ExportFormat = 'xlsx' | 'csv';

export interface ExportResult {
  path: string;
  format: ExportFormat | 'pdf';
  /** @deprecated Never set any more: CSV is no longer built in the renderer as a fallback. */
  fellBackToCsv?: boolean;
}

/** Permission a report export / print needs (checked again by the core). */
export const EXPORT_PERMISSION: Permission = 'data.export';

const FILTERS = {
  xlsx: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
  csv: [{ name: 'CSV (comma separated)', extensions: ['csv'] }],
  pdf: [{ name: 'PDF document', extensions: ['pdf'] }],
};

/** A cell as the route accepts it: undefined and non-finite numbers become empty. */
function cell(c: ExportCell): string | number | boolean | null {
  if (c === undefined || c === null) return null;
  if (typeof c === 'number' && !Number.isFinite(c)) return null;
  return c;
}

/** Levels as the route accepts them (0–50, one per row) or undefined. */
function levelsOf(def: TableExportDef): number[] | undefined {
  if (!def.levels || def.levels.length === 0) return undefined;
  return def.rows.map((_, i) => Math.max(0, Math.min(50, Math.round(def.levels?.[i] ?? 0))));
}

/** Export a table to Excel or CSV (built and logged by the core) and ask where to save it. */
export async function exportTable(def: TableExportDef, format: ExportFormat): Promise<ExportResult | null> {
  const out = await api('data.export.table', {
    title: def.title.slice(0, 200),
    subtitle: def.subtitle?.slice(0, 300),
    company: def.company?.slice(0, 200),
    period: def.period,
    columns: def.columns.map((c) => ({ header: c.header, kind: c.kind ?? 'text', width: c.width, decimals: c.decimals })),
    rows: def.rows.map((r) => r.map(cell)),
    totals: def.totals ? def.totals.map(cell) : undefined,
    levels: levelsOf(def),
    notes: def.notes?.slice(0, 2000),
    format,
  });
  const saved = await native('dialog.saveFile', {
    title: `Export ${def.title}`,
    defaultName: out.fileName || exportFileName(def, format),
    filters: FILTERS[format],
    data: out.bytes,
  });
  return saved ? { path: saved.path, format } : null;
}

/** Authorise (data.export) and log a print / PDF of a report before it happens. */
async function auditOutput(def: TableExportDef, format: 'pdf' | 'print'): Promise<void> {
  await api('data.export.audit', { title: def.title.slice(0, 200), subtitle: def.subtitle?.slice(0, 300), period: def.period, rows: def.rows.length, format });
}

/** Print a table/report through the OS print dialog. Resolves true when it was sent to a printer. */
export async function printReport(def: TableExportDef): Promise<boolean> {
  await auditOutput(def, 'print');
  const html = buildPrintHtml(def, { printedOn: todayLocal() });
  const r = await native('print.print', { html, landscape: def.landscape });
  return r.printed;
}

/** Save a table/report as a PDF (A4) chosen through a save dialog. */
export async function savePdf(def: TableExportDef): Promise<ExportResult | null> {
  await auditOutput(def, 'pdf');
  const html = buildPrintHtml(def, { printedOn: todayLocal() });
  const saved = await native('print.savePdf', { html, defaultName: exportFileName(def, 'pdf'), pageSize: 'A4', landscape: def.landscape });
  return saved ? { path: saved.path, format: 'pdf' } : null;
}

/** Reveal a saved file in Explorer (silently ignored when not allowed). */
export function showInFolder(path: string): void {
  void native('shell.showItem', { path }).catch(() => undefined);
}
