/**
 * Shared DB helpers for the banking module: bank ledgers, ledger-entry rows with their voucher, the
 * "particulars" (other side) of a voucher, statement-line views and permission checks.
 */
import type { Permission } from '../../../shared/constants.ts';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import type {
  BankLedgerRef,
  EntryVoucherRef,
  MatchMethod,
  StatementLineStatus,
  StatementLineView,
} from '../../../shared/types/banking.ts';
import type { InstrumentType } from '../../../shared/types/vouchers.ts';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { BindValue, Db } from '../../db/db.ts';
import { AppError, forbidden, notFound, rule } from '../../lib/errors.ts';
import { BOOKS_FILTER, loadGroupTree } from '../accounts/books.ts';
import { getConfig } from '../company/service.ts';

export const can = (ctx: CompanyCtx, p: Permission): boolean => ctx.session.isOwner || ctx.session.permissions.has(p);

/**
 * Period lock for bank dates (ARCHITECTURE §4 period lock, banking README): a bank date on or before
 * the date the books are locked up to is part of a closed reconciliation. Setting, moving or clearing
 * one — the old OR the new date in the locked period — needs the right to lock and unlock the books
 * (`period.lock`, Owners always), exactly as unlocking, changing and re-locking would; anyone else gets
 * LOCKED. A cheque of a locked month that clears in an open month (old date none, new date open) is
 * ordinary work and allowed.
 */
export function canChangeLockedBankDates(ctx: CompanyCtx): boolean {
  return can(ctx, 'period.lock');
}

/** The locked-up-to date when `date` falls in the locked period, else null. */
export function lockedBankDate(ctx: CompanyCtx, date: string | null): string | null {
  if (date === null) return null;
  const lockedUpTo = getConfig(ctx.db).lockedUpTo;
  return lockedUpTo && date <= lockedUpTo ? lockedUpTo : null;
}

export function assertBankDateChangeAllowed(ctx: CompanyCtx, oldDate: string | null, newDate: string | null, what: () => string): void {
  if (oldDate === newDate) return;
  const lockedUpTo = lockedBankDate(ctx, oldDate) ?? lockedBankDate(ctx, newDate);
  if (lockedUpTo === null || canChangeLockedBankDates(ctx)) return;
  const inLock = lockedBankDate(ctx, oldDate) !== null ? (oldDate as string) : (newDate as string);
  throw new AppError(
    'LOCKED',
    `Books are locked up to ${fmtDate(lockedUpTo)}. ${what()} would change the bank date ${fmtDate(inLock)}, which is in the locked period. ` +
      'Ask a user who may lock and unlock the books to do it, or unlock the period first.',
    { lockedUpTo },
  );
}

export function requirePermission(ctx: CompanyCtx, p: Permission, what: string): void {
  if (!can(ctx, p)) throw forbidden(`You do not have permission to ${what}.`);
}

/**
 * Only the named parameters the SQL uses (node:sqlite rejects unknown names), so one parameter object can be
 * shared by queries assembled from optional fragments.
 */
export function paramsFor(sql: string, params: Record<string, BindValue>): Record<string, BindValue> {
  const out: Record<string, BindValue> = {};
  for (const [k, val] of Object.entries(params)) if (new RegExp(`:${k}\\b`).test(sql)) out[k] = val;
  return out;
}

export const money = (p: Paise): string => formatMoney(p, { symbol: true });
export const fmtDate = (iso: string | null | undefined): string => formatDate(iso);

// ───────────────────────────── Bank ledgers ─────────────────────────────

export interface BankLedger extends BankLedgerRef {
  groupId: number;
  openingBalance: Paise;
  holder: string | null;
  isActive: boolean;
}

interface LedgerRow {
  id: number;
  name: string;
  group_id: number;
  opening_balance: number;
  bank_account_no: string | null;
  bank_name: string | null;
  bank_ifsc: string | null;
  bank_branch: string | null;
  bank_account_holder: string | null;
  is_active: number;
}

const LEDGER_COLS = 'id, name, group_id, opening_balance, bank_account_no, bank_name, bank_ifsc, bank_branch, bank_account_holder, is_active';

/** Every ledger under Bank Accounts or Bank OD A/c (any depth), by name. */
export function bankLedgers(db: Db): BankLedger[] {
  const tree = loadGroupTree(db);
  const groups = new Map<number, boolean>();
  for (const [id, g] of tree.byId) if (g.cls.isBank) groups.set(id, g.cls.isBankOd);
  if (groups.size === 0) return [];
  return db
    .all<LedgerRow>(`SELECT ${LEDGER_COLS} FROM ledgers WHERE group_id IN (SELECT value FROM json_each(:g)) ORDER BY name COLLATE NOCASE`, {
      g: JSON.stringify([...groups.keys()]),
    })
    .map((r) => toBankLedger(r, groups.get(r.group_id) === true));
}

