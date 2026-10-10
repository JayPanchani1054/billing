/**
 * Bulk e-payment file: one row per selected Payment voucher paid by bank transfer, for the bank's bulk
 * upload (NEFT / RTGS / IMPS).
 *
 * The file is Bahi's documented generic CSV (README › E-payments), not any one bank's proprietary
 * upload template: each bank's corporate portal has its own column order and maps a CSV on upload, or
 * the columns are rearranged once in a spreadsheet. Rules applied:
 *   - RTGS is for ₹2,00,000 and above (RBI); IMPS up to ₹5,00,000 per transaction (RBI, from Oct 2021);
 *     NEFT has no minimum or maximum. Mode: the voucher's instrument (NEFT / RTGS / IMPS), else the
 *     payee's preferred mode, else RTGS from ₹2,00,000 and NEFT below.
 *   - The payee (largest debit that is not cash / bank) needs a beneficiary account number and IFSC
 *     (Masters › Payee Bank Details); a payment to several parties is refused (one row = one beneficiary).
 *   - Value date: the given one, else the voucher date, but never before today (banks refuse past dates).
 * Every file is recorded (epayment_batches) and in the edit log as an export.
 */
import { randomUUID } from 'node:crypto';
import { formatDate } from '../../../shared/dates.ts';
import type { Paise } from '../../../shared/money.ts';
import type { EPaymentCandidate, EPaymentExportInput, EPaymentExportResult, EPaymentListInput, EPaymentMode } from '../../../shared/types/cheques.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { toCsv } from '../../lib/csv.ts';
import { validation } from '../../lib/errors.ts';
import { loadGroupTree } from '../accounts/books.ts';
import { requirePermission, voucherLabel } from './common.ts';

/** RTGS minimum (RBI). */
export const RTGS_MIN_PAISE = 2_00_000_00;
/** IMPS per-transaction limit (RBI, raised to ₹5 lakh in October 2021). */
export const IMPS_MAX_PAISE = 5_00_000_00;
export const EPAYMENT_MAX_ROWS = 1000;

const TRANSFER: ReadonlySet<string> = new Set(['neft', 'rtgs', 'imps']);
/** Instruments that are not a bank transfer (they never go into a payment file). */
const NOT_TRANSFER: ReadonlySet<string> = new Set(['cheque', 'dd', 'upi', 'card', 'cash']);

interface Row {
  id: number;
  date: string;
  number: string | null;
  type_name: string;
  narration: string | null;
}

interface Entry {
  voucher_id: number;
  line_no: number;
  ledger_id: number;
  amount: number;
  instrument_type: string | null;
}

interface Resolved extends EPaymentCandidate {
  narration: string | null;
  debitAccountNo: string | null;
  bankName: string | null;
  accountType: string | null;
  email: string | null;
  mobile: string | null;
}

