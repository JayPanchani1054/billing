/**
 * Table export/print building blocks — pure (tested in exportFormat.test.ts):
 *   escapeHtml, cell formatting by column kind, CSV (Excel-safe), and the self-contained printable
 *   HTML document used by printReport/savePdf (A4, company header, page numbers, totals).
 *
 * Conventions for `rows`: amounts ('amount' / 'drcr') are integer PAISE, dates are ISO strings,
 * quantities/numbers are plain numbers, text is text. Every value is HTML-escaped.
 */
import { neutraliseFormula } from '../../../shared/csvSafe.ts';
import { formatDate } from '../../../shared/dates.ts';
import { formatDrCr, formatIndianNumber, formatMoney } from '../../../shared/format.ts';

export type ExportColumnKind = 'text' | 'amount' | 'drcr' | 'qty' | 'number' | 'date' | 'percent';

export interface ExportColumn {
  header: string;
  kind?: ExportColumnKind;
  /** Relative width hint in characters (used by the Excel export and the print layout). */
  width?: number;
  /** Decimal places for 'qty' / 'number' / 'percent' (default 2 for qty/percent, 0 for number). */
  decimals?: number;
}

export type ExportCell = string | number | boolean | null | undefined;

export interface TableExportDef {
  title: string;
  subtitle?: string;
  /** Company name for the report header (defaults to the open company). */
  company?: string;
  /** Period for the header: ISO range or a ready label. */
  period?: { from: string; to: string } | string;
  columns: readonly ExportColumn[];
  rows: readonly (readonly ExportCell[])[];
  /** Optional totals row (same shape as a row). */
  totals?: readonly ExportCell[];
  /** Optional rows that should be indented (tree reports): level per row index. */
  levels?: readonly number[];
  /** Footnote under the table. */
  notes?: string;
  landscape?: boolean;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text for HTML element content and attribute values. null/undefined → ''. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export function isNumericKind(kind: ExportColumnKind | undefined): boolean {
  return kind === 'amount' || kind === 'drcr' || kind === 'qty' || kind === 'number' || kind === 'percent';
}

/** Display text for a cell (reports/print). Non-numeric values in numeric columns are shown as text. */
export function formatExportCell(value: ExportCell, column: ExportColumn): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    switch (column.kind) {
      case 'amount':
        return formatMoney(value);
      case 'drcr':
        return formatDrCr(value);
      case 'qty':
        return formatIndianNumber(value, column.decimals ?? 2);
      case 'percent':
        return `${formatIndianNumber(value, column.decimals ?? 2)}%`;
      case 'number':
        return formatIndianNumber(value, column.decimals ?? 0);
      default:
        return String(value);
    }
  }
  if (column.kind === 'date') return formatDate(value) || value;
  return value;
}

/** Plain machine-friendly text for CSV: rupees without grouping ('1234.50'), Dr/Cr suffix for drcr. */
export function csvCellText(value: ExportCell, column: ExportColumn): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    if (column.kind === 'amount' || column.kind === 'drcr') {
      const abs = Math.abs(value);
      const text = `${Math.floor(abs / 100)}.${String(Math.round(abs % 100)).padStart(2, '0')}`;
      if (column.kind === 'drcr') return value === 0 ? '0.00' : `${text} ${value > 0 ? 'Dr' : 'Cr'}`;
      return value < 0 ? `-${text}` : text;
    }
    if (column.kind === 'qty' || column.kind === 'percent' || column.kind === 'number') {
      const d = column.decimals ?? (column.kind === 'number' ? 0 : 2);
      return value.toFixed(d);
    }
    return String(value);
  }
  if (column.kind === 'date') return formatDate(value, 'DD-MM-YYYY') || value;
  return value;
}

/**
 * Neutralise spreadsheet formulas in text cells (CSV injection): a leading = + - @ tab or CR is
 * prefixed with an apostrophe so Excel shows it as text.
 */
export function guardFormula(text: string): string {
  // One shared rule with the core CSV / Excel writers (plain numbers such as "-12.50" stay numbers).
  return neutraliseFormula(text);
}

function csvQuote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV with a UTF-8 BOM (Excel opens ₹ and Indian-language names correctly) and CRLF line ends. */
export function toCsv(def: Pick<TableExportDef, 'columns' | 'rows' | 'totals'>): string {
  const lines: string[] = [];
  const line = (cells: readonly ExportCell[]): string =>
    def.columns
      .map((col, i) => {
        const raw = csvCellText(cells[i], col);
        // Every text value is guarded — also text inside a numeric column (a real number is never a string here).
        const safe = typeof cells[i] === 'string' ? guardFormula(raw) : raw;
        return csvQuote(safe);
      })
      .join(',');
  lines.push(def.columns.map((c) => csvQuote(guardFormula(c.header))).join(','));
  for (const row of def.rows) lines.push(line(row));
  if (def.totals) lines.push(line(def.totals));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** File-name-safe slug: 'Trial Balance (Detailed)' → 'Trial-Balance-Detailed'. */
export function fileSlug(text: string): string {
  const s = text
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 80) || 'Report';
}

export function periodText(period: TableExportDef['period']): string {
  if (!period) return '';
  if (typeof period === 'string') return period;
  return `${formatDate(period.from)} to ${formatDate(period.to)}`;
}