function toBankLedger(r: LedgerRow, isOd: boolean): BankLedger {
  return {
    id: r.id,
    name: r.name,
    isOd,
    accountNo: r.bank_account_no,
    bankName: r.bank_name,
    ifsc: r.bank_ifsc,
    branch: r.bank_branch,
    groupId: r.group_id,
    openingBalance: r.opening_balance,
    holder: r.bank_account_holder,
    isActive: r.is_active === 1,
  };
}

export function bankRef(b: BankLedger): BankLedgerRef {
  return { id: b.id, name: b.name, isOd: b.isOd, accountNo: b.accountNo, bankName: b.bankName, ifsc: b.ifsc, branch: b.branch };
}

/** The bank ledger, or NOT_FOUND / a rule error naming the ledger's actual group. */
export function requireBankLedger(db: Db, ledgerId: number, purpose: string): BankLedger {
  const row = db.get<LedgerRow & { group_name: string }>(
    `SELECT ${LEDGER_COLS.split(', ').map((c) => `l.${c}`).join(', ')}, g.name AS group_name
       FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = :id`,
    { id: ledgerId },
  );
  if (!row) throw notFound('Ledger', ledgerId);
  const bank = bankLedgers(db).find((b) => b.id === ledgerId);
  if (!bank) {
    throw rule(`${purpose} is available only for ledgers under Bank Accounts or Bank OD A/c. "${row.name}" is under ${row.group_name}.`);
  }
  return bank;
}

/** Ledger text that may name a bank (preset tie-breaker). */
export function bankHint(b: BankLedger): string {
  return [b.bankName ?? '', b.name].join(' ');
}

// ───────────────────────────── Entries ─────────────────────────────

/** A ledger entry with its voucher header (one row of ENTRY_SELECT). */
export interface EntryRow {
  entry_id: number;
  voucher_id: number;
  ledger_id: number;
  amount: number;
  date: string;
  instrument_type: string | null;
  instrument_no: string | null;
  instrument_date: string | null;
  bank_name: string | null;
  favouring: string | null;
  bank_date: string | null;
  is_post_dated: number;
  affects_books: number;
  entry_narration: string | null;
  number: string | null;
  base_type: string;
  narration: string | null;
  party_name: string | null;
  type_name: string;
  line_id: number | null;
}

/** SELECT list + FROM for EntryRow; add WHERE … with the alias `le` for ledger_entries, `v` for vouchers. */
export const ENTRY_SELECT = /* sql */ `
  SELECT le.id AS entry_id, le.voucher_id, le.ledger_id, le.amount, le.date, le.instrument_type, le.instrument_no,
         le.instrument_date, le.bank_name, le.favouring, le.bank_date, le.is_post_dated, le.affects_books,
         le.narration AS entry_narration, v.number, v.base_type, v.narration, v.party_name, vt.name AS type_name,
         (SELECT s.id FROM bank_statement_lines s WHERE s.matched_entry_id = le.id ORDER BY s.id LIMIT 1) AS line_id
    FROM ledger_entries le
    JOIN vouchers v ON v.id = le.voucher_id
    JOIN voucher_types vt ON vt.id = v.voucher_type_id`;

/** Entries that count in the books on `today` (bind :today). */
export const IN_BOOKS = BOOKS_FILTER('le');

/**
 * The other side of each voucher: for an entry, the largest entry of opposite sign in the same voucher
 * (ties → first line), else the party snapshot, else the voucher type. One query for all vouchers.
 */