function resolve(db: Db, vouchers: readonly Row[]): Resolved[] {
  if (vouchers.length === 0) return [];
  const tree = loadGroupTree(db);
  const ledgerCache = new Map<number, { name: string; group: number; account: string | null }>();
  const ledger = (id: number) => {
    let l = ledgerCache.get(id);
    if (!l) {
      const r = db.get<{ name: string; group_id: number; bank_account_no: string | null }>('SELECT name, group_id, bank_account_no FROM ledgers WHERE id = :id', { id });
      l = { name: r?.name ?? '', group: r?.group_id ?? 0, account: r?.bank_account_no ?? null };
      ledgerCache.set(id, l);
    }
    return l;
  };
  const isBank = (id: number) => tree.byId.get(ledger(id).group)?.cls.isBank === true;
  const isCashBank = (id: number) => tree.byId.get(ledger(id).group)?.cls.isCashOrBank === true;
  const entries = db.all<Entry>(
    `SELECT voucher_id, line_no, ledger_id, amount, instrument_type FROM ledger_entries
      WHERE voucher_id IN (SELECT value FROM json_each(:ids)) ORDER BY voucher_id, line_no`,
    { ids: JSON.stringify(vouchers.map((v) => v.id)) },
  );
  const byVoucher = new Map<number, Entry[]>();
  for (const e of entries) {
    const list = byVoucher.get(e.voucher_id) ?? [];
    list.push(e);
    byVoucher.set(e.voucher_id, list);
  }
  const exported = new Map<number, string>();
  for (const r of db.all<{ voucher_id: number; created_at: string }>(
    `SELECT i.voucher_id, MAX(b.created_at) AS created_at FROM epayment_batch_items i JOIN epayment_batches b ON b.id = i.batch_id
      WHERE i.voucher_id IN (SELECT value FROM json_each(:ids)) GROUP BY i.voucher_id`,
    { ids: JSON.stringify(vouchers.map((v) => v.id)) },
  )) {
    exported.set(r.voucher_id, r.created_at);
  }
  const out: Resolved[] = [];
  for (const v of vouchers) {
    const list = byVoucher.get(v.id) ?? [];
    const credits = list.filter((e) => e.amount < 0 && isBank(e.ledger_id));
    if (credits.length !== 1) continue;
    const bankLine = credits[0];
    const instrument = bankLine.instrument_type ?? '';
    if (NOT_TRANSFER.has(instrument)) continue;
    const debits = list.filter((e) => e.amount > 0 && !isCashBank(e.ledger_id));
    const parties = [...new Set(debits.map((d) => d.ledger_id))];
    const amount: Paise = -bankLine.amount;
    const top = [...debits].sort((a, b) => b.amount - a.amount || a.line_no - b.line_no)[0];
    const payeeId = top?.ledger_id ?? null;
    const p = payeeId !== null
      ? db.get<{ beneficiary_name: string | null; account_no: string | null; ifsc: string | null; bank_name: string | null; account_type: string | null; payment_mode: string | null; email: string | null; mobile: string | null; name: string; mailing_name: string | null }>(
          `SELECT p.beneficiary_name, p.account_no, p.ifsc, p.bank_name, p.account_type, p.payment_mode, l.email, l.mobile, l.name, l.mailing_name
             FROM ledgers l LEFT JOIN payee_bank_details p ON p.ledger_id = l.id WHERE l.id = :id`,
          { id: payeeId },
        )
      : undefined;
    const mode: EPaymentMode = TRANSFER.has(instrument)
      ? (instrument as EPaymentMode)
      : p?.payment_mode && TRANSFER.has(p.payment_mode)
        ? (p.payment_mode as EPaymentMode)
        : amount >= RTGS_MIN_PAISE
          ? 'rtgs'
          : 'neft';
    let problem: string | null = null;
    if (payeeId === null) problem = 'No party is paid by this voucher.';
    else if (parties.length > 1) problem = 'The voucher pays more than one ledger: make one payment per beneficiary.';
    else if (!p?.account_no || !p.ifsc) problem = `Add the bank account and IFSC of ${p?.name ?? 'the payee'} (Masters › Payee Bank Details).`;
    else if (mode === 'rtgs' && amount < RTGS_MIN_PAISE) problem = 'RTGS is for ₹2,00,000 and above: choose NEFT in the bank details of the voucher (Alt+K).';
    else if (mode === 'imps' && amount > IMPS_MAX_PAISE) problem = 'IMPS allows up to ₹5,00,000 per transfer: choose NEFT or RTGS.';
    else if (amount <= 0) problem = 'The amount is zero.';
    out.push({
      voucherId: v.id,
      voucherLabel: voucherLabel(v.type_name, v.number, v.date),
      date: v.date,
      bankLedgerId: bankLine.ledger_id,
      bankLedgerName: ledger(bankLine.ledger_id).name,
      payeeLedgerId: payeeId,
      payeeName: p?.name ?? null,
      beneficiaryName: (p?.beneficiary_name ?? '').trim() || (p?.mailing_name ?? '').trim() || p?.name || null,
      accountNo: p?.account_no ?? null,
      ifsc: p?.ifsc ?? null,
      amount,
      mode,
      problem,
      exportedAt: exported.get(v.id) ?? null,
      narration: v.narration,
      debitAccountNo: ledger(bankLine.ledger_id).account,
      bankName: p?.bank_name ?? null,
      accountType: p?.account_type ?? null,
      email: p?.email ?? null,
      mobile: p?.mobile ?? null,
    });
  }
  return out;
}

const PAYMENT_SELECT = `SELECT v.id, v.date, v.number, vt.name AS type_name, v.narration FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id`;

/** Payment vouchers of the period paid by bank transfer (or with no instrument), ready or not. */
export function listEPayments(db: Db, input: EPaymentListInput): EPaymentCandidate[] {
  if (input.from > input.to) throw validation([{ path: 'to', message: 'The end date must be on or after the start date' }]);
  const rows = db.all<Row>(
    `${PAYMENT_SELECT} WHERE v.base_type = 'payment' AND v.is_cancelled = 0 AND v.date BETWEEN :from AND :to ORDER BY v.date, v.number_seq, v.id`,
    { from: input.from, to: input.to },
  );
  return resolve(db, rows)
    .filter((r) => input.bankLedgerId === undefined || r.bankLedgerId === input.bankLedgerId)
    .map(({ narration: _n, debitAccountNo: _d, bankName: _b, accountType: _a, email: _e, mobile: _m, ...c }) => c);
}

