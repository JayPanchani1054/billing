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
 *  - Both are asynchronous exclusive jobs (withImportJob, api/jobs.ts): records are applied in
 *    chunks of IMPORT_CHUNK inside the one transaction, yielding to the event loop between chunks and
 *    publishing progress ('data.import.progress'), so a large file never freezes the app while staying
 *    all-or-nothing. Meanwhile other requests for the company are refused (CONFLICT) rather than
 *    joining the open transaction. One job per company at a time.
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
  TallyProgress,
} from '../../../shared/types/data.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { parseCsv } from '../../lib/csv.ts';
import { AppError } from '../../lib/errors.ts';
import { decodeText, FileFormatError } from '../../lib/text.ts';
import { readXlsx, writeXlsx, type XlsxCell, type XlsxKind } from '../../lib/xlsx.ts';
import { runExclusiveJob } from '../../api/jobs.ts';
import { hasPermission, requirePermission, yieldToEventLoop } from './common.ts';
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
    const example = exampleRowOf(spec, mapping, values, reference);
    if (example !== null) {
      errors.push(`This is example row ${example} from the template, not your data. Delete the example rows before importing.`);
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

/**
 * 1 or 2 when the row is one of the template's example rows left in the file (every mapped column holds
 * the example value, at least three of them filled), else null — so sample parties and invoices never reach
 * the books by accident.
 */
function exampleRowOf(spec: KindSpec, mapping: Mapping, values: Record<string, Typed>, reference: string): 1 | 2 | null {
  const byKey = new Map(spec.columns.map((col) => [col.key, col]));
  for (const i of [0, 1] as const) {
    let compared = 0;
    let same = true;
    for (const key of mapping.columns.values()) {
      const col = byKey.get(key);
      if (!col) continue;
      const ex = col.examples[i];
      const want = ex === null ? null : convert(col, ex, reference).value;
      const got = values[key] ?? null;
      const eq = typeof want === 'string' && typeof got === 'string' ? want.trim().toLowerCase() === got.trim().toLowerCase() : want === got;
      if (!eq) {
        same = false;
        break;
      }
      if (want !== null) compared++;
    }
    if (same && compared >= 3) return i === 0 ? 1 : 2;
  }
  return null;
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

/** Records applied per chunk; the job yields to the event loop (and reports progress) between chunks. */
export const IMPORT_CHUNK = 200;

/** Apply one record inside its own savepoint (a failure rolls back that record only). */
function applyRecord(ctx: CompanyCtx, kind: ImportKind, rec: ParsedFile['records'][number], opts: ImportOptions & { dryRun: boolean }): ImportRowResult {
  const base = { rowNumber: rec.rows[0].rowNumber, rowNumbers: rec.rows.map((r) => r.rowNumber), key: rec.key, data: rec.raw };
  if (rec.errors.length > 0) return { ...base, status: 'error', action: 'none', messages: rec.errors };
  try {
    const out: ApplyOutcome = ctx.db.transaction(() => APPLIERS[kind](ctx, rec, opts));
    return { ...base, status: out.status, action: out.action, messages: out.messages };
  } catch (err) {
    return { ...base, status: 'error', action: 'none', messages: messagesOf(err) };
  }
}

/**
 * Apply every record in chunks of IMPORT_CHUNK, yielding between chunks. Later records see earlier
 * ones (same transaction). `abortIf` is checked at every chunk boundary.
 */
async function run(ctx: CompanyCtx, kind: ImportKind, parsed: ParsedFile, opts: ImportOptions & { dryRun: boolean }, progress: (done: number) => void, abortIf: () => void): Promise<RunResult> {
  const rows: ImportRowResult[] = [];
  const records = parsed.records;
  for (let start = 0; start < records.length; start += IMPORT_CHUNK) {
    for (const rec of records.slice(start, start + IMPORT_CHUNK)) rows.push(applyRecord(ctx, kind, rec, opts));
    progress(Math.min(start + IMPORT_CHUNK, records.length));
    await yieldToEventLoop();
    abortIf();
  }
  return { rows };
}

// ───────────────────────────── Job plumbing: own connection, progress, one at a time ─────────────────────────────

const progressByCompany = new Map<string, TallyProgress>();
const RUNNING = new Set<string>();
const jobKey = (ctx: CompanyCtx): string => `${ctx.company.dbPath}|${ctx.company.id}`;

function setProgress(ctx: CompanyCtx, p: TallyProgress): void {
  progressByCompany.set(jobKey(ctx), p);
}

/** 'data.import.progress': where the running (or last) preview / import of this company is. */
export function importProgress(ctx: CompanyCtx): TallyProgress {
  return progressByCompany.get(jobKey(ctx)) ?? { running: false, phase: 'idle', done: 0, total: 0, message: '' };
}

/** Routes still answered while an import job holds the company (they never touch the database). */
const ALLOWED_DURING_IMPORT: ReadonlySet<string> = new Set(['data.import.progress', 'data.tally.progress']);

/**
 * Run an import job (preview or commit) in ONE transaction that stays open across its chunks, so it
 * can yield between chunks to publish progress while staying all-or-nothing. While it runs the company
 * is reserved for it (api/jobs.ts): other company requests are refused with a clear message instead
 * of joining — or reading the uncommitted work of — the import's transaction. Closing the company
 * mid-job rolls it back.
 */
async function withImportJob<T>(ctx: CompanyCtx, job: (ictx: CompanyCtx, abortIf: () => void) => Promise<T>): Promise<T> {
  const key = jobKey(ctx);
  if (RUNNING.has(key)) throw new AppError('CONFLICT', 'An import is already running for this company. Wait for it to finish.');
  RUNNING.add(key);
  try {
    const abortIf = (): void => {
      if (!ctx.db.isOpen) throw new AppError('CONFLICT', 'The company was closed during the import, so nothing was imported.');
    };
    return await runExclusiveJob(
      ctx.db,
      { message: 'An import is running in this company. Wait for it to finish (see Import data), then try again.', allow: ALLOWED_DURING_IMPORT },
      () => job(ctx, abortIf),
    );
  } finally {
    RUNNING.delete(key);
  }
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

const VOUCHER_KINDS: ReadonlySet<ImportKind> = new Set(['sales_invoices', 'purchase_invoices', 'vouchers_ledger']);
/** Kinds that change existing masters even without "update existing" (opening balances / stock). */
const ALTERS_MASTERS: ReadonlySet<ImportKind> = new Set(['opening_balances', 'stock_openings']);

/**
 * The masters services do not check permissions themselves (their routes do), so an import must ask
 * for the same rights as the screens: data.import alone does not let a user create or alter masters.
 */
function requireKindPermissions(ctx: CompanyCtx, kind: ImportKind, opts: ImportOptions): void {
  requirePermission(ctx, 'data.import');
  const deny = (what: string, perm: string): never => {
    throw new AppError('FORBIDDEN', `You do not have permission to ${what}, so this file cannot be imported. Ask the owner to grant "${perm}".`);
  };
  if (VOUCHER_KINDS.has(kind)) {
    if (!hasPermission(ctx, 'vouchers.create')) deny('create vouchers', 'vouchers.create');
    return;
  }
  if (ALTERS_MASTERS.has(kind)) {
    if (!hasPermission(ctx, 'masters.alter')) deny('alter masters (opening balances)', 'masters.alter');
    return;
  }
  if (!hasPermission(ctx, 'masters.create')) deny('create masters', 'masters.create');
  if (opts.updateExisting && !hasPermission(ctx, 'masters.alter')) deny('alter masters ("Update existing records")', 'masters.alter');
}

/**
 * Full dry run of the file (every record is applied exactly as an import would, then everything is
 * rolled back): asynchronous and chunked with progress ('data.import.progress'), on its own connection.
 */
export async function previewImport(ctx: CompanyCtx, input: ImportPreviewInput): Promise<ImportPreviewResult> {
  requireKindPermissions(ctx, input.kind, input.options ?? {});
  const spec = KIND_SPECS[input.kind];
  const opts = input.options ?? {};
  const phase = VOUCHER_KINDS.has(input.kind) ? 'vouchers' : 'masters';
  setProgress(ctx, { running: true, phase: 'parse', done: 0, total: 0, message: 'Reading the file…' });
  try {
    const parsed = parseFile(ctx, spec, input.fileName, input.bytes, opts);
    const total = parsed.records.length;
    let result: RunResult = { rows: [] };
    try {
      await withImportJob(ctx, async (ictx, abortIf) => {
        result = await run(ictx, input.kind, parsed, { ...opts, dryRun: true }, (done) => setProgress(ctx, { running: true, phase, done, total, message: `Checking ${done.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} records…` }), abortIf);
        throw new RollbackPreview();
      });
    } catch (err) {
      if (!(err instanceof RollbackPreview)) throw err;
    }
    setProgress(ctx, { running: false, phase: 'done', done: total, total, message: 'Check finished.' });
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
  } catch (err) {
    setProgress(ctx, { running: false, phase: 'failed', done: 0, total: 0, message: err instanceof AppError ? err.message : 'The check failed.' });
    throw err;
  }
}

/**
 * Import the file: all-or-nothing (unless `skipInvalid`) in ONE transaction on its own connection,
 * applied in chunks with progress, so a 10,000-voucher file never freezes the app. The services audit
 * every master / voucher; one 'import' entry records the counts.
 */
export async function commitImport(ctx: CompanyCtx, input: ImportCommitInput): Promise<ImportCommitResult> {
  requireKindPermissions(ctx, input.kind, input.options);
  const spec = KIND_SPECS[input.kind];
  const opts = input.options;
  const phase = VOUCHER_KINDS.has(input.kind) ? 'vouchers' : 'masters';
  setProgress(ctx, { running: true, phase: 'parse', done: 0, total: 0, message: 'Reading the file…' });
  try {
    const parsed = parseFile(ctx, spec, input.fileName, input.bytes, opts);
    const total = parsed.records.length;
    const result = await withImportJob(ctx, async (ictx, abortIf) => {
      const { rows } = await run(ictx, input.kind, parsed, { ...opts, dryRun: false }, (done) => setProgress(ctx, { running: true, phase, done, total, message: `Importing ${done.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} records…` }), abortIf);
      const failed = rows.filter((r) => r.status === 'error');
      if (failed.length > 0 && !opts.skipInvalid) {
        const issues: FieldIssue[] = failed.slice(0, 200).map((r) => ({ path: `row ${r.rowNumber}`, message: `Row ${r.rowNumber}${r.key ? ` (${r.key})` : ''}: ${r.messages.join('; ')}` }));
        throw new AppError(
          'VALIDATION',
          `${failed.length} of ${rows.length} record${rows.length === 1 ? '' : 's'} ${failed.length === 1 ? 'has' : 'have'} errors, so nothing was imported. Correct ${failed.length === 1 ? 'it' : 'them'}, or choose "Skip invalid rows".`,
          issues,
        );
      }
      const out: ImportCommitResult = {
        kind: input.kind,
        total: rows.length,
        created: rows.filter((r) => r.status !== 'error' && r.action === 'create').length,
        updated: rows.filter((r) => r.status !== 'error' && r.action === 'update').length,
        skipped: rows.filter((r) => r.action === 'skip').length,
        failed: failed.length,
        rows: rows.filter((r) => r.status === 'error' || r.status === 'duplicate'),
      };
      const now = ctx.clock.now().toISOString();
      const batchId = ictx.db.run('INSERT INTO import_batches (kind, file_name, imported_at, user_id, meta) VALUES (:kind, :file, :ts, :user, :meta)', {
        kind: VOUCHER_KINDS.has(input.kind) ? 'vouchers' : 'masters',
        file: input.fileName.slice(0, 255),
        ts: now,
        user: ctx.session.userId,
        meta: JSON.stringify({ importKind: input.kind, created: out.created, updated: out.updated, skipped: out.skipped, failed: out.failed }),
      }).lastInsertRowid;
      ictx.audit({
        action: 'import',
        entityType: 'import_batch',
        entityId: batchId,
        entityLabel: `${spec.label} from ${input.fileName}`.slice(0, 300),
        after: { kind: input.kind, file: input.fileName, total: out.total, created: out.created, updated: out.updated, skipped: out.skipped, failed: out.failed },
      });
      return out;
    });
    setProgress(ctx, { running: false, phase: 'done', done: total, total, message: 'Import finished.' });
    return result;
  } catch (err) {
    setProgress(ctx, { running: false, phase: 'failed', done: 0, total: 0, message: err instanceof AppError ? err.message : 'The import failed.' });
    throw err;
  }
}