export function particularsResolver(db: Db, voucherIds: readonly number[]): (r: Pick<EntryRow, 'voucher_id' | 'ledger_id' | 'amount' | 'party_name' | 'type_name'>) => string {
  const byVoucher = new Map<number, Array<{ ledgerId: number; amount: number; name: string }>>();
  const ids = [...new Set(voucherIds)];
  const CHUNK = 5000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = db.all<{ voucher_id: number; ledger_id: number; amount: number; name: string }>(
      `SELECT le.voucher_id, le.ledger_id, le.amount, l.name
         FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
        WHERE le.voucher_id IN (SELECT value FROM json_each(:ids))
        ORDER BY le.voucher_id, le.line_no`,
      { ids: JSON.stringify(ids.slice(i, i + CHUNK)) },
    );
    for (const r of rows) {
      const list = byVoucher.get(r.voucher_id);
      const e = { ledgerId: r.ledger_id, amount: r.amount, name: r.name };
      if (list) list.push(e);
      else byVoucher.set(r.voucher_id, [e]);
    }
  }
  return (r) => {
    const list = byVoucher.get(r.voucher_id) ?? [];
    let best: { amount: number; name: string } | null = null;
    for (const e of list) {
      if (e.ledgerId === r.ledger_id || Math.sign(e.amount) === Math.sign(r.amount) || e.amount === 0) continue;
      if (!best || Math.abs(e.amount) > Math.abs(best.amount)) best = e;
    }
    return best?.name ?? r.party_name ?? r.type_name;
  };
}

export function voucherRef(r: EntryRow, particulars: string): EntryVoucherRef {
  return {
    ledgerEntryId: r.entry_id,
    voucherId: r.voucher_id,
    date: r.date,
    voucherType: r.type_name,
    baseType: r.base_type as VoucherBaseType,
    number: r.number,
    particulars,
  };
}

export const asInstrument = (t: string | null): InstrumentType | null => (t ? (t as InstrumentType) : null);

/** "Receipt 12 dated 05-Apr-2026" for messages. */
export function voucherLabel(r: Pick<EntryRow, 'type_name' | 'number' | 'date'>): string {
  return `${r.type_name}${r.number ? ` ${r.number}` : ''} dated ${fmtDate(r.date)}`;
}

export function loadEntry(db: Db, ledgerEntryId: number): EntryRow {
  const row = db.get<EntryRow>(`${ENTRY_SELECT} WHERE le.id = :id`, { id: ledgerEntryId });
  if (!row) {
    throw notFound(
      'Ledger entry',
      `${ledgerEntryId} (the voucher may have been altered or deleted — refresh the screen and try again)`,
    );
  }
  return row;
}

/** Rule error when an entry does not count in the books on `today` (optional / post-dated not yet due). */
export function assertEntryInBooks(r: EntryRow, today: string): void {
  if (r.affects_books !== 1) {
    throw rule(`${voucherLabel(r)} is optional or cancelled and does not affect the books, so it cannot be reconciled.`);
  }
  if (r.is_post_dated === 1 && r.date > today) {
    throw rule(`${voucherLabel(r)} is a post-dated voucher that is not yet due. It can be reconciled on or after ${fmtDate(r.date)}.`);
  }
}

// ───────────────────────────── Statement lines ─────────────────────────────

export interface LineRow {
  id: number;
  batch_id: number;
  ledger_id: number;
  txn_date: string;
  value_date: string | null;
  description: string | null;
  reference: string | null;
  amount: number;
  balance: number | null;
  status: string;
  matched_entry_id: number | null;
  match_score: number | null;
  match_method: string | null;
  source_row: number | null;
  seq: number;
  // Joined matched entry (null when not linked)
  e_voucher_id: number | null;
  e_amount: number | null;
  e_bank_date: string | null;
  e_ledger_id: number | null;
  e_date: string | null;
  e_number: string | null;
  e_base_type: string | null;
  e_type_name: string | null;
  e_party_name: string | null;
}

export const LINE_SELECT = /* sql */ `
  SELECT s.id, s.batch_id, s.ledger_id, s.txn_date, s.value_date, s.description, s.reference, s.amount, s.balance,
         s.status, s.matched_entry_id, s.match_score, s.match_method, s.source_row, s.seq,
         le.voucher_id AS e_voucher_id, le.amount AS e_amount, le.bank_date AS e_bank_date, le.ledger_id AS e_ledger_id,
         v.date AS e_date, v.number AS e_number, v.base_type AS e_base_type, vt.name AS e_type_name, v.party_name AS e_party_name
    FROM bank_statement_lines s
    LEFT JOIN ledger_entries le ON le.id = s.matched_entry_id
    LEFT JOIN vouchers v ON v.id = le.voucher_id
    LEFT JOIN voucher_types vt ON vt.id = v.voucher_type_id`;

/** Status as shown: a matched/created line whose entry has disappeared is unmatched. */
export function effectiveStatus(r: Pick<LineRow, 'status' | 'matched_entry_id'>): StatementLineStatus {
  if ((r.status === 'matched' || r.status === 'created') && r.matched_entry_id === null) return 'unmatched';
  if (r.status === 'matched' || r.status === 'created' || r.status === 'ignored') return r.status;
  return 'unmatched';
}

