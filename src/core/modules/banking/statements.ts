/**
 * Bank statement import: preview (no writes), import (batch + lines, dedupe, saved mapping), line listing,
 * batch listing and batch deletion. File parsing lives in parse.ts.
 */
import { parseAmount } from '../../../shared/money.ts';
import type {
  BankPresetId,
  BankPresetInfo,
  DeleteBatchResult,
  StatementBatch,
  StatementImportInput,
  StatementImportResult,
  StatementLineStatus,
  StatementLinesInput,
  StatementLinesResult,
  StatementPreview,
  StatementPreviewInput,
} from '../../../shared/types/banking.ts';
import { STATEMENT_PREVIEW_MAX_LINES } from '../../../shared/types/banking.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule } from '../../lib/errors.ts';
import {
  LINE_SELECT,
  bankHint,
  fmtDate,
  healOrphanLines,
  lineViews,
  money,
  requireBankLedger,
  unlinkLine,
  assertBankDateChangeAllowed,
  type BankLedger,
  type LineRow,
} from './common.ts';
import {
  accountMismatch,
  parseStatement,
  rawPreview,
  statementAccountNumbers,
  toSavedMapping,
  type ExtractResult,
  type ParsedStatement,
  type SavedStatementMapping,
} from './parse.ts';
import { BANK_PRESETS, presetById, presetInfo } from './presets.ts';

export function listPresets(): BankPresetInfo[] {
  return BANK_PRESETS.map(presetInfo);
}

// ───────────────────────────── Saved mapping per ledger ─────────────────────────────

export function loadSavedMapping(db: Db, ledgerId: number): SavedStatementMapping | null {
  const raw = db.value<string>('SELECT mapping FROM bank_statement_presets WHERE ledger_id = :l', { l: ledgerId });
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as SavedStatementMapping;
    return m && m.v === 1 && typeof m.headers === 'object' ? m : null;
  } catch {
    return null;
  }
}

function saveMapping(db: Db, ledgerId: number, mapping: SavedStatementMapping, now: string): void {
  db.run(
    `INSERT INTO bank_statement_presets (ledger_id, mapping, updated_at) VALUES (:l, :m, :now)
     ON CONFLICT(ledger_id) DO UPDATE SET mapping = excluded.mapping, updated_at = excluded.updated_at`,
    { l: ledgerId, m: JSON.stringify(mapping), now },
  );
}

/** Hashes among `hashes` already imported for the ledger. */
function existingHashes(db: Db, ledgerId: number, hashes: readonly string[]): Set<string> {
  const out = new Set<string>();
  const CHUNK = 5000;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    for (const r of db.all<{ line_hash: string }>(
      `SELECT line_hash FROM bank_statement_lines WHERE ledger_id = :l AND line_hash IN (SELECT value FROM json_each(:h))`,
      { l: ledgerId, h: JSON.stringify(hashes.slice(i, i + CHUNK)) },
    )) {
      out.add(r.line_hash);
    }
  }
  return out;
}

/** The company's books-beginning date (statement lines before it are already in the opening balance). */
export function booksFrom(db: Db): string | null {
  return db.value<string>('SELECT books_from FROM company WHERE id = 1') ?? null;
}

/**
 * Statement lines dated before the books begin are already part of the bank ledger's opening balance: importing
 * them would only add lines that can never be matched and would distort "amounts not in the books". They are
 * skipped with a reason; the summary counts are recomputed (file-level opening/closing balance and the
 * running-balance check stay as read).
 */
export function dropBeforeBooks(extract: ExtractResult, from: string | null): ExtractResult {
  if (!from) return extract;
  const early = extract.lines.filter((l) => l.txnDate < from);
  if (early.length === 0) return extract;
  const lines = extract.lines.filter((l) => l.txnDate >= from);
  const reason = `Dated before the books begin (${fmtDate(from)}) — already part of the opening balance`;
  const issues = [
    ...extract.issues,
    ...early.slice(0, 500).map((l) => ({
      row: l.row,
      level: 'info' as const,
      reason,
      text: `${fmtDate(l.txnDate)} | ${l.description} | ${l.amount >= 0 ? 'deposit' : 'withdrawal'} ${money(Math.abs(l.amount))}`.slice(0, 200),
    })),
  ].sort((a, b) => a.row - b.row);
  let depositCount = 0;
  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const l of lines) {
    if (l.amount > 0) {
      depositCount++;
      totalDeposits += l.amount;
    } else totalWithdrawals -= l.amount;
    if (first === null || l.txnDate < first) first = l.txnDate;
    if (last === null || l.txnDate > last) last = l.txnDate;
  }
  return {
    ...extract,
    lines,
    issues,
    summary: {
      ...extract.summary,
      lineCount: lines.length,
      depositCount,
      withdrawalCount: lines.length - depositCount,
      totalDeposits,
      totalWithdrawals,
      from: first,
      to: last,
      skippedRows: extract.summary.skippedRows + early.length,
    },
  };
}

