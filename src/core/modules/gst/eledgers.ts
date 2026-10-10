/**
 * Electronic Cash Ledger and Electronic Credit Ledger as kept in the books (the portal's ledgers are the
 * legal record; compare them with these before filing).
 *
 * Cash ledger: per major head (IGST / CGST / SGST / cess) × minor head (tax / interest / penalty / fee /
 * others) — deposits from GST challans (payment vouchers with challan details) and utilisation from the
 * set-off journals; opening = everything before `from` (books filter). `booksBalance` is the balance of
 * the "GST Electronic Cash Ledger" account, which equals the closing total when every entry to it was
 * made through a challan or a set-off.
 *
 * Credit ledger: per head, from the Input tax ledgers (gst_tax_direction 'input'): opening (incl. their
 * opening balances) — accrued (debits: purchases, reverse charge, bills of entry, reclaims) — reversed
 * (credits other than set-off: purchase returns, supplier credit notes, reversal journals) — utilised
 * (credits by set-off journals, less any debit those journals make for a negative 4(C)) = closing.
 */
import type { CashLedgerRow, CashLedgerTxn, CashMinorHead, CreditLedgerRow, CreditLedgerTxn, ElectronicCashLedger, ElectronicCreditLedger } from '../../../shared/types/gst-plus.ts';
import { CASH_MINOR_HEADS } from '../../../shared/types/gst-plus.ts';
import type { TaxHead } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import type { Db } from '../../db/db.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { statLedgerId } from './statLedgers.ts';

const HEAD_LABELS: Readonly<Record<TaxHead, string>> = { igst: 'Integrated tax', cgst: 'Central tax', sgst: 'State/UT tax', cess: 'Cess' };

export function electronicCashLedger(db: Db, from: string, to: string, today: string): ElectronicCashLedger {
  const rows = new Map<string, CashLedgerRow>();
  for (const h of TAX_HEADS) for (const m of CASH_MINOR_HEADS) rows.set(`${h}|${m}`, { head: h, minor: m, opening: 0, deposited: 0, utilised: 0, closing: 0 });
  for (const r of db.all<{ head: TaxHead; minor: CashMinorHead; nature: string; before: number; within: number }>(
    `SELECT head, COALESCE(minor, 'tax') AS minor, nature,
            SUM(CASE WHEN s.date < :from THEN amount ELSE 0 END) AS before,
            SUM(CASE WHEN s.date >= :from THEN amount ELSE 0 END) AS within
       FROM gst_stat_lines s
      WHERE s.nature IN ('cash_deposit', 'cash_utilised') AND s.date <= :to AND ${BOOKS_FILTER('s')}
      GROUP BY head, minor, nature`,
    { from, to, today },
  )) {
    const row = rows.get(`${r.head}|${r.minor}`);
    if (!row) continue;
    const sign = r.nature === 'cash_deposit' ? 1 : -1;
    row.opening += sign * r.before;
    if (sign > 0) row.deposited += r.within;
    else row.utilised += r.within;
  }
  const list = [...rows.values()];
  for (const r of list) r.closing = r.opening + r.deposited - r.utilised;
  const totals = list.reduce(
    (t, r) => ({ opening: t.opening + r.opening, deposited: t.deposited + r.deposited, utilised: t.utilised + r.utilised, closing: t.closing + r.closing }),
    { opening: 0, deposited: 0, utilised: 0, closing: 0 },
  );
  const txByVoucher = new Map<number, CashLedgerTxn>();
  for (const r of db.all<{ voucher_id: number; number: string | null; date: string; nature: string; head: TaxHead; amount: number; period: string | null; vt: string; cpin: string | null }>(
    `SELECT s.voucher_id, v.number, s.date, s.nature, s.head, s.amount, s.return_period AS period, vt.name AS vt, c.cpin
       FROM gst_stat_lines s JOIN vouchers v ON v.id = s.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN gst_challans c ON c.voucher_id = s.voucher_id
      WHERE s.nature IN ('cash_deposit', 'cash_utilised') AND s.date >= :from AND s.date <= :to AND ${BOOKS_FILTER('s')}
      ORDER BY s.date, s.voucher_id, s.id`,
    { from, to, today },
  )) {
    let t = txByVoucher.get(r.voucher_id);
    if (!t) {
      const deposit = r.nature === 'cash_deposit';
      t = {
        voucherId: r.voucher_id,
        number: r.number,
        date: r.date,
        kind: deposit ? 'deposit' : 'utilised',
        description: deposit ? `Challan${r.cpin ? ` CPIN ${r.cpin}` : ''} (${r.vt} ${r.number ?? ''})`.trim() : `Set-off${r.period ? ` ${r.period}` : ''} (${r.vt} ${r.number ?? ''})`,
        period: r.period,
        igst: 0,
        cgst: 0,
        sgst: 0,
        cess: 0,
      };
      txByVoucher.set(r.voucher_id, t);
    }
    t[r.head] += r.amount;
  }
  const ecl = statLedgerId(db, 'GST_CASH_LEDGER');
  const booksBalance =
    ecl === undefined
      ? 0
      : (db.value<number>('SELECT opening_balance FROM ledgers WHERE id = :id', { id: ecl }) ?? 0) +
        (db.value<number>(`SELECT COALESCE(SUM(amount), 0) FROM ledger_entries le WHERE le.ledger_id = :id AND le.date <= :to AND ${BOOKS_FILTER('le')}`, { id: ecl, to, today }) ?? 0);
  const notes: string[] = [];
  if (booksBalance !== totals.closing) {
    notes.push(
      'The "GST Electronic Cash Ledger" account in the books differs from the challans and set-offs recorded: an entry was made to it without GST details (or it has an opening balance). Use GST › Set-off to post challans and set-offs.',
    );
  }
  notes.push('The portal\'s electronic cash ledger is the legal record; reconcile with it before filing.');
  return { from, to, rows: list, totals, transactions: [...txByVoucher.values()], booksBalance, notes };
}

