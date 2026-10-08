/**
 * Bank statement reader: bytes → table (CSV/TSV text or XLSX) → header row + column mapping (given, the
 * ledger's saved mapping, a bank preset or fuzzy captions) → statement lines in the bank's view
 * (deposit +, withdrawal −) with skipped-row reasons, running-balance check and dedupe hashes.
 * Pure (no DB): statements.ts adds duplicate detection and storage.
 */
import { parseCsv, sniffDelimiter } from '../../lib/csv.ts';
import { sha256Hex } from '../../lib/crypto.ts';
import { FileFormatError, decodeText } from '../../lib/text.ts';
import { readXlsx } from '../../lib/xlsx.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import type {
  BankPresetId,
  ParsedStatementLine,
  StatementAmountSign,
  StatementColumnMap,
  StatementColumnRole,
  StatementDateOrder,
  StatementDelimiter,
  StatementIssue,
  StatementMapping,
  StatementSummary,
} from '../../../shared/types/banking.ts';
import { STATEMENT_COLUMN_ROLES, STATEMENT_DELIMITERS } from '../../../shared/types/banking.ts';
import {
  detectPreset,
  fuzzyColumns,
  headerKey,
  isUsableColumns,
  locateHeaderRow,
  presetById,
  presetColumns,
  HEADER_SCAN_ROWS,
  type BankPreset,
} from './presets.ts';
import {
  cellText,
  cleanReference,
  detectDateOrder,
  parseDrCrIndicator,
  parseStatementAmount,
  parseStatementDate,
  squash,
  type Cell,
  type DateOrder,
} from './values.ts';

/** Largest statement file accepted (bytes). */
export const STATEMENT_MAX_BYTES = 20 * 1024 * 1024;
/** Most rows read from one sheet / text file. */
export const STATEMENT_MAX_ROWS = 200_000;
/** Most issues returned (the summary still counts every skipped row). */
const MAX_ISSUES = 500;

export interface StatementTable {
  name: string;
  rows: Cell[][];
}

export interface LoadedStatementFile {
  format: 'csv' | 'xlsx';
  encoding: string | null;
  tables: StatementTable[];
  /** Text files: the delimiter used for tables[0]; alternatives are tried by the detector. */
  delimiter: StatementDelimiter | null;
  /** Text files: the decoded text (re-parsed with other delimiters when no header is found). */
  text: string | null;
}

/** Column mapping remembered per bank ledger: roles by caption, so next month's file is found again. */
export interface SavedStatementMapping {
  v: 1;
  preset: BankPresetId;
  sheet: string | null;
  delimiter: StatementDelimiter | null;
  dateOrder: StatementDateOrder;
  amountSign: StatementAmountSign;
  /** role → [headerKey of the caption, occurrence of that caption in the header row (0-based)]. */
  headers: Partial<Record<StatementColumnRole, [string, number]>>;
}

const startsWith = (b: Uint8Array, sig: readonly number[]): boolean => sig.every((x, i) => b[i] === x);

