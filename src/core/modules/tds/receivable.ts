/**
 * TDS deducted by customers (TDS receivable) vs Form 26AS / AIS.
 *
 * Books: debits to the ledgers marked "TDS receivable" (TDS/TCS › Ledger details, or the 'TDS
 * Receivable' ledger the module creates) in the income-tax year, per customer = the party of the
 * voucher (typically a Receipt: Dr Bank, Dr TDS Receivable, Cr Customer).
 * 26AS: a CSV the user prepares from Form 26AS Part I / AIS (TRACES downloads are text/PDF/JSON whose
 * layout changes — see README): one row per deductor transaction with the columns named below. Rows
 * are matched to customers by the customer's deductor TAN (TDS details), else by name.
 */
import { randomUUID } from 'node:crypto';
import { isValidDate, toIso } from '../../../shared/dates.ts';
import { parseAmount, type Paise } from '../../../shared/money.ts';
import { TAN_RE, taxYear } from '../../../shared/tds/rules.ts';
import type { TdsReceivableResult, TdsReceivableRow } from '../../../shared/types/tds.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { headerKeys, parseCsv } from '../../lib/csv.ts';
import { validation } from '../../lib/errors.ts';

/** Accepted header names (normalised: lower case, single spaces) per field. */
export const FORM26AS_COLUMNS: Readonly<Record<'tan' | 'name' | 'section' | 'date' | 'amountPaid' | 'tds', readonly string[]>> = {
  tan: ['tan', 'tan of deductor', 'deductor tan', 'tan of deductor/collector'],
  name: ['name', 'name of deductor', 'deductor name', 'deductor', 'name of deductor/collector'],
  section: ['section', 'section code', 'section 1'],
  date: ['transaction date', 'date', 'date of payment/credit', 'date of payment', 'date of credit', 'transaction date (dd-mmm-yyyy)'],
  amountPaid: ['amount paid/credited', 'amount paid / credited', 'amount paid', 'amount credited', 'amount'],
  tds: ['tax deducted', 'tds deposited', 'tax deposited', 'tds', 'tds amount', 'tax deducted at source'],
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** 'YYYY-MM-DD', 'DD-MM-YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY', 'DD-Mon-YYYY' → ISO, else null. */
export function parseStatementDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return isValidDate(s) ? s : null;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) {
    const iso = toIso(Number(m[3]), Number(m[2]), Number(m[1]));
    return isValidDate(iso) ? iso : null;
  }
  m = /^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const iso = toIso(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
    return isValidDate(iso) ? iso : null;
  }
  return null;
}

export interface Form26asRow {
  tan: string | null;
  name: string;
  section: string | null;
  date: string;
  amountPaid: Paise;
  tds: Paise;
}

/** Parse the CSV; every problem is reported with its row number (VALIDATION). */
export function parseForm26asCsv(text: string): Form26asRow[] {
  const rows = parseCsv(text, { delimiter: 'auto', skipEmptyRows: true, maxRows: 50_001 });
  if (rows.length < 2) throw validation([{ path: 'content', message: 'The file has no rows below the header.' }]);
  const keys = headerKeys(rows[0]);
  const col = (field: keyof typeof FORM26AS_COLUMNS): number => keys.findIndex((k) => FORM26AS_COLUMNS[field].includes(k));
  const at = { tan: col('tan'), name: col('name'), section: col('section'), date: col('date'), amountPaid: col('amountPaid'), tds: col('tds') };
  const missing = (['name', 'date', 'tds'] as const).filter((f) => at[f] < 0);
  if (missing.length > 0) {
    throw validation([
      {
        path: 'content',
        message: `Columns not found: ${missing.map((f) => `"${FORM26AS_COLUMNS[f][0]}"`).join(', ')}. The first row must name the columns (TAN, Name of deductor, Section, Transaction date, Amount paid/credited, Tax deducted).`,
      },
    ]);
  }
  const issues: Array<{ path: string; message: string }> = [];
  const out: Form26asRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const cell = (j: number): string => (j >= 0 ? (r[j] ?? '').trim() : '');
    const line = i + 1;
    const date = parseStatementDate(cell(at.date));
    const tds = parseAmount(cell(at.tds));
    const paid = at.amountPaid >= 0 && cell(at.amountPaid) !== '' ? parseAmount(cell(at.amountPaid)) : 0;
    const tan = cell(at.tan).toUpperCase();
    if (!cell(at.name)) issues.push({ path: `row ${line}`, message: `Row ${line}: the deductor's name is missing.` });
    if (!date) issues.push({ path: `row ${line}`, message: `Row ${line}: "${cell(at.date)}" is not a date (use DD-MM-YYYY or DD-Mon-YYYY).` });
    if (tds === null) issues.push({ path: `row ${line}`, message: `Row ${line}: "${cell(at.tds)}" is not an amount.` });
    if (paid === null) issues.push({ path: `row ${line}`, message: `Row ${line}: "${cell(at.amountPaid)}" is not an amount.` });
    if (tan && !TAN_RE.test(tan)) issues.push({ path: `row ${line}`, message: `Row ${line}: "${tan}" is not a valid TAN.` });
    if (issues.length >= 20) break;
    if (date && tds !== null && paid !== null && cell(at.name)) {
      out.push({ tan: tan || null, name: cell(at.name), section: cell(at.section) || null, date, amountPaid: paid, tds });
    }
  }
  if (issues.length > 0) throw validation(issues);
  return out;
}