export function electronicCreditLedger(db: Db, from: string, to: string, today: string): ElectronicCreditLedger {
  const ledgers = db.all<{ id: number; head: string; opening: number }>(
    `SELECT id, lower(gst_duty_head) AS head, opening_balance AS opening FROM ledgers WHERE gst_tax_direction = 'input' AND gst_duty_head IS NOT NULL`,
  );
  const headOf = new Map<number, TaxHead>();
  const rows = new Map<TaxHead, CreditLedgerRow>(TAX_HEADS.map((h) => [h, { head: h, label: HEAD_LABELS[h], opening: 0, accrued: 0, reversed: 0, utilised: 0, closing: 0 }]));
  for (const l of ledgers) {
    const h = l.head as TaxHead;
    if (!rows.has(h)) continue;
    headOf.set(l.id, h);
    (rows.get(h) as CreditLedgerRow).opening += l.opening;
  }
  const notes: string[] = [];
  const txs = new Map<number, CreditLedgerTxn>();
  if (headOf.size > 0) {
    const ids = JSON.stringify([...headOf.keys()]);
    // Opening: one aggregate per ledger (not every entry since the books began).
    for (const r of db.all<{ ledger_id: number; amount: number }>(
      `SELECT le.ledger_id, SUM(le.amount) AS amount FROM ledger_entries le
        WHERE le.ledger_id IN (SELECT value FROM json_each(:ids)) AND le.date < :from AND ${BOOKS_FILTER('le')}
        GROUP BY le.ledger_id`,
      { ids, from, today },
    )) {
      (rows.get(headOf.get(r.ledger_id) as TaxHead) as CreditLedgerRow).opening += r.amount;
    }
    for (const r of db.all<{ ledger_id: number; amount: number; voucher_id: number; date: string; number: string | null; vt: string; setoff: number }>(
      `SELECT le.ledger_id, le.amount, le.voucher_id, le.date, v.number, vt.name AS vt,
              EXISTS (SELECT 1 FROM gst_stat_lines s WHERE s.voucher_id = le.voucher_id AND s.nature IN ('itc_utilised', 'cash_utilised')) AS setoff
         FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
        WHERE le.ledger_id IN (SELECT value FROM json_each(:ids)) AND le.date >= :from AND le.date <= :to AND ${BOOKS_FILTER('le')}
        ORDER BY le.date, le.voucher_id, le.id`,
      { ids, from, to, today },
    )) {
      const h = headOf.get(r.ledger_id) as TaxHead;
      const row = rows.get(h) as CreditLedgerRow;
      let kind: CreditLedgerTxn['kind'];
      if (r.setoff) {
        row.utilised -= r.amount;
        kind = 'utilised';
      } else if (r.amount > 0) {
        row.accrued += r.amount;
        kind = 'accrued';
      } else {
        row.reversed -= r.amount;
        kind = 'reversed';
      }
      const key = r.voucher_id;
      let t = txs.get(key);
      if (!t) {
        t = { voucherId: r.voucher_id, number: r.number, voucherTypeName: r.vt, date: r.date, kind, description: `${r.vt} ${r.number ?? ''}`.trim(), igst: 0, cgst: 0, sgst: 0, cess: 0 };
        txs.set(key, t);
      }
      // Signed effect on the credit balance (accrued +, reversed / utilised −), so the column totals
      // equal closing − opening.
      t[h] += r.amount;
    }
  }
  for (const r of rows.values()) r.closing = r.opening + r.accrued - r.reversed - r.utilised;
  if ([...rows.values()].some((r) => r.closing < 0)) {
    notes.push('A negative closing credit means more credit was reversed or used than booked: check the reversal journals and the set-off.');
  }
  notes.push('Compare with the portal\'s electronic credit ledger (and GSTR-2B) before filing; credit the books hold but the portal does not show cannot be used.');
  return { from, to, rows: [...rows.values()], transactions: [...txs.values()], notes };
}