/** Default export file name: 'Trial-Balance_01-04-2026_to_31-03-2027.csv'. */
export function exportFileName(def: Pick<TableExportDef, 'title' | 'period'>, ext: string): string {
  const p = def.period && typeof def.period !== 'string' ? `_${formatDate(def.period.from, 'DD-MM-YYYY')}_to_${formatDate(def.period.to, 'DD-MM-YYYY')}` : '';
  return `${fileSlug(def.title)}${p}.${ext}`;
}

// Self-contained print stylesheet. Colours derive from currentColor (no palette in a print document).
const PRINT_CSS = `
@page { size: A4 PORTRAIT_OR_LANDSCAPE; margin: 14mm 12mm 16mm;
  @bottom-left { content: "FOOTER_LEFT"; font: 8pt/1.2 "Segoe UI", system-ui, sans-serif; opacity: .7; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt/1.2 "Segoe UI", system-ui, sans-serif; opacity: .7; }
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 9.5pt/1.35 "Segoe UI", system-ui, -apple-system, sans-serif; }
header { margin-bottom: 10pt; text-align: center; }
.company { font-size: 13pt; font-weight: 700; letter-spacing: .01em; }
.title { margin-top: 2pt; font-size: 11pt; font-weight: 600; }
.subtitle, .period { margin-top: 1pt; font-size: 9pt; opacity: .8; }
table { width: 100%; border-collapse: collapse; table-layout: auto; }
thead { display: table-header-group; }
tfoot { display: table-row-group; }
tr { break-inside: avoid; }
th, td { padding: 3pt 5pt; vertical-align: top; text-align: left; }
th { font-weight: 600; border-top: 1px solid currentColor; border-bottom: 1px solid currentColor;
  background: color-mix(in srgb, currentColor 6%, transparent); }
td { border-bottom: 0.5px solid color-mix(in srgb, currentColor 18%, transparent); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.total td { font-weight: 700; border-top: 1px solid currentColor; border-bottom: 2px double currentColor; }
.notes { margin-top: 8pt; font-size: 8.5pt; opacity: .8; }
.empty { padding: 12pt; text-align: center; opacity: .7; }
`;

/**
 * A complete printable HTML document (no external resources, no scripts). Every value is escaped.
 * `printedOn` is passed in (not read from the clock) so output is deterministic and testable.
 */
export function buildPrintHtml(def: TableExportDef, opts: { company?: string; printedOn?: string; appName?: string } = {}): string {
  const company = def.company ?? opts.company ?? '';
  const footerLeft = `${opts.appName ?? 'Pevqori'}${opts.printedOn ? ` · Printed on ${formatDate(opts.printedOn)}` : ''}`;
  const css = PRINT_CSS.replace('PORTRAIT_OR_LANDSCAPE', def.landscape ? 'landscape' : 'portrait').replace(
    'FOOTER_LEFT',
    // CSS string content: escape backslashes and quotes.
    footerLeft.replace(/\\/g, '\\\\').replace(/"/g, '\\"'),
  );
  const cls = (col: ExportColumn): string => (isNumericKind(col.kind) ? ' class="num"' : '');
  const head = def.columns.map((c) => `<th${cls(c)}>${escapeHtml(c.header)}</th>`).join('');
  const cellsHtml = (cells: readonly ExportCell[], level = 0): string =>
    def.columns
      .map((col, i) => {
        const text = escapeHtml(formatExportCell(cells[i], col));
        const indent = i === 0 && level > 0 ? ` style="padding-left:${(5 + level * 10).toFixed(0)}pt"` : '';
        return `<td${cls(col)}${indent}>${text}</td>`;
      })
      .join('');
  const body = def.rows.length
    ? def.rows.map((r, i) => `<tr>${cellsHtml(r, def.levels?.[i] ?? 0)}</tr>`).join('\n')
    : `<tr><td class="empty" colspan="${def.columns.length}">No entries for this period.</td></tr>`;
  const totals = def.totals ? `<tbody><tr class="total">${cellsHtml(def.totals)}</tr></tbody>` : '';
  const period = periodText(def.period);
  return [
    '<!doctype html>',
    '<html lang="en-IN"><head><meta charset="utf-8">',
    `<title>${escapeHtml(def.title)}</title>`,
    `<style>${css}</style></head><body>`,
    '<header>',
    company ? `<div class="company">${escapeHtml(company)}</div>` : '',
    `<div class="title">${escapeHtml(def.title)}</div>`,
    def.subtitle ? `<div class="subtitle">${escapeHtml(def.subtitle)}</div>` : '',
    period ? `<div class="period">${escapeHtml(period)}</div>` : '',
    '</header>',
    `<table><thead><tr>${head}</tr></thead><tbody>`,
    body,
    `</tbody>${totals}</table>`,
    def.notes ? `<p class="notes">${escapeHtml(def.notes)}</p>` : '',
    '</body></html>',
  ]
    .filter(Boolean)
    .join('\n');
}

// ───────────────────────────── Bytes ─────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (with padding) without Buffer/btoa. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`;
  }
  return out;
}

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Detect PNG/JPEG/GIF/WebP from magic bytes (never trust the file extension). */
export function sniffImageMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** 1536 → '1.5 KB', 3_500_000 → '3.3 MB'. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}