export function lineViews(db: Db, rows: readonly LineRow[]): StatementLineView[] {
  const particulars = particularsResolver(
    db,
    rows.filter((r) => r.e_voucher_id !== null).map((r) => r.e_voucher_id as number),
  );
  return rows.map((r) => {
    const status = effectiveStatus(r);
    const linked = (status === 'matched' || status === 'created') && r.e_voucher_id !== null;
    return {
      id: r.id,
      batchId: r.batch_id,
      ledgerId: r.ledger_id,
      txnDate: r.txn_date,
      valueDate: r.value_date,
      description: r.description ?? '',
      reference: r.reference ?? '',
      amount: r.amount,
      deposit: r.amount > 0 ? r.amount : 0,
      withdrawal: r.amount < 0 ? -r.amount : 0,
      balance: r.balance,
      status,
      matchScore: linked ? r.match_score : null,
      matchMethod: linked ? ((r.match_method as MatchMethod | null) ?? null) : null,
      matched: linked
        ? {
            ledgerEntryId: r.matched_entry_id as number,
            voucherId: r.e_voucher_id as number,
            date: r.e_date as string,
            voucherType: r.e_type_name as string,
            baseType: r.e_base_type as VoucherBaseType,
            number: r.e_number,
            particulars: particulars({
              voucher_id: r.e_voucher_id as number,
              ledger_id: r.e_ledger_id as number,
              amount: r.e_amount as number,
              party_name: r.e_party_name,
              type_name: r.e_type_name as string,
            }),
            bankDate: r.e_bank_date,
            amount: r.e_amount as number,
          }
        : null,
      sourceRow: r.source_row,
    };
  });
}

export function loadLine(db: Db, lineId: number): LineRow {
  const row = db.get<LineRow>(`${LINE_SELECT} WHERE s.id = :id`, { id: lineId });
  if (!row) throw notFound('Statement line', lineId);
  return row;
}

export function lineView(db: Db, lineId: number): StatementLineView {
  return lineViews(db, [loadLine(db, lineId)])[0];
}

/** "05-Apr-2026 deposit ₹ 1,000.00 (NEFT ACME …)" for messages. */
export function lineLabel(r: Pick<LineRow, 'txn_date' | 'amount' | 'description'>): string {
  const desc = (r.description ?? '').trim();
  return `${fmtDate(r.txn_date)} ${r.amount >= 0 ? 'deposit' : 'withdrawal'} ${money(Math.abs(r.amount))}${desc ? ` (${desc.length > 40 ? `${desc.slice(0, 39)}…` : desc})` : ''}`;
}

/**
 * Lines left 'matched'/'created' after their entry disappeared (a voucher altered/deleted outside the voucher
 * engine's link handling) become unmatched again.
 */
export function healOrphanLines(db: Db, ledgerId: number): void {
  db.run(
    `UPDATE bank_statement_lines
        SET status = 'unmatched', match_method = NULL, match_score = NULL, matched_at = NULL, matched_by = NULL
      WHERE ledger_id = :l AND status IN ('matched', 'created') AND matched_entry_id IS NULL`,
    { l: ledgerId },
  );
}

/** Link a statement line to a ledger entry and set the entry's bank date to the statement date. */
export function linkLine(ctx: CompanyCtx, line: Pick<LineRow, 'id' | 'txn_date'>, entryId: number, method: MatchMethod, score: number | null): void {
  ctx.db.run('UPDATE ledger_entries SET bank_date = :d WHERE id = :id', { d: line.txn_date, id: entryId });
  ctx.db.run(
    `UPDATE bank_statement_lines
        SET status = :status, matched_entry_id = :e, match_score = :score, match_method = :method, matched_at = :at, matched_by = :by
      WHERE id = :id`,
    {
      status: method === 'created' ? 'created' : 'matched',
      e: entryId,
      score,
      method,
      at: ctx.clock.now().toISOString(),
      by: ctx.session.userId,
      id: line.id,
    },
  );
}

/** Undo a link: the line becomes unmatched and the entry loses its bank date. */
export function unlinkLine(db: Db, line: Pick<LineRow, 'id' | 'matched_entry_id'>): void {
  if (line.matched_entry_id !== null) db.run('UPDATE ledger_entries SET bank_date = NULL WHERE id = :id', { id: line.matched_entry_id });
  db.run(
    `UPDATE bank_statement_lines
        SET status = 'unmatched', matched_entry_id = NULL, match_score = NULL, match_method = NULL, matched_at = NULL, matched_by = NULL
      WHERE id = :id`,
    { id: line.id },
  );
}