/** Read the file into tables. Throws FileFormatError for files that are not CSV/TSV text or .xlsx. */
export function loadStatementFile(fileName: string, bytes: Uint8Array, delimiter?: StatementDelimiter | null): LoadedStatementFile {
  if (bytes.length === 0) throw new FileFormatError('statement', `${fileName} is empty.`);
  if (bytes.length > STATEMENT_MAX_BYTES) {
    throw new FileFormatError('statement', `${fileName} is larger than 20 MB. Download a shorter period (for example one month) and import it.`);
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const wb = readXlsx(bytes, { maxRows: STATEMENT_MAX_ROWS, maxCells: 5_000_000 });
    const tables = wb.sheets.map((s) => ({ name: s.name, rows: s.rows as Cell[][] })).filter((t) => t.rows.length > 0);
    if (tables.length === 0) throw new FileFormatError('statement', `${fileName} has no data in any worksheet.`);
    return { format: 'xlsx', encoding: null, tables, delimiter: null, text: null };
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    throw new FileFormatError(
      'statement',
      `${fileName} is an old Excel 97-2003 (.xls) workbook, which cannot be read directly. Open it in Excel and use "Save As" › Excel Workbook (.xlsx) or CSV, then import that file.`,
    );
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    throw new FileFormatError('statement', `${fileName} is a PDF. PDF statements cannot be imported; download the statement from net banking in Excel or CSV format.`);
  }
  const decoded = decodeText(bytes);
  const text = decoded.text;
  const head = text.slice(0, 2048).trimStart().toLowerCase();
  if (head.startsWith('<')) {
    const what = /urn:schemas-microsoft-com:office:spreadsheet|<workbook/.test(text.slice(0, 4096).toLowerCase())
      ? 'an Excel 2003 XML spreadsheet'
      : 'a web page (HTML table)';
    throw new FileFormatError(
      'statement',
      `${fileName} is ${what} saved with an Excel name — many banks download statements this way. ` +
        'Open it in Excel and use "Save As" › Excel Workbook (.xlsx) or CSV, or download the statement in CSV format, then import that file.',
    );
  }
  if (/[\u0000-\u0008\u000e-\u001a]/.test(text.slice(0, 4096))) {
    throw new FileFormatError('statement', `${fileName} is not a text (CSV) or Excel (.xlsx) file.`);
  }
  const used = delimiter ?? sniffDelimiter(text);
  const rows = parseCsv(text, { delimiter: used, maxRows: STATEMENT_MAX_ROWS });
  if (rows.length === 0) throw new FileFormatError('statement', `${fileName} is empty.`);
  return { format: 'csv', encoding: decoded.encoding, tables: [{ name: '', rows }], delimiter: used, text };
}

// ───────────────────────────── Mapping resolution ─────────────────────────────

export type DetectedBy = 'given' | 'saved' | 'preset' | 'auto';

export interface ResolvedLayout {
  table: StatementTable;
  delimiter: StatementDelimiter | null;
  preset: BankPreset;
  detectedBy: DetectedBy;
  mapping: StatementMapping | null;
}

function columnsFromSaved(header: readonly Cell[], saved: SavedStatementMapping): StatementColumnMap | null {
  const keys = header.map((c) => headerKey(c));
  const out: Partial<StatementColumnMap> = {};
  for (const role of STATEMENT_COLUMN_ROLES) {
    const spec = saved.headers[role];
    if (!spec) continue;
    const [name, occurrence] = spec;
    let seen = 0;
    let found = -1;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== name) continue;
      if (seen === occurrence) {
        found = i;
        break;
      }
      seen++;
    }
    if (found < 0) return null;
    (out as Record<string, number>)[role] = found;
  }
  return isUsableColumns(out) ? out : null;
}

function findSavedHeader(rows: readonly Cell[][], saved: SavedStatementMapping): { row: number; columns: StatementColumnMap } | null {
  const n = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < n; r++) {
    const cols = columnsFromSaved(rows[r] ?? [], saved);
    if (cols) return { row: r, columns: cols };
  }
  return null;
}

/** Saved mapping for a header row: each role remembered by caption and occurrence. */
export function toSavedMapping(mapping: StatementMapping, header: readonly Cell[]): SavedStatementMapping {
  const keys = header.map((c) => headerKey(c));
  const headers: SavedStatementMapping['headers'] = {};
  for (const role of STATEMENT_COLUMN_ROLES) {
    const idx = mapping.columns[role];
    if (idx === undefined || idx === null || idx >= keys.length || keys[idx] === '') continue;
    let occurrence = 0;
    for (let i = 0; i < idx; i++) if (keys[i] === keys[idx]) occurrence++;
    headers[role] = [keys[idx], occurrence];
  }
  return {
    v: 1,
    preset: mapping.preset,
    sheet: mapping.sheet ?? null,
    delimiter: mapping.delimiter ?? null,
    dateOrder: mapping.dateOrder,
    amountSign: mapping.amountSign ?? 'deposit_positive',
    headers,
  };
}