const rupees = (p: Paise): string => `${Math.trunc(p / 100)}.${String(Math.abs(p % 100)).padStart(2, '0')}`;
const ddmmyyyy = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** Banks accept a narrow character set in names and remarks. */
const clean = (s: string | null | undefined, max: number): string =>
  (s ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 .,/&()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export const EPAYMENT_COLUMNS = [
  'Sl No',
  'Payment Mode',
  'Amount',
  'Value Date',
  'Beneficiary Name',
  'Beneficiary Account No',
  'Beneficiary IFSC',
  'Beneficiary Bank',
  'Beneficiary Account Type',
  'Debit Account No',
  'Debit Bank Ledger',
  'Remarks',
  'Voucher No',
  'Voucher Date',
  'Beneficiary E-mail',
  'Beneficiary Mobile',
] as const;

export function exportEPayments(ctx: CompanyCtx, input: EPaymentExportInput): EPaymentExportResult {
  const { db } = ctx;
  requirePermission(ctx, 'vouchers.view', 'view vouchers');
  const ids = [...new Set(input.voucherIds)];
  if (ids.length === 0) throw validation([{ path: 'voucherIds', message: 'Choose the payments to put in the file' }]);
  if (ids.length > EPAYMENT_MAX_ROWS) throw validation([{ path: 'voucherIds', message: `Put at most ${EPAYMENT_MAX_ROWS} payments in one file` }]);
  const today = ctx.clock.today();
  if (input.valueDate !== undefined && input.valueDate < today) {
    throw validation([{ path: 'valueDate', message: `The value date cannot be before today (${formatDate(today)}): banks refuse past-dated transfers` }]);
  }
  const rows = db.all<Row>(
    `${PAYMENT_SELECT} WHERE v.id IN (SELECT value FROM json_each(:ids)) AND v.base_type = 'payment' AND v.is_cancelled = 0`,
    { ids: JSON.stringify(ids) },
  );
  const resolved = new Map(resolve(db, rows).map((r) => [r.voucherId, r]));
  const skipped: EPaymentExportResult['skipped'] = [];
  const ready: Resolved[] = [];
  for (const id of ids) {
    const r = resolved.get(id);
    const row = rows.find((x) => x.id === id);
    if (!r) {
      skipped.push({ voucherId: id, label: row ? voucherLabel(row.type_name, row.number, row.date) : `Voucher #${id}`, reason: 'Not a bank-transfer Payment (cancelled, paid by cheque / cash, or from more than one bank line).' });
    } else if (r.problem) {
      skipped.push({ voucherId: id, label: r.voucherLabel, reason: r.problem });
    } else {
      ready.push(r);
    }
  }
  if (ready.length === 0) throw validation([{ path: 'voucherIds', message: skipped[0]?.reason ?? 'None of these payments can go into a payment file' }]);
  const lines = ready.map((r, i) => {
    const valueDate = input.valueDate ?? (r.date < today ? today : r.date);
    return [
      String(i + 1),
      r.mode.toUpperCase(),
      rupees(r.amount),
      ddmmyyyy(valueDate),
      clean(r.beneficiaryName, 50),
      r.accountNo ?? '',
      (r.ifsc ?? '').toUpperCase(),
      clean(r.bankName, 50),
      r.accountType ?? '',
      r.debitAccountNo ?? '',
      r.bankLedgerName,
      clean(r.narration || r.voucherLabel, 30),
      r.voucherLabel.replace(/ dated .*$/, ''),
      ddmmyyyy(r.date),
      r.email ?? '',
      r.mobile ?? '',
    ];
  });
  const csv = toCsv([[...EPAYMENT_COLUMNS], ...lines]);
  const total = ready.reduce((a, r) => a + r.amount, 0);
  const banks = new Set(ready.map((r) => r.bankLedgerId));
  const bankName = banks.size === 1 ? ready[0].bankLedgerName : 'several banks';
  const fileName = `e-payments ${bankName.replace(/[\\/:*?"<>|]+/g, '-')} ${today}.csv`;
  const now = ctx.clock.now().toISOString();
  const batchId = db.run(
    `INSERT INTO epayment_batches (guid, bank_ledger_id, file_name, rows, total, created_by, created_at) VALUES (:g, :b, :f, :n, :t, :by, :now)`,
    { g: randomUUID(), b: banks.size === 1 ? ready[0].bankLedgerId : null, f: fileName, n: ready.length, t: total, by: ctx.session.userId, now },
  ).lastInsertRowid;
  for (const r of ready) db.run('INSERT INTO epayment_batch_items (batch_id, voucher_id, amount) VALUES (:b, :v, :a)', { b: batchId, v: r.voucherId, a: r.amount });
  ctx.audit({
    action: 'export',
    entityType: 'epayment_batch',
    entityId: batchId,
    entityLabel: `${fileName} (${ready.length} payment${ready.length === 1 ? '' : 's'})`,
    after: { format: 'csv', rows: ready.length, total, vouchers: ready.map((r) => r.voucherId) },
  });
  return { bytes: new TextEncoder().encode(csv), fileName, rows: ready.length, total, skipped };
}