export function import26as(ctx: CompanyCtx, input: { fyStart: number; content: string; replace?: boolean }): { imported: number; outsideYear: number } {
  const { db } = ctx;
  const year = taxYear(input.fyStart);
  const rows = parseForm26asCsv(input.content);
  const inYear = rows.filter((r) => r.date >= year.start && r.date <= year.end);
  const before = db.value<number>('SELECT COUNT(*) FROM tds_26as WHERE fy_start = :fy', { fy: input.fyStart }) ?? 0;
  if (input.replace !== false) db.run('DELETE FROM tds_26as WHERE fy_start = :fy', { fy: input.fyStart });
  const batch = randomUUID();
  const now = ctx.clock.now().toISOString();
  for (const r of inYear) {
    db.run(
      `INSERT INTO tds_26as (batch, fy_start, deductor_tan, deductor_name, section, txn_date, amount_paid, tds_amount, imported_at)
       VALUES (:batch, :fy, :tan, :name, :section, :date, :paid, :tds, :now)`,
      { batch, fy: input.fyStart, tan: r.tan, name: r.name, section: r.section, date: r.date, paid: r.amountPaid, tds: r.tds, now },
    );
  }
  ctx.audit({
    action: 'import',
    entityType: 'tds_26as',
    entityLabel: `Form 26AS / AIS for FY ${year.label}: ${inYear.length} row(s)${input.replace !== false && before > 0 ? `, replacing ${before}` : ''}`,
    after: { rows: inYear.length, replaced: input.replace !== false ? before : 0, skippedOutsideYear: rows.length - inYear.length },
  });
  return { imported: inYear.length, outsideYear: rows.length - inYear.length };
}

const normName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\b(m\/s\.?|messrs\.?|the|pvt|private|ltd|limited|llp)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

export function receivable(db: Db, p: { fyStart: number; today: string }): TdsReceivableResult {
  const year = taxYear(p.fyStart);
  const ledgers = db.all<{ id: number; name: string }>(
    `SELECT l.id, l.name FROM tds_ledger_details d JOIN ledgers l ON l.id = d.ledger_id WHERE d.payable_kind = 'receivable' ORDER BY l.name`,
  );
  const books = db.all<{ party_id: number | null; party_name: string | null; amount: number; tan: string | null }>(
    `SELECT v.party_ledger_id AS party_id, COALESCE(pl.name, v.party_name) AS party_name, SUM(le.amount) AS amount, d.deductor_tan AS tan
       FROM ledger_entries le
       JOIN tds_ledger_details r ON r.ledger_id = le.ledger_id AND r.payable_kind = 'receivable'
       JOIN vouchers v ON v.id = le.voucher_id
       LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
       LEFT JOIN tds_ledger_details d ON d.ledger_id = v.party_ledger_id
      WHERE le.date >= :from AND le.date <= :to AND le.affects_books = 1 AND (le.is_post_dated = 0 OR le.date <= :today)
      GROUP BY v.party_ledger_id`,
    { from: year.start, to: year.end, today: p.today },
  );
  const statement = db.all<{ tan: string | null; name: string; tds: number; paid: number }>(
    `SELECT deductor_tan AS tan, MIN(deductor_name) AS name, SUM(tds_amount) AS tds, SUM(amount_paid) AS paid
       FROM tds_26as WHERE fy_start = :fy GROUP BY COALESCE(deductor_tan, lower(deductor_name))`,
    { fy: p.fyStart },
  );
  const imported = db.get<{ n: number; at: string | null }>('SELECT COUNT(*) AS n, MAX(imported_at) AS at FROM tds_26as WHERE fy_start = :fy', { fy: p.fyStart });
  const used = new Set<number>();
  const rows: TdsReceivableRow[] = [];
  for (const b of books) {
    let hit = -1;
    if (b.tan) hit = statement.findIndex((s, i) => !used.has(i) && s.tan === b.tan);
    if (hit < 0 && b.party_name) hit = statement.findIndex((s, i) => !used.has(i) && normName(s.name) === normName(b.party_name ?? ''));
    const s = hit >= 0 ? statement[hit] : null;
    if (hit >= 0) used.add(hit);
    const diff = (s?.tds ?? 0) - b.amount;
    rows.push({
      key: `b${b.party_id ?? 0}`,
      partyLedgerId: b.party_id,
      partyName: b.party_name ?? '(no party)',
      tan: b.tan ?? s?.tan ?? null,
      books: b.amount,
      form26as: s?.tds ?? 0,
      amountPaid: s?.paid ?? 0,
      difference: diff,
      status: !s ? 'books_only' : diff === 0 ? 'matched' : 'mismatch',
    });
  }
  statement.forEach((s, i) => {
    if (used.has(i)) return;
    rows.push({
      key: `s${i}`,
      partyLedgerId: null,
      partyName: s.name,
      tan: s.tan,
      books: 0,
      form26as: s.tds,
      amountPaid: s.paid,
      difference: s.tds,
      status: 'form26as_only',
    });
  });
  rows.sort((a, b) => a.partyName.localeCompare(b.partyName));
  return {
    fyStart: p.fyStart,
    receivableLedgers: ledgers,
    rows,
    totals: {
      books: rows.reduce((a, r) => a + r.books, 0),
      form26as: rows.reduce((a, r) => a + r.form26as, 0),
      difference: rows.reduce((a, r) => a + r.difference, 0),
    },
    imported: { rows: imported?.n ?? 0, importedAt: imported?.at ?? null },
  };
}