function cleanColumns(c: Partial<StatementColumnMap>): StatementColumnMap {
  const out: Partial<StatementColumnMap> = {};
  for (const role of STATEMENT_COLUMN_ROLES) {
    const v = c[role];
    if (v !== undefined && v !== null) (out as Record<string, number>)[role] = v;
  }
  return out as StatementColumnMap;
}

/** Problems with a mapping (column indexes, required roles); [] when it can be used. */
export function mappingProblems(mapping: StatementMapping, rowCount: number): string[] {
  const out: string[] = [];
  if (mapping.headerRow < 0 || mapping.headerRow >= rowCount) out.push(`The heading row ${mapping.headerRow + 1} is outside the file (it has ${rowCount} rows).`);
  const c = mapping.columns;
  const set = (v: number | null | undefined): boolean => v !== undefined && v !== null;
  const hasSplit = set(c.debit) || set(c.credit);
  const hasAmount = set(c.amount);
  if (!set(c.date)) out.push('Choose the Date column.');
  if (!hasSplit && !hasAmount) out.push('Choose the Withdrawal and Deposit columns, or a single Amount column.');
  if (hasSplit && hasAmount) out.push('Choose either Withdrawal/Deposit columns or a single Amount column, not both.');
  const seen = new Map<number, StatementColumnRole>();
  for (const role of STATEMENT_COLUMN_ROLES) {
    const idx = c[role];
    if (idx === undefined || idx === null) continue;
    const other = seen.get(idx);
    if (other) out.push(`Column ${idx + 1} is chosen both as ${ROLE_LABEL[other]} and as ${ROLE_LABEL[role]}.`);
    seen.set(idx, role);
  }
  return out;
}

export const ROLE_LABEL: Record<StatementColumnRole, string> = {
  date: 'Date',
  valueDate: 'Value Date',
  description: 'Narration',
  reference: 'Cheque/Ref. No.',
  debit: 'Withdrawal',
  credit: 'Deposit',
  amount: 'Amount',
  drCr: 'Dr/Cr',
  balance: 'Balance',
  balanceDrCr: 'Balance Dr/Cr',
};

interface Candidate {
  table: StatementTable;
  delimiter: StatementDelimiter | null;
}

function candidates(file: LoadedStatementFile, preferSheet: string | null): Candidate[] {
  if (file.format === 'xlsx') {
    const list = [...file.tables];
    if (preferSheet) list.sort((a, b) => (a.name === preferSheet ? -1 : b.name === preferSheet ? 1 : 0));
    return list.map((table) => ({ table, delimiter: null }));
  }
  const out: Candidate[] = [{ table: file.tables[0], delimiter: file.delimiter }];
  for (const d of STATEMENT_DELIMITERS) {
    if (d === file.delimiter || file.text === null) continue;
    try {
      const rows = parseCsv(file.text, { delimiter: d, maxRows: HEADER_SCAN_ROWS + 1 });
      if (rows.length > 0) out.push({ table: { name: '', rows }, delimiter: d });
    } catch {
      // An unterminated quote with this delimiter: not the right one.
    }
  }
  return out;
}

/** The full table for a candidate (alternative delimiters are first parsed only partially). */
function fullTable(file: LoadedStatementFile, c: Candidate): StatementTable {
  if (file.format === 'csv' && c.delimiter !== file.delimiter && file.text !== null && c.delimiter !== null) {
    return { name: '', rows: parseCsv(file.text, { delimiter: c.delimiter, maxRows: STATEMENT_MAX_ROWS }) };
  }
  return c.table;
}

/**
 * Decide the sheet / delimiter, header row and columns: the given mapping, else the ledger's saved mapping,
 * else the header row most like a statement heading (bank preset when its captions match, else fuzzy).
 * mapping is null when no heading row was found.
 */