/** Warning when the file names another account number than the bank ledger's (see accountMismatch). */
function accountWarningFor(parsed: ParsedStatement, bank: BankLedger): string | null {
  const mapping = parsed.layout.mapping;
  if (!mapping) return null;
  const tail = accountMismatch(statementAccountNumbers(parsed.layout.table.rows, mapping.headerRow), bank.accountNo);
  if (tail === null) return null;
  const own = (bank.accountNo ?? '').replace(/\D/g, '').slice(-4);
  return (
    `This statement is for account no. ending ${tail}, but ${bank.name} is account no. ending ${own}. ` +
    'Check that you chose the right bank account before importing — lines imported into the wrong bank would have to be deleted again.'
  );
}

// ───────────────────────────── Preview ─────────────────────────────

export function previewStatement(db: Db, input: StatementPreviewInput): StatementPreview {
  const bank = requireBankLedger(db, input.ledgerId, 'Statement import');
  const parsed = parseStatement(input.fileName, input.bytes, {
    mapping: input.mapping,
    saved: input.mapping ? null : loadSavedMapping(db, bank.id),
    bankHint: bankHint(bank),
    sheet: input.mapping ? null : (input.sheet ?? null),
  });
  const { file, layout } = parsed;
  const extract = parsed.extract ? dropBeforeBooks(parsed.extract, booksFrom(db)) : null;
  const base = {
    format: file.format,
    encoding: file.encoding,
    sheets: file.format === 'xlsx' ? file.tables.map((t) => t.name) : [],
    sheet: file.format === 'xlsx' ? layout.table.name : null,
    preset: presetInfo(layout.preset),
    detectedBy: layout.detectedBy,
    mapping: layout.mapping,
    headers: parsed.headers,
    rawPreview: rawPreview(layout.table.rows),
    accountWarning: accountWarningFor(parsed, bank),
  };
  if (!extract) {
    return {
      ...base,
      dateOrder: 'dmy',
      lines: [],
      truncated: false,
      issues: [
        {
          row: 0,
          level: 'warning',
          reason:
            'The column headings (Date, Narration, Withdrawal, Deposit, Balance …) were not found in the first 80 rows. ' +
            'Choose the heading row and the columns, or check that this is a bank statement.',
          text: '',
        },
      ],
      summary: {
        lineCount: 0,
        depositCount: 0,
        withdrawalCount: 0,
        totalDeposits: 0,
        totalWithdrawals: 0,
        from: null,
        to: null,
        openingBalance: null,
        closingBalance: null,
        order: 'ascending',
        balanceCheck: { checked: 0, mismatches: 0, firstMismatchRow: null, swappedLikely: false },
        duplicates: 0,
        skippedRows: 0,
      },
    };
  }
  const dupes = existingHashes(
    db,
    bank.id,
    extract.lines.map((l) => l.hash),
  );
  const truncated = extract.lines.length > STATEMENT_PREVIEW_MAX_LINES;
  const lines = extract.lines.slice(0, STATEMENT_PREVIEW_MAX_LINES).map(({ hash, ...l }) => ({ ...l, duplicate: dupes.has(hash) }));
  return {
    ...base,
    dateOrder: extract.dateOrder,
    lines,
    truncated,
    issues: extract.issues,
    summary: { ...extract.summary, duplicates: dupes.size },
  };
}

// ───────────────────────────── Import ─────────────────────────────

