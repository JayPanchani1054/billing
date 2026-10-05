/**
 * Excel / CSV import: read the file, find the header row, map columns by (normalised) header, convert
 * every cell to its column type, group rows into records and apply each record through the masters /
 * voucher services (importApply.ts).
 *
 *  - preview: every record is applied inside a SAVEPOINT that is kept while the preview runs (so later rows
 *    see earlier ones — a group created in row 2 can be the parent in row 5) and everything is rolled back
 *    at the end: exactly the validation of a real import, without writing anything.
 *  - commit: one transaction; all-or-nothing unless `skipInvalid` (then failed records are rolled back
 *    individually and reported). One 'import' audit entry with the counts (the services audit each
 *    created master / voucher as usual).
 */
import { parseAmount, parseDecimal, rupeesToPaise } from '../../../shared/money.ts';
import { parseDateInput } from '../../../shared/dates.ts';
import type { FieldIssue } from '../../../shared/api.ts';
import type {
  ExportFileResult,
  ImportCellValue,
  ImportCommitInput,
  ImportCommitResult,
  ImportKind,
  ImportOptions,
  ImportPreviewInput,
  ImportPreviewResult,
  ImportRowResult,
} from '../../../shared/types/data.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { parseCsv } from '../../lib/csv.ts';
import { AppError } from '../../lib/errors.ts';
import { decodeText, FileFormatError } from '../../lib/text.ts';
import { readXlsx, writeXlsx, type XlsxCell, type XlsxKind } from '../../lib/xlsx.ts';
import { requirePermission } from './common.ts';
import { APPLIERS, type ApplyOutcome, type ImportRecord, type ParsedRow, type Typed } from './importApply.ts';
import { headerIndex, headerKey, KIND_SPECS, type ColumnSpec, type KindSpec } from './importSpecs.ts';

export const MAX_IMPORT_ROWS = 100_000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ───────────────────────────── Templates ─────────────────────────────

const TEMPLATE_KIND: Record<ColumnSpec['type'], XlsxKind> = {
  text: 'text',
  amount: 'number',
  qty: 'number',
  number: 'number',
  percent: 'number',
  integer: 'integer',
  date: 'date',
  yesno: 'text',
  drcr: 'text',
  choice: 'text',
};

const TYPE_TEXT: Record<ColumnSpec['type'], string> = {
  text: 'Text',
  amount: 'Amount in rupees (e.g. 12500.50)',
  qty: 'Quantity',
  number: 'Number',
  percent: 'Percent (18 for 18%)',
  integer: 'Whole number',
  date: 'Date (DD-MM-YYYY or a date cell)',
  yesno: 'Yes / No',
  drcr: 'Dr / Cr',
  choice: 'One of the listed values',
};

export function importTemplate(kind: ImportKind): ExportFileResult {
  const spec = KIND_SPECS[kind];
  const rows: XlsxCell[][] = [0, 1].map((i) => spec.columns.map((col) => col.examples[i]));
  const instructions: XlsxCell[][] = [
    ...spec.instructions.map((t) => [{ v: t, bold: true }, null, null, null] as XlsxCell[]),
    ['Delete the two example rows before importing. Columns marked * are required; other columns may be left blank or removed.', null, null, null],
    [null, null, null, null],
    ...spec.columns.map((col): XlsxCell[] => [
      col.header,
      col.required ? 'Yes' : '',
      col.choices ? `${TYPE_TEXT[col.type]}: ${col.choices.join(', ')}` : TYPE_TEXT[col.type],
      col.aliases?.length ? `${col.help} Also accepted as: ${col.aliases.join(', ')}.` : col.help,
    ]),
  ];
  const bytes = writeXlsx({
    sheets: [
      {
        name: spec.sheetName,
        columns: spec.columns.map((col) => ({ header: col.required ? `${col.header} *` : col.header, kind: TEMPLATE_KIND[col.type], width: Math.max(12, col.header.length + 4) })),
        rows,
        freezeHeader: true,
      },
      {
        name: 'Instructions',
        columns: [
          { header: 'Column', width: 24 },
          { header: 'Required', width: 10 },
          { header: 'Format', width: 40 },
          { header: 'Description', width: 90 },
        ],
        rows: instructions,
        title: [`Bahi ERP import template — ${spec.label}`, spec.description],
      },
    ],
    creator: 'Bahi ERP',
  });
  return { bytes, fileName: `Bahi-Import-${spec.sheetName.replace(/\s+/g, '-')}.xlsx`, mimeType: XLSX_MIME, rowCount: rows.length };
}