export function resolveLayout(
  file: LoadedStatementFile,
  opts: { mapping?: StatementMapping; saved?: SavedStatementMapping | null; bankHint?: string | null; sheet?: string | null },
): ResolvedLayout {
  if (opts.mapping) {
    const m = opts.mapping;
    let table = file.tables[0];
    if (file.format === 'xlsx' && m.sheet) {
      const found = file.tables.find((t) => t.name === m.sheet);
      if (!found) throw new FileFormatError('statement', `The worksheet "${m.sheet}" is not in this file. Choose one of: ${file.tables.map((t) => t.name).join(', ')}.`);
      table = found;
    }
    const mapping: StatementMapping = {
      ...m,
      sheet: file.format === 'xlsx' ? table.name : null,
      delimiter: file.format === 'csv' ? file.delimiter : null,
      columns: cleanColumns(m.columns),
      amountSign: m.amountSign ?? 'deposit_positive',
    };
    const problems = mappingProblems(mapping, table.rows.length);
    if (problems.length > 0) throw new FileFormatError('statement', problems.join(' '));
    return { table, delimiter: file.delimiter, preset: presetById(m.preset), detectedBy: 'given', mapping };
  }

  let cands = candidates(file, opts.saved?.sheet ?? null);
  if (file.format === 'xlsx' && opts.sheet) {
    const wanted = opts.sheet;
    cands = cands.filter((c) => c.table.name === wanted);
    if (cands.length === 0) {
      throw new FileFormatError('statement', `The worksheet "${wanted}" is not in this file (or it is empty). Choose one of: ${file.tables.map((t) => t.name).join(', ')}.`);
    }
  }
  if (opts.saved) {
    for (const c of cands) {
      const hit = findSavedHeader(c.table.rows, opts.saved);
      if (!hit) continue;
      const table = fullTable(file, c);
      return {
        table,
        delimiter: c.delimiter,
        preset: presetById(opts.saved.preset),
        detectedBy: 'saved',
        mapping: {
          preset: opts.saved.preset,
          sheet: file.format === 'xlsx' ? table.name : null,
          delimiter: c.delimiter,
          headerRow: hit.row,
          columns: hit.columns,
          dateOrder: opts.saved.dateOrder,
          amountSign: opts.saved.amountSign,
        },
      };
    }
  }
  for (const c of cands) {
    const row = locateHeaderRow(c.table.rows);
    if (row < 0) continue;
    const header = c.table.rows[row];
    const preset = detectPreset(header, opts.bankHint ?? null);
    const cols = preset.id === 'generic' ? fuzzyColumns(header) : presetColumns(header, preset);
    if (!isUsableColumns(cols)) continue;
    const table = fullTable(file, c);
    return {
      table,
      delimiter: c.delimiter,
      preset,
      detectedBy: preset.id === 'generic' ? 'auto' : 'preset',
      mapping: {
        preset: preset.id,
        sheet: file.format === 'xlsx' ? table.name : null,
        delimiter: c.delimiter,
        headerRow: row,
        columns: cleanColumns(cols),
        dateOrder: 'auto',
        amountSign: 'deposit_positive',
      },
    };
  }
  return { table: cands[0].table, delimiter: cands[0].delimiter, preset: presetById('generic'), detectedBy: 'auto', mapping: null };
}

// ───────────────────────────── Line extraction ─────────────────────────────

export interface StatementLineDraft extends Omit<ParsedStatementLine, 'duplicate'> {
  /** Dedupe key (see lineHash). */
  hash: string;
}

export interface ExtractResult {
  lines: StatementLineDraft[];
  issues: StatementIssue[];
  summary: Omit<StatementSummary, 'duplicates'>;
  dateOrder: DateOrder;
}

const OPENING_RE = /^(opening\s*bal(ance)?|op\.?\s*bal(ance)?|balance\s*b\s*\/?\s*f|b\s*\/\s*f|brought\s*forward|balance\s*brought\s*forward|balance\s*as\s*on)\b/i;
const CLOSING_RE =
  /^(closing\s*bal(ance)?|cl\.?\s*bal(ance)?|balance\s*c\s*\/?\s*f|c\s*\/\s*f|carried\s*forward|balance\s*carried\s*forward|(grand\s*|page\s*|transaction\s*)?totals?|statement\s*summary|summary)\b/i;
