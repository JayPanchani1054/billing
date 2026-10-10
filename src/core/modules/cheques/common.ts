/**
 * Shared helpers of the cheques module: feature gate, permissions, cheque numbers, issued cheques
 * (bank credits with instrument type 'cheque' — the books are the single source), payee names.
 */
import type { Permission } from '../../../shared/constants.ts';
import { formatDate } from '../../../shared/dates.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { forbidden, rule } from '../../lib/errors.ts';
import { getFeatures } from '../company/service.ts';

export const can = (ctx: CompanyCtx, p: Permission): boolean => ctx.session.isOwner || ctx.session.permissions.has(p);

export function requirePermission(ctx: CompanyCtx, p: Permission, what: string): void {
  if (!can(ctx, p)) throw forbidden(`You do not have permission to ${what}.`);
}

/** Cheque books, the register, layouts and printing need F11 › Cheque printing. */
export function assertChequePrinting(db: Db): void {
  if (!getFeatures(db).chequePrinting) {
    throw rule('Cheque printing is turned off for this company. Turn it on in F11 › Features › Cheque printing.');
  }
}

/** '000123' → 123; null for anything that is not a plain cheque number (letters, empty, > 12 digits). */
export function chequeNumber(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!/^\d{1,12}$/.test(t)) return null;
  return Number(t);
}

/** 123 → '000123' (zero-padded to the book's digits). */
export function padCheque(n: number, digits: number): string {
  return String(n).padStart(digits, '0');
}

export function voucherLabel(typeName: string, number: string | null, date: string): string {
  return `${typeName} ${number ?? '(no number)'} dated ${formatDate(date)}`;
}

export interface IssuedCheque {
  voucherId: number;
  lineNo: number;
  ledgerId: number;
  chequeNo: number;
  rawNo: string;
  date: string;
  chequeDate: string;
  amount: number;
  bankDate: string | null;
  favouring: string | null;
  isPostDated: boolean;
  /** The voucher is in the books (not optional / cancelled): what the BRS counts. */
  affectsBooks: boolean;
  typeName: string;
  number: string | null;
}

/**
 * Cheques issued from a bank ledger: its credit entries with instrument type 'cheque' and a numeric
 * instrument number. Cancelled vouchers have no entries (their leaves are marked by the hook).
 * Optional vouchers count too (the leaf is written out) — they are not in the books, but the leaf is used.
 */
export function issuedCheques(db: Db, bankLedgerId: number, opts: { excludeVoucherId?: number | null } = {}): IssuedCheque[] {
  const rows = db.all<{
    voucher_id: number;
    line_no: number;
    ledger_id: number;
    instrument_no: string;
    date: string;
    instrument_date: string | null;
    amount: number;
    bank_date: string | null;
    favouring: string | null;
    is_post_dated: number;
    affects_books: number;
    type_name: string;
    number: string | null;
  }>(
    `SELECT le.voucher_id, le.line_no, le.ledger_id, le.instrument_no, le.date, le.instrument_date, le.amount, le.bank_date,
            le.favouring, le.is_post_dated, le.affects_books, vt.name AS type_name, v.number
       FROM ledger_entries le
       JOIN vouchers v ON v.id = le.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE le.ledger_id = :bank AND le.instrument_type = 'cheque' AND le.amount < 0 AND le.voucher_id <> :ex
      ORDER BY le.date, le.voucher_id, le.line_no`,
    { bank: bankLedgerId, ex: opts.excludeVoucherId ?? -1 },
  );
  const out: IssuedCheque[] = [];
  for (const r of rows) {
    const n = chequeNumber(r.instrument_no);
    if (n === null) continue;
    out.push({
      voucherId: r.voucher_id,
      lineNo: r.line_no,
      ledgerId: r.ledger_id,
      chequeNo: n,
      rawNo: r.instrument_no.trim(),
      date: r.date,
      chequeDate: r.instrument_date ?? r.date,
      amount: -r.amount,
      bankDate: r.bank_date,
      favouring: r.favouring,
      isPostDated: r.is_post_dated === 1,
      affectsBooks: r.affects_books === 1,
      typeName: r.type_name,
      number: r.number,
    });
  }
  return out;
}