// ───────────────────────────── Reading the file ─────────────────────────────

interface Table {
  sheet: string | null;
  rows: ImportCellValue[][];
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function readTable(fileName: string, bytes: Uint8Array, spec: KindSpec, opts: ImportOptions): Table {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xls') && !isZip(bytes)) {
    throw new FileFormatError('xlsx', 'Old Excel 97–2003 files (.xls) cannot be read. Open the file in Excel and save it as .xlsx or .csv.');
  }
  if (isZip(bytes) || lower.endsWith('.xlsx')) {
    const book = readXlsx(bytes, { maxRows: MAX_IMPORT_ROWS + 20 });
    const sheets = book.sheets;
    const wanted = opts.sheet?.trim().toLowerCase();
    const pick =
      (wanted ? sheets.find((s) => s.name.toLowerCase() === wanted) : undefined) ??
      sheets.find((s) => s.name.toLowerCase() === spec.sheetName.toLowerCase()) ??
      sheets.find((s) => s.name.toLowerCase() !== 'instructions' && s.rows.some((r) => r.some((c) => c !== null && c !== ''))) ??
      sheets[0];
    if (wanted && pick?.name.toLowerCase() !== wanted) throw new AppError('VALIDATION', `The workbook has no sheet named "${opts.sheet ?? ''}".`);
    if (!pick) throw new AppError('VALIDATION', 'The workbook has no sheets.');
    return { sheet: pick.name, rows: pick.rows };
  }
  const { text } = decodeText(bytes);
  return { sheet: null, rows: parseCsv(text, { delimiter: 'auto', maxRows: MAX_IMPORT_ROWS + 20 }) };
}

interface Mapping {
  headerRow: number;
  /** column index → column key */
  columns: Map<number, string>;
  mapped: Array<{ header: string; key: string }>;
  unmapped: string[];
}

function findHeader(table: Table, spec: KindSpec): Mapping {
  const index = headerIndex(spec);
  const required = spec.columns.filter((col) => col.required).map((col) => col.key);
  let best: Mapping | null = null;
  let bestScore = -1;
  const scan = Math.min(table.rows.length, 15);
  for (let r = 0; r < scan; r++) {
    const row = table.rows[r] ?? [];
    const columns = new Map<number, string>();
    const mapped: Mapping['mapped'] = [];
    const unmapped: string[] = [];
    const used = new Set<string>();
    row.forEach((cell, i) => {
      const key = index.get(headerKey(cell));
      if (key && !used.has(key)) {
        used.add(key);
        columns.set(i, key);
        mapped.push({ header: String(cell).trim(), key });
      } else if (cell !== null && String(cell).trim() !== '') {
        unmapped.push(String(cell).trim());
      }
    });
    const hasRequired = required.every((k) => used.has(k));
    const score = (hasRequired ? 1000 : 0) + used.size;
    if (score > bestScore) {
      bestScore = score;
      best = { headerRow: r + 1, columns, mapped, unmapped };
    }
    if (hasRequired && used.size >= Math.min(spec.columns.length, 2)) break;
  }
  if (!best || best.columns.size === 0) {
    throw new AppError(
      'VALIDATION',
      `No column headings of the ${spec.label} template were found. The first row must contain headings such as ${spec.columns
        .slice(0, 3)
        .map((col) => `"${col.header}"`)
        .join(', ')}. Download the template to see the expected columns.`,
    );
  }
  const missing = spec.columns.filter((col) => col.required && ![...best.columns.values()].includes(col.key));
  if (missing.length > 0) {
    throw new AppError('VALIDATION', `Required column${missing.length > 1 ? 's' : ''} missing: ${missing.map((col) => col.header).join(', ')}. Add ${missing.length > 1 ? 'them' : 'it'} and try again.`);
  }
  return best;
}