export function importStatement(ctx: CompanyCtx, input: StatementImportInput): StatementImportResult {
  const { db } = ctx;
  const bank = requireBankLedger(db, input.ledgerId, 'Statement import');
  // Parse outside the write transaction (large files), then write everything atomically.
  const parsed = parseStatement(input.fileName, input.bytes, { mapping: input.mapping, bankHint: bankHint(bank) });
  const mapping = parsed.layout.mapping;
  if (!parsed.extract || !mapping) throw rule('Choose the heading row and the columns of the statement first.');
  const from = booksFrom(db);
  const extract = dropBeforeBooks(parsed.extract, from);
  if (extract.lines.length === 0 && parsed.extract.lines.length > 0) {
    throw rule(
      `Every transaction in ${input.fileName} is dated before the books begin (${fmtDate(from)}); those amounts are already in the opening balance of ${bank.name}. Download the statement from ${fmtDate(from)} onwards.`,
    );
  }
  if (extract.lines.length === 0) {
    throw rule(
      `No transactions were found in ${input.fileName} with this column mapping. Check the heading row and the Date / Withdrawal / Deposit (or Amount) columns.`,
    );
  }
  const header = parsed.layout.table.rows[mapping.headerRow] ?? [];
  const now = ctx.clock.now().toISOString();
  const s = extract.summary;

  return db.transaction(() => {
    healOrphanLines(db, bank.id);
    const existing = existingHashes(
      db,
      bank.id,
      extract.lines.map((l) => l.hash),
    );
    const fresh = extract.lines.filter((l) => !existing.has(l.hash));
    saveMapping(db, bank.id, toSavedMapping(mapping, header), now);
    let deposits = 0;
    let withdrawals = 0;
    for (const l of fresh) {
      if (l.amount > 0) deposits += l.amount;
      else withdrawals -= l.amount;
    }
    if (fresh.length === 0) {
      return {
        batchId: null,
        imported: 0,
        duplicates: existing.size,
        skippedRows: s.skippedRows,
        from: s.from,
        to: s.to,
        totalDeposits: 0,
        totalWithdrawals: 0,
        closingBalance: s.closingBalance,
      };
    }
    const meta = {
      ledgerId: bank.id,
      preset: mapping.preset,
      format: parsed.file.format,
      from: s.from,
      to: s.to,
      openingBalance: s.openingBalance,
      closingBalance: s.closingBalance,
      duplicates: existing.size,
      skipped: s.skippedRows,
      importedByName: ctx.session.displayName || ctx.session.username || null,
    };
    const batchId = db.run(
      `INSERT INTO import_batches (kind, file_name, imported_at, user_id, meta) VALUES ('bank_statement', :f, :now, :u, :meta)`,
      { f: input.fileName.slice(0, 260), now, u: ctx.session.userId, meta: JSON.stringify(meta) },
    ).lastInsertRowid;
    for (const l of fresh) {
      db.run(
        `INSERT INTO bank_statement_lines
           (batch_id, ledger_id, txn_date, value_date, description, reference, amount, balance, status, line_hash, seq, source_row)
         VALUES (:b, :l, :d, :vd, :desc, :ref, :amt, :bal, 'unmatched', :h, :seq, :row)`,
        {
          b: batchId,
          l: bank.id,
          d: l.txnDate,
          vd: l.valueDate,
          desc: l.description,
          ref: l.reference,
          amt: l.amount,
          bal: l.balance,
          h: l.hash,
          seq: l.seq,
          row: l.row,
        },
      );
    }
    ctx.audit({
      action: 'import',
      entityType: 'bank_statement',
      entityId: batchId,
      entityLabel: `Bank statement ${input.fileName} → ${bank.name}`,
      after: { ledgerId: bank.id, lines: fresh.length, duplicates: existing.size, from: s.from, to: s.to, deposits, withdrawals, preset: mapping.preset },
    });
    return {
      batchId,
      imported: fresh.length,
      duplicates: existing.size,
      skippedRows: s.skippedRows,
      from: s.from,
      to: s.to,
      totalDeposits: deposits,
      totalWithdrawals: withdrawals,
      closingBalance: s.closingBalance,
    };
  });
}

// ───────────────────────────── Listing ─────────────────────────────

const STATUS_SQL: Record<StatementLineStatus, string> = {
  unmatched: `(s.status = 'unmatched' OR (s.status IN ('matched', 'created') AND s.matched_entry_id IS NULL))`,
  matched: `(s.status = 'matched' AND s.matched_entry_id IS NOT NULL)`,
  created: `(s.status = 'created' AND s.matched_entry_id IS NOT NULL)`,
  ignored: `s.status = 'ignored'`,
};