const SEPARATOR_RE = /^[\s*\-=_~.#]+$/;

const isBlank = (c: Cell | undefined): boolean => c === null || c === undefined || (typeof c === 'string' && c.trim() === '');

function rowText(row: readonly Cell[]): string {
  const t = row
    .map((c) => cellText(c ?? null))
    .filter((s) => s !== '')
    .join(' | ');
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

const at = (row: readonly Cell[], idx: number | null | undefined): Cell => (idx === undefined || idx === null ? null : (row[idx] ?? null));

interface MoneyResult {
  amount: Paise | null;
  problem?: string;
}

function lineMoney(row: readonly Cell[], cols: StatementColumnMap, sign: StatementAmountSign): MoneyResult {
  const split = (cols.debit !== undefined && cols.debit !== null) || (cols.credit !== undefined && cols.credit !== null);
  if (split) {
    const dRaw = parseStatementAmount(at(row, cols.debit));
    const cRaw = parseStatementAmount(at(row, cols.credit));
    if (dRaw === undefined) return { amount: null, problem: `Unreadable withdrawal amount "${cellText(at(row, cols.debit))}"` };
    if (cRaw === undefined) return { amount: null, problem: `Unreadable deposit amount "${cellText(at(row, cols.credit))}"` };
    const w = Math.abs(dRaw?.value ?? 0);
    const d = Math.abs(cRaw?.value ?? 0);
    if (w > 0 && d > 0) return { amount: null, problem: 'Both the withdrawal and the deposit column have an amount' };
    if (w === 0 && d === 0) return { amount: null };
    return { amount: d > 0 ? d : -w };
  }
  const a = parseStatementAmount(at(row, cols.amount));
  if (a === undefined) return { amount: null, problem: `Unreadable amount "${cellText(at(row, cols.amount))}"` };
  if (a === null || a.value === 0) return { amount: null };
  const dir = parseDrCrIndicator(at(row, cols.drCr)) ?? a.drCr;
  if (dir === 'cr') return { amount: Math.abs(a.value) };
  if (dir === 'dr') return { amount: -Math.abs(a.value) };
  return { amount: sign === 'withdrawal_positive' ? -a.value : a.value };
}

function lineBalance(row: readonly Cell[], cols: StatementColumnMap): Paise | null {
  if (cols.balance === undefined || cols.balance === null) return null;
  const b = parseStatementAmount(at(row, cols.balance));
  if (!b) return null;
  const dir = parseDrCrIndicator(at(row, cols.balanceDrCr)) ?? b.drCr;
  if (dir === 'cr') return Math.abs(b.value);
  if (dir === 'dr') return -Math.abs(b.value);
  return b.value;
}

/** "Balance as on 01-Apr-2026 : 1,00,000.00 Cr" above the table (SBI and others). */
function preHeaderOpening(rows: readonly Cell[][], headerRow: number): Paise | null {
  for (let r = 0; r < headerRow; r++) {
    const row = rows[r] ?? [];
    const labelIdx = row.findIndex((c) => typeof c === 'string' && /(opening\s*balance|balance\s*as\s*on|balance\s*b\s*\/?\s*f)/i.test(c));
    if (labelIdx < 0) continue;
    const label = String(row[labelIdx]);
    const colon = label.lastIndexOf(':');
    const tail = colon >= 0 ? label.slice(colon + 1).trim() : '';
    const pick = (cell: Cell): Paise | null => {
      const a = parseStatementAmount(cell);
      if (!a) return null;
      return a.drCr === 'dr' ? -Math.abs(a.value) : a.drCr === 'cr' ? Math.abs(a.value) : a.value;
    };
    if (tail !== '') {
      const v = pick(tail);
      if (v !== null) return v;
    }
    for (let j = labelIdx + 1; j < row.length; j++) {
      if (isBlank(row[j]) || (typeof row[j] === 'string' && String(row[j]).trim() === ':')) continue;
      const v = pick(row[j]);
      if (v !== null) return v;
      break;
    }
  }
  return null;
}

/**
 * Reference as compared for dedupe: letters/digits only, and leading zeros dropped from an all-digit reference —
 * the same cheque reads '000501' in the CSV download but 501 in the Excel one (a number cell).
 */
export function referenceKey(reference: string): string {
  const k = squash(reference);
  return /^\d+$/.test(k) ? k.replace(/^0+(?=\d)/, '') : k;
}

function lineKey(l: { txnDate: string; amount: Paise; reference: string; description: string; balance: Paise | null }): string {
  return `${l.txnDate}|${l.amount}|${referenceKey(l.reference)}|${squash(l.description)}|${l.balance ?? ''}`;
}

/** Dedupe key of a line: SHA-256 of date|amount|reference key|normalised description|balance|occurrence. */
export function lineHash(l: { txnDate: string; amount: Paise; reference: string; description: string; balance: Paise | null }, occurrence: number): string {
  return sha256Hex(`${lineKey(l)}|${occurrence}`);
}

/** Read the transaction lines below the header row with a mapping. */
export function extractLines(rows: readonly Cell[][], mapping: StatementMapping): ExtractResult {
  const cols = mapping.columns;
  const header = rows[mapping.headerRow] ?? [];
  const issues: StatementIssue[] = [];
  let skipped = 0;
  const issue = (row: number, level: StatementIssue['level'], reason: string, cells: readonly Cell[], countSkip = true): void => {
    if (countSkip) skipped++;
    if (issues.length < MAX_ISSUES) issues.push({ row, level, reason, text: rowText(cells) });
  };

  const body = rows.slice(mapping.headerRow + 1);
  const dateOrder: DateOrder = mapping.dateOrder === 'auto' ? detectDateOrder(body.map((r) => at(r, cols.date))) : mapping.dateOrder;
  const sign = mapping.amountSign ?? 'deposit_positive';
  const headerDateKey = headerKey(at(header, cols.date));

  type Raw = Omit<StatementLineDraft, 'seq' | 'hash'>;
  const raw: Raw[] = [];
  let opening: Paise | null = preHeaderOpening(rows, mapping.headerRow);
  let closing: Paise | null = null;
  let footer = false;

  for (let i = 0; i < body.length; i++) {
    const row = body[i] ?? [];
    const rowNo = mapping.headerRow + 2 + i;
    if (row.every(isBlank)) continue;
    const nonBlank = row.filter((c) => !isBlank(c));
    if (nonBlank.every((c) => typeof c === 'string' && SEPARATOR_RE.test(c))) {
      issue(rowNo, 'info', 'Separator row', row);
      continue;
    }
    if (headerDateKey !== '' && headerKey(at(row, cols.date)) === headerDateKey) {
      issue(rowNo, 'info', 'Repeated heading row', row);
      continue;
    }
    const dateCell = at(row, cols.date);
    const description = cellText(at(row, cols.description));
    const label = description || cellText(nonBlank.find((c) => typeof c === 'string' && /[a-z]/i.test(c)) ?? null);
    const date = parseStatementDate(dateCell, dateOrder);
    const money = lineMoney(row, cols, sign);
    const summaryKind = OPENING_RE.test(label) ? 'opening' : CLOSING_RE.test(label) ? 'closing' : null;

    if (summaryKind && (date === null || money.amount === null)) {
      const bal = lineBalance(row, cols) ?? (money.amount !== null ? money.amount : null);
      if (summaryKind === 'opening') {
        if (bal !== null && raw.length === 0) opening = bal;
        issue(rowNo, 'info', 'Opening balance row', row);
      } else {
        if (bal !== null && /bal|c\s*\/\s*f|carried/i.test(label)) closing = bal;
        if (raw.length > 0) footer = true;
        issue(rowNo, 'info', 'Closing balance / total row', row);
      }
      continue;
    }

    if (date === null) {
      const dateBlank = isBlank(dateCell);
      if (dateBlank && money.amount === null && !money.problem && description !== '' && raw.length > 0 && !footer) {
        const prev = raw[raw.length - 1];
        prev.description = `${prev.description} ${description}`.trim().slice(0, 1000);
        issue(rowNo, 'info', 'Narration continued from the previous row', row, false);
        continue;
      }
      const text = cellText(dateCell);
      if (footer) issue(rowNo, 'info', 'Statement footer', row);
      else if (!dateBlank && /\d/.test(text)) issue(rowNo, 'warning', `Unreadable date "${text}"`, row);
      else if (money.amount !== null) issue(rowNo, 'warning', 'Amount without a date', row);
      else issue(rowNo, 'info', 'Not a transaction row', row);
      continue;
    }
    if (money.problem) {
      issue(rowNo, 'warning', money.problem, row);
      continue;
    }
    if (money.amount === null) {
      issue(rowNo, description === '' ? 'info' : 'warning', 'No withdrawal or deposit amount', row);
      continue;
    }
    const valueDate = parseStatementDate(at(row, cols.valueDate), dateOrder);
    raw.push({
      row: rowNo,
      txnDate: date,
      valueDate,
      description: description.slice(0, 1000),
      reference: cleanReference(at(row, cols.reference)),
      amount: money.amount,
      balance: lineBalance(row, cols),
    });
  }

  // Chronological order: a statement whose first date is later than its last lists the newest first.
  let descending = false;
  if (raw.length > 1) {
    const first = raw[0].txnDate;
    const last = raw[raw.length - 1].txnDate;
    if (first > last) descending = true;
    else if (first === last) descending = balanceFits(raw.slice().reverse()) > balanceFits(raw);
  }
  const chrono = descending ? raw.slice().reverse() : raw;

  const occurrences = new Map<string, number>();
  const lines: StatementLineDraft[] = chrono.map((l, seq) => {
    const key = lineKey(l);
    const occ = occurrences.get(key) ?? 0;
    occurrences.set(key, occ + 1);
    return { ...l, seq, hash: lineHash(l, occ) };
  });

  // Running-balance check.
  let checked = 0;
  let mismatches = 0;
  let swappedOk = 0;
  let firstMismatchRow: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].balance;
    const cur = lines[i].balance;
    if (prev === null || cur === null) continue;
    checked++;
    if (prev + lines[i].amount !== cur) {
      mismatches++;
      if (prev - lines[i].amount === cur) swappedOk++;
      if (firstMismatchRow === null) firstMismatchRow = lines[i].row;
      if (mismatches <= 5) {
        issues.push({
          row: lines[i].row,
          level: 'warning',
          reason: `Running balance does not agree: previous balance ${formatMoney(prev)} ${lines[i].amount >= 0 ? '+' : '−'} ${formatMoney(Math.abs(lines[i].amount))} ≠ ${formatMoney(cur)}`,
          text: '',
        });
      }
    }
  }
  const swappedLikely = mismatches > 0 && checked >= 2 && swappedOk >= Math.ceil(mismatches * 0.8);

  if (opening === null && lines.length > 0 && lines[0].balance !== null) opening = lines[0].balance - lines[0].amount;
  if (closing === null && lines.length > 0) closing = lines[lines.length - 1].balance;

  let depositCount = 0;
  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const l of lines) {
    if (l.amount > 0) {
      depositCount++;
      totalDeposits += l.amount;
    } else totalWithdrawals -= l.amount;
    if (from === null || l.txnDate < from) from = l.txnDate;
    if (to === null || l.txnDate > to) to = l.txnDate;
  }
  return {
    lines,
    issues: issues.sort((a, b) => a.row - b.row),
    dateOrder,
    summary: {
      lineCount: lines.length,
      depositCount,
      withdrawalCount: lines.length - depositCount,
      totalDeposits,
      totalWithdrawals,
      from,
      to,
      openingBalance: opening,
      closingBalance: closing,
      order: descending ? 'descending' : 'ascending',
      balanceCheck: { checked, mismatches, firstMismatchRow, swappedLikely },
      skippedRows: skipped,
    },
  };
}