// ───────────────────────────── Cell conversion ─────────────────────────────

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

function toText(v: ImportCellValue): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v ?? '').trim();
}

const FULL_DATE = /(^\d{4}-\d{1,2}-\d{1,2}$)|(^\d{8}$)|([-/. ]\d{2,4}$)/;

function convert(col: ColumnSpec, v: ImportCellValue, reference: string): { value: Typed; error?: string } {
  if (v === null || (typeof v === 'string' && v.trim() === '')) return { value: null };
  const label = `${col.header}: "${toText(v)}"`;
  switch (col.type) {
    case 'text':
      return { value: toText(v) };
    case 'amount': {
      if (typeof v === 'number') return Number.isFinite(v) ? { value: rupeesToPaise(v) } : { value: null, error: `${label} is not an amount` };
      const p = parseAmount(toText(v));
      return p === null ? { value: null, error: `${label} is not an amount` } : { value: p };
    }
    case 'qty':
    case 'number':
    case 'percent': {
      if (typeof v === 'number') return { value: v };
      const n = parseDecimal(toText(v).replace(/%$/, ''));
      return n === null ? { value: null, error: `${label} is not a number` } : { value: n };
    }
    case 'integer': {
      const n = typeof v === 'number' ? v : parseDecimal(toText(v));
      return n === null || !Number.isInteger(n) ? { value: null, error: `${label} must be a whole number` } : { value: n };
    }
    case 'date': {
      if (typeof v === 'number') return { value: null, error: `${label} is not a date (format the cell as a date or type DD-MM-YYYY)` };
      const s = toText(v);
      const iso = FULL_DATE.test(s.trim()) ? parseDateInput(s, reference) : null;
      return iso === null ? { value: null, error: `${label} is not a valid date (use DD-MM-YYYY)` } : { value: iso };
    }
    case 'yesno': {
      if (typeof v === 'boolean') return { value: v };
      const s = toText(v).toLowerCase();
      if (YES.has(s)) return { value: true };
      if (NO.has(s)) return { value: false };
      return { value: null, error: `${label} must be Yes or No` };
    }
    case 'drcr': {
      const s = toText(v).toLowerCase().replace(/\.$/, '');
      if (s === 'dr' || s === 'debit') return { value: 'Dr' };
      if (s === 'cr' || s === 'credit') return { value: 'Cr' };
      return { value: null, error: `${label} must be Dr or Cr` };
    }
    case 'choice': {
      const norm = (x: string): string => x.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
      const s = norm(toText(v));
      const hit = col.choices?.find((ch) => norm(ch) === s || norm(ch).replace(/ /g, '') === s.replace(/ /g, ''));
      return hit ? { value: hit } : { value: null, error: `${label} must be one of: ${(col.choices ?? []).join(', ')}` };
    }
    default:
      return { value: toText(v) };
  }
}

interface ParsedFile {
  table: Table;
  mapping: Mapping;
  records: Array<ImportRecord & { errors: string[]; raw: Record<string, ImportCellValue> }>;
}

function groupKey(spec: KindSpec, row: ParsedRow): string | null {
  if (spec.kind === 'vouchers_ledger') {
    const key = row.values.key;
    if (key !== null && key !== undefined && String(key).trim() !== '') return `k:${String(key).trim().toLowerCase()}`;
    const parts = [row.values.voucherType, row.values.number, row.values.date].map((x) => (x === null || x === undefined ? '' : String(x).trim().toLowerCase()));
    return parts[1] ? `n:${parts.join('|')}` : null;
  }
  if (spec.kind === 'purchase_invoices') {
    const no = row.values.supplierInvoiceNo;
    if (no === null || no === undefined) return null;
    return `${String(row.values.party ?? '').trim().toLowerCase()}|${String(no).trim().toLowerCase()}`;
  }
  if (!spec.groupBy) return null;
  const v = row.values[spec.groupBy];
  return v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().toLowerCase();
}