const EFFECTIVE_STATUS = `CASE WHEN s.status IN ('matched', 'created') AND s.matched_entry_id IS NULL THEN 'unmatched' ELSE s.status END`;

const zeroCounts = (): Record<StatementLineStatus, number> => ({ unmatched: 0, matched: 0, created: 0, ignored: 0 });

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function statementLines(db: Db, input: StatementLinesInput): StatementLinesResult {
  requireBankLedger(db, input.ledgerId, 'Bank statement lines');
  const params: Record<string, string | number> = { l: input.ledgerId, from: input.from, to: input.to };
  const base = ['s.ledger_id = :l', 's.txn_date >= :from', 's.txn_date <= :to'];
  const where = [...base];
  if (input.batchId !== undefined) {
    where.push('s.batch_id = :batch');
    params.batch = input.batchId;
  }
  const status = input.status ?? 'all';
  if (status !== 'all') where.push(STATUS_SQL[status]);
  const search = input.search?.trim();
  if (search) {
    const amount = parseAmount(search);
    params.q = `%${likeEscape(search.toLowerCase())}%`;
    if (amount !== null && amount !== 0) {
      params.amt = Math.abs(amount);
      where.push(`(lower(s.description) LIKE :q ESCAPE '\\' OR lower(s.reference) LIKE :q ESCAPE '\\' OR abs(s.amount) = :amt)`);
    } else {
      where.push(`(lower(s.description) LIKE :q ESCAPE '\\' OR lower(s.reference) LIKE :q ESCAPE '\\')`);
    }
  }
  const w = where.join(' AND ');
  const agg = db.get<{ n: number; dep: number | null; wd: number | null }>(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN s.amount > 0 THEN s.amount ELSE 0 END) AS dep,
            SUM(CASE WHEN s.amount < 0 THEN -s.amount ELSE 0 END) AS wd
       FROM bank_statement_lines s WHERE ${w}`,
    params,
  );
  const limit = input.limit ?? 5000;
  const offset = input.offset ?? 0;
  const rows = db.all<LineRow>(`${LINE_SELECT} WHERE ${w} ORDER BY s.txn_date, s.batch_id, s.seq, s.id LIMIT :limit OFFSET :offset`, {
    ...params,
    limit,
    offset,
  });
  const counts = zeroCounts();
  for (const r of db.all<{ st: string; n: number }>(
    `SELECT ${EFFECTIVE_STATUS} AS st, COUNT(*) AS n FROM bank_statement_lines s WHERE ${base.join(' AND ')} GROUP BY st`,
    { l: input.ledgerId, from: input.from, to: input.to },
  )) {
    if (r.st in counts) counts[r.st as StatementLineStatus] += r.n;
  }
  return { rows: lineViews(db, rows), total: agg?.n ?? 0, counts, totals: { deposits: agg?.dep ?? 0, withdrawals: agg?.wd ?? 0 } };
}

interface BatchRow {
  id: number;
  file_name: string | null;
  imported_at: string;
  user_id: number | null;
  meta: string | null;
  user_name: string | null;
}

interface BatchMeta {
  ledgerId?: number;
  preset?: BankPresetId;
  format?: 'csv' | 'xlsx';
  from?: string | null;
  to?: string | null;
  openingBalance?: number | null;
  closingBalance?: number | null;
  duplicates?: number;
  importedByName?: string | null;
}

function parseMeta(raw: string | null): BatchMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as BatchMeta;
  } catch {
    return {};
  }
}

export function statementBatches(db: Db, ledgerId?: number): StatementBatch[] {
  const rows = db.all<BatchRow>(
    `SELECT b.id, b.file_name, b.imported_at, b.user_id, b.meta, u.display_name AS user_name
       FROM import_batches b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.kind = 'bank_statement' ${ledgerId !== undefined ? `AND json_extract(b.meta, '$.ledgerId') = :l` : ''}
      ORDER BY b.imported_at DESC, b.id DESC`,
    ledgerId !== undefined ? { l: ledgerId } : {},
  );
  if (rows.length === 0) return [];
  const ids = JSON.stringify(rows.map((r) => r.id));
  const stats = new Map<number, { n: number; dep: number; wd: number; counts: Record<StatementLineStatus, number> }>();
  for (const r of db.all<{ batch_id: number; st: string; n: number; dep: number | null; wd: number | null }>(
    `SELECT s.batch_id, ${EFFECTIVE_STATUS} AS st, COUNT(*) AS n,
            SUM(CASE WHEN s.amount > 0 THEN s.amount ELSE 0 END) AS dep, SUM(CASE WHEN s.amount < 0 THEN -s.amount ELSE 0 END) AS wd
       FROM bank_statement_lines s WHERE s.batch_id IN (SELECT value FROM json_each(:ids)) GROUP BY s.batch_id, st`,
    { ids },
  )) {
    const st = stats.get(r.batch_id) ?? { n: 0, dep: 0, wd: 0, counts: zeroCounts() };
    st.n += r.n;
    st.dep += r.dep ?? 0;
    st.wd += r.wd ?? 0;
    if (r.st in st.counts) st.counts[r.st as StatementLineStatus] += r.n;
    stats.set(r.batch_id, st);
  }
  const names = new Map(db.all<{ id: number; name: string }>('SELECT id, name FROM ledgers').map((l) => [l.id, l.name]));
  return rows.map((r) => {
    const m = parseMeta(r.meta);
    const st = stats.get(r.id) ?? { n: 0, dep: 0, wd: 0, counts: zeroCounts() };
    const preset = presetById(m.preset ?? 'generic');
    return {
      id: r.id,
      ledgerId: m.ledgerId ?? 0,
      ledgerName: names.get(m.ledgerId ?? 0) ?? '',
      fileName: r.file_name,
      importedAt: r.imported_at,
      importedBy: r.user_name ?? m.importedByName ?? null,
      preset: preset.id,
      presetName: preset.name,
      format: m.format ?? 'csv',
      from: m.from ?? null,
      to: m.to ?? null,
      lineCount: st.n,
      counts: st.counts,
      totalDeposits: st.dep,
      totalWithdrawals: st.wd,
      openingBalance: m.openingBalance ?? null,
      closingBalance: m.closingBalance ?? null,
      duplicatesSkipped: m.duplicates ?? 0,
    };
  });
}

export function deleteBatch(ctx: CompanyCtx, batchId: number, unmatch: boolean): DeleteBatchResult {
  const { db } = ctx;
  const batch = db.get<BatchRow>(
    `SELECT b.id, b.file_name, b.imported_at, b.user_id, b.meta, NULL AS user_name FROM import_batches b WHERE b.id = :id AND b.kind = 'bank_statement'`,
    { id: batchId },
  );
  if (!batch) throw notFound('Bank statement import', batchId);
  const linked = db.all<{ id: number; matched_entry_id: number }>(
    `SELECT s.id, s.matched_entry_id FROM bank_statement_lines s
      WHERE s.batch_id = :id AND s.status IN ('matched', 'created') AND s.matched_entry_id IS NOT NULL`,
    { id: batchId },
  );
  if (linked.length > 0 && !unmatch) {
    throw rule(
      `${linked.length} line${linked.length === 1 ? '' : 's'} of this statement ${linked.length === 1 ? 'is' : 'are'} reconciled with vouchers. ` +
        'Unmatch them first, or delete the statement with "unmatch" so their bank dates are cleared as well.',
      { linked: linked.length },
    );
  }
  // Unmatching clears the entries' bank dates: one in the locked period needs period.lock (common.ts).
  for (const l of linked) {
    const bankDate = db.value<string>('SELECT bank_date FROM ledger_entries WHERE id = :id', { id: l.matched_entry_id }) ?? null;
    assertBankDateChangeAllowed(ctx, bankDate, null, () => `Deleting this statement with "unmatch"`);
  }
  for (const l of linked) unlinkLine(db, l);
  const meta = parseMeta(batch.meta);
  const deleted = db.run('DELETE FROM bank_statement_lines WHERE batch_id = :id', { id: batchId }).changes;
  db.run('DELETE FROM import_batches WHERE id = :id', { id: batchId });
  const ledgerName = db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id: meta.ledgerId ?? 0 }) ?? '';
  ctx.audit({
    action: 'delete',
    entityType: 'bank_statement',
    entityId: batchId,
    entityLabel: `Bank statement ${batch.file_name ?? ''} → ${ledgerName}`.trim(),
    before: { ledgerId: meta.ledgerId ?? null, lines: deleted, unmatched: linked.length, from: meta.from ?? null, to: meta.to ?? null },
  });
  return { batchId, deletedLines: deleted, unmatched: linked.length };
}