function balanceFits(lines: ReadonlyArray<{ amount: Paise; balance: Paise | null }>): number {
  let ok = 0;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].balance;
    const cur = lines[i].balance;
    if (prev !== null && cur !== null && prev + lines[i].amount === cur) ok++;
  }
  return ok;
}

/** "Account Number", "A/C No.", "Acct No", "Account #" — not "Account Name" / "Account Statement". */
const ACCOUNT_LABEL_RE = /\b(?:a\/c|acc(?:oun)?t|account)\.?\s*(?:no\b\.?|number|num\b|#)/i;

/**
 * Account numbers printed above the heading row ("Account Number : 00000012345678901", "A/C No. XXXXXXXX5678"),
 * as written (masked digits kept). Used to warn when a statement is imported into another bank ledger.
 */
export function statementAccountNumbers(rows: readonly Cell[][], headerRow: number): string[] {
  const out: string[] = [];
  const token = (cell: Cell | undefined): string | null => {
    if (typeof cell === 'number' && !Number.isSafeInteger(cell)) return null; // digits lost in a number cell
    const m = /[0-9Xx*]*\d{4,}/.exec(cellText(cell ?? null).replace(/[\s-]/g, ''));
    return m && m[0].length >= 6 ? m[0] : null;
  };
  for (let r = 0; r < Math.min(headerRow, HEADER_SCAN_ROWS); r++) {
    const row = rows[r] ?? [];
    for (let j = 0; j < row.length; j++) {
      const c = row[j];
      if (typeof c !== 'string') continue;
      const label = ACCOUNT_LABEL_RE.exec(c);
      if (!label) continue;
      let found = token(c.slice(label.index + label[0].length));
      for (let k = j + 1; found === null && k < row.length; k++) {
        if (isBlank(row[k]) || (typeof row[k] === 'string' && String(row[k]).trim() === ':')) continue;
        found = token(row[k]);
        break;
      }
      if (found !== null && !out.includes(found)) out.push(found);
    }
  }
  return out;
}

/**
 * null when the file names no account number, the ledger has none, or one of them ends with the ledger's last
 * 4 digits; else the last 4 digits the file shows (the statement is probably of another account).
 */
export function accountMismatch(fileAccounts: readonly string[], ledgerAccountNo: string | null): string | null {
  const ledgerDigits = (ledgerAccountNo ?? '').replace(/\D/g, '');
  if (ledgerDigits.length < 4 || fileAccounts.length === 0) return null;
  const want = ledgerDigits.slice(-4);
  const tails = fileAccounts.map((a) => (/\d+$/.exec(a)?.[0] ?? '').slice(-4)).filter((t) => t.length === 4);
  if (tails.length === 0 || tails.includes(want)) return null;
  return tails[0];
}

/** First rows of a table as text for the mapping screen (≤ 40 rows × 30 columns, cells ≤ 100 characters). */
export function rawPreview(rows: readonly Cell[][]): string[][] {
  return rows.slice(0, 40).map((r) => r.slice(0, 30).map((c) => {
    const t = cellText(c ?? null);
    return t.length > 100 ? `${t.slice(0, 99)}…` : t;
  }));
}

export interface ParsedStatement {
  file: LoadedStatementFile;
  layout: ResolvedLayout;
  headers: string[];
  extract: ExtractResult | null;
}

/** Load + resolve + extract. extract is null when no heading row was found (mapping null). */
export function parseStatement(
  fileName: string,
  bytes: Uint8Array,
  opts: { mapping?: StatementMapping; saved?: SavedStatementMapping | null; bankHint?: string | null; sheet?: string | null } = {},
): ParsedStatement {
  const file = loadStatementFile(fileName, bytes, opts.mapping?.delimiter ?? null);
  const layout = resolveLayout(file, opts);
  if (!layout.mapping) return { file, layout, headers: [], extract: null };
  const header = layout.table.rows[layout.mapping.headerRow] ?? [];
  const extract = extractLines(layout.table.rows, layout.mapping);
  return { file, layout, headers: header.map((c) => cellText(c ?? null)), extract };
}