function parseFile(ctx: CompanyCtx, spec: KindSpec, fileName: string, bytes: Uint8Array, opts: ImportOptions): ParsedFile {
  const table = readTable(fileName, bytes, spec, opts);
  const mapping = findHeader(table, spec);
  const byKey = new Map(spec.columns.map((col) => [col.key, col]));
  const reference = ctx.clock.today();
  const records: ParsedFile['records'] = [];
  const grouped = new Map<string, ParsedFile['records'][number]>();
  let dataRows = 0;
  for (let r = mapping.headerRow; r < table.rows.length; r++) {
    const cells = table.rows[r] ?? [];
    if (cells.every((c) => c === null || (typeof c === 'string' && c.trim() === ''))) continue;
    if (++dataRows > MAX_IMPORT_ROWS) {
      throw new AppError('VALIDATION', `The file has more than ${MAX_IMPORT_ROWS.toLocaleString('en-IN')} rows. Split it into smaller files.`);
    }
    const values: Record<string, Typed> = {};
    const raw: Record<string, ImportCellValue> = {};
    const errors: string[] = [];
    for (const [i, key] of mapping.columns) {
      const col = byKey.get(key) as ColumnSpec;
      const cell = cells[i] ?? null;
      raw[key] = cell;
      const out = convert(col, cell, reference);
      values[key] = out.value;
      if (out.error) errors.push(out.error);
    }
    for (const col of spec.columns) {
      if (col.required && (values[col.key] === null || values[col.key] === undefined) && !errors.some((e) => e.startsWith(`${col.header}:`))) {
        if (!(spec.kind === 'vouchers_ledger' && col.key === 'key')) errors.push(`${col.header} is required`);
      }
    }
    const row: ParsedRow = { rowNumber: r + 1, values };
    const gk = groupKey(spec, row);
    const existing = gk !== null ? grouped.get(gk) : undefined;
    if (existing) {
      existing.rows.push(row);
      existing.errors.push(...errors.map((e) => `Row ${row.rowNumber}: ${e}`));
    } else {
      const keyField = [spec.groupBy, 'number', 'name', 'symbol', 'firstUnit', 'ledger', 'item'].find(
        (k) => k !== undefined && values[k] !== null && values[k] !== undefined && String(values[k]).trim() !== '',
      );
      const rec = { key: keyField ? String(values[keyField]) : `row ${row.rowNumber}`, rows: [row], errors: [...errors], raw };
      if (gk !== null) grouped.set(gk, rec);
      records.push(rec);
    }
  }
  return { table, mapping, records };
}

// ───────────────────────────── Run ─────────────────────────────

class RollbackPreview extends Error {}

function messagesOf(err: unknown): string[] {
  if (err instanceof AppError) {
    if (err.code === 'INTERNAL') throw err;
    const details = err.details;
    if (Array.isArray(details) && details.length > 0 && details.every((d) => d && typeof d === 'object' && 'message' in d)) {
      return (details as FieldIssue[]).map((d) => d.message);
    }
    const warnings = (details as { warnings?: Array<{ message: string; blocking?: boolean }> } | undefined)?.warnings;
    if (Array.isArray(warnings) && warnings.length > 0) {
      const blocking = warnings.filter((w) => w.blocking);
      return (blocking.length > 0 ? blocking : warnings).map((w) => w.message);
    }
    return [err.message];
  }
  throw err;
}

interface RunResult {
  rows: ImportRowResult[];
}

function run(ctx: CompanyCtx, kind: ImportKind, parsed: ParsedFile, opts: ImportOptions & { dryRun: boolean }): RunResult {
  const applier = APPLIERS[kind];
  const rows: ImportRowResult[] = [];
  for (const rec of parsed.records) {
    const base = { rowNumber: rec.rows[0].rowNumber, rowNumbers: rec.rows.map((r) => r.rowNumber), key: rec.key, data: rec.raw };
    if (rec.errors.length > 0) {
      rows.push({ ...base, status: 'error', action: 'none', messages: rec.errors });
      continue;
    }
    try {
      const out: ApplyOutcome = ctx.db.transaction(() => applier(ctx, rec, opts));
      rows.push({ ...base, status: out.status, action: out.action, messages: out.messages });
    } catch (err) {
      rows.push({ ...base, status: 'error', action: 'none', messages: messagesOf(err) });
    }
  }
  return { rows };
}