/** A cheque leaf on a voucher: just the number (what leaf allocation and the voucher checks need). */
export interface IssuedLeaf {
  voucherId: number;
  chequeNo: number;
}

/**
 * The numbers of the cheques issued from a bank ledger — the light form of issuedCheques (no joins, no
 * labels): leaf allocation runs on every cheque payment save, so it must stay cheap on a bank ledger with
 * tens of thousands of entries.
 */
export function issuedLeaves(db: Db, bankLedgerId: number): IssuedLeaf[] {
  const out: IssuedLeaf[] = [];
  for (const r of db.all<{ voucher_id: number; instrument_no: string }>(
    "SELECT voucher_id, instrument_no FROM ledger_entries WHERE ledger_id = :bank AND instrument_type = 'cheque' AND amount < 0",
    { bank: bankLedgerId },
  )) {
    const n = chequeNumber(r.instrument_no);
    if (n !== null) out.push({ voucherId: r.voucher_id, chequeNo: n });
  }
  return out;
}

/** Leaves the user (or a voucher cancellation) marked cancelled: number → reason / date. */
export function leafMarks(db: Db, bankLedgerId: number): Map<number, { reason: string | null; date: string; voucherId: number | null }> {
  const out = new Map<number, { reason: string | null; date: string; voucherId: number | null }>();
  for (const r of db.all<{ cheque_no: number; reason: string | null; date: string; voucher_id: number | null }>(
    'SELECT cheque_no, reason, date, voucher_id FROM cheque_leaf_marks WHERE bank_ledger_id = :b',
    { b: bankLedgerId },
  )) {
    out.set(r.cheque_no, { reason: r.reason, date: r.date, voucherId: r.voucher_id });
  }
  return out;
}

/**
 * Cheques printed whose leaf is no longer issued on that voucher (voucher deleted, or its cheque number
 * changed after printing): the leaf was written on, so it is spoilt. number → description.
 */
export function spoiltByPrint(db: Db, bankLedgerId: number, issued: readonly IssuedLeaf[]): Map<number, { at: string; label: string | null }> {
  const onVoucher = new Set(issued.map((c) => `${c.voucherId}:${c.chequeNo}`));
  const out = new Map<number, { at: string; label: string | null }>();
  for (const p of db.all<{ voucher_id: number | null; cheque_no: string | null; printed_at: string; voucher_label: string | null }>(
    'SELECT voucher_id, cheque_no, printed_at, voucher_label FROM cheque_prints WHERE bank_ledger_id = :b ORDER BY id',
    { b: bankLedgerId },
  )) {
    const n = chequeNumber(p.cheque_no);
    if (n === null) continue;
    if (p.voucher_id !== null && onVoucher.has(`${p.voucher_id}:${n}`)) continue;
    out.set(n, { at: p.printed_at, label: p.voucher_label });
  }
  return out;
}

/** Name for the payee line of a cheque to `ledgerId`: cheque name › beneficiary › mailing name › name. */
export function chequePayeeName(db: Db, ledgerId: number): string {
  const r = db.get<{ name: string; mailing_name: string | null; cheque_name: string | null; beneficiary_name: string | null }>(
    `SELECT l.name, l.mailing_name, p.cheque_name, p.beneficiary_name
       FROM ledgers l LEFT JOIN payee_bank_details p ON p.ledger_id = l.id WHERE l.id = :id`,
    { id: ledgerId },
  );
  if (!r) return '';
  const pick = [r.cheque_name, r.beneficiary_name, r.mailing_name, r.name].map((s) => (s ?? '').trim()).find((s) => s !== '');
  return pick ?? r.name;
}