function summarise(rows: ImportRowResult[]): ImportPreviewResult['summary'] {
  const count = (pred: (r: ImportRowResult) => boolean): number => rows.filter(pred).length;
  return {
    total: rows.length,
    ok: count((r) => r.status === 'ok'),
    warning: count((r) => r.status === 'warning'),
    error: count((r) => r.status === 'error'),
    duplicate: count((r) => r.status === 'duplicate'),
    willCreate: count((r) => r.status !== 'error' && r.action === 'create'),
    willUpdate: count((r) => r.status !== 'error' && r.action === 'update'),
    willSkip: count((r) => r.action === 'skip'),
  };
}

export function previewImport(ctx: CompanyCtx, input: ImportPreviewInput): ImportPreviewResult {
  requirePermission(ctx, 'data.import');
  const spec = KIND_SPECS[input.kind];
  const opts = input.options ?? {};
  const parsed = parseFile(ctx, spec, input.fileName, input.bytes, opts);
  let result: RunResult = { rows: [] };
  try {
    ctx.db.transaction(() => {
      result = run(ctx, input.kind, parsed, { ...opts, dryRun: true });
      throw new RollbackPreview();
    });
  } catch (err) {
    if (!(err instanceof RollbackPreview)) throw err;
  }
  return {
    kind: input.kind,
    fileName: input.fileName,
    sheet: parsed.table.sheet,
    headerRow: parsed.mapping.headerRow,
    mappedColumns: parsed.mapping.mapped,
    unmappedHeaders: parsed.mapping.unmapped,
    rows: result.rows,
    summary: summarise(result.rows),
  };
}

export function commitImport(ctx: CompanyCtx, input: ImportCommitInput): ImportCommitResult {
  requirePermission(ctx, 'data.import');
  const spec = KIND_SPECS[input.kind];
  const opts = input.options;
  const parsed = parseFile(ctx, spec, input.fileName, input.bytes, opts);
  return ctx.db.transaction(() => {
    const { rows } = run(ctx, input.kind, parsed, { ...opts, dryRun: false });
    const failed = rows.filter((r) => r.status === 'error');
    if (failed.length > 0 && !opts.skipInvalid) {
      const issues: FieldIssue[] = failed.slice(0, 200).map((r) => ({ path: `row ${r.rowNumber}`, message: `Row ${r.rowNumber}${r.key ? ` (${r.key})` : ''}: ${r.messages.join('; ')}` }));
      throw new AppError(
        'VALIDATION',
        `${failed.length} of ${rows.length} record${rows.length === 1 ? '' : 's'} ${failed.length === 1 ? 'has' : 'have'} errors, so nothing was imported. Correct ${failed.length === 1 ? 'it' : 'them'}, or choose "Skip invalid rows".`,
        issues,
      );
    }
    const result: ImportCommitResult = {
      kind: input.kind,
      total: rows.length,
      created: rows.filter((r) => r.status !== 'error' && r.action === 'create').length,
      updated: rows.filter((r) => r.status !== 'error' && r.action === 'update').length,
      skipped: rows.filter((r) => r.action === 'skip').length,
      failed: failed.length,
      rows: rows.filter((r) => r.status === 'error' || r.status === 'duplicate'),
    };
    const now = ctx.clock.now().toISOString();
    const batchId = ctx.db.run('INSERT INTO import_batches (kind, file_name, imported_at, user_id, meta) VALUES (:kind, :file, :ts, :user, :meta)', {
      kind: spec.kind === 'sales_invoices' || spec.kind === 'purchase_invoices' || spec.kind === 'vouchers_ledger' ? 'vouchers' : 'masters',
      file: input.fileName.slice(0, 255),
      ts: now,
      user: ctx.session.userId,
      meta: JSON.stringify({ importKind: input.kind, created: result.created, updated: result.updated, skipped: result.skipped, failed: result.failed }),
    }).lastInsertRowid;
    ctx.audit({
      action: 'import',
      entityType: 'import_batch',
      entityId: batchId,
      entityLabel: `${spec.label} from ${input.fileName}`.slice(0, 300),
      after: { kind: input.kind, file: input.fileName, total: result.total, created: result.created, updated: result.updated, skipped: result.skipped, failed: result.failed },
    });
    return result;
  });
}
