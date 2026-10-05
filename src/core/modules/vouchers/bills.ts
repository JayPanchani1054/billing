/**
 * Bill-wise details: pending bills of a ledger (opening_bills + bill_allocations, books filter), netted
 * per bill name. Amounts are signed like ledger entries: Dr + (receivable), Cr − (payable).
 */
import type { PendingBill } from '../../../shared/types/vouchers.ts';
import type { Db } from '../../db/db.ts';

interface PendingRow {
  bill_name: string;
  origin_date: string | null;
  any_date: string;
  due_date: string | null;
  amount: number;
  original_amount: number;
  has_opening: number;
  voucher_id: number | null;
}

/**
 * Open bills of `ledgerId` as of `asOf`. A voucher's allocations count when it is in the books
 * (affects_books = 1 and not a future post-dated voucher relative to `today`). `excludeVoucherId`
 * leaves out one voucher (the voucher being altered).
 */
export function pendingBills(db: Db, ledgerId: number, asOf: string, today: string, excludeVoucherId?: number | null): PendingBill[] {
  const rows = db.all<PendingRow>(
    `SELECT bill_name,
            MIN(CASE WHEN src IN ('opening', 'new', 'advance') THEN bdate END) AS origin_date,
            MIN(bdate) AS any_date,
            MAX(due_date) AS due_date,
            SUM(amount) AS amount,
            SUM(CASE WHEN src IN ('opening', 'new', 'advance') THEN amount ELSE 0 END) AS original_amount,
            MAX(CASE WHEN src = 'opening' THEN 1 ELSE 0 END) AS has_opening,
            MIN(CASE WHEN src IN ('new', 'advance') THEN voucher_id END) AS voucher_id
       FROM (
             SELECT ob.bill_name AS bill_name, ob.bill_date AS bdate, ob.due_date AS due_date, ob.amount AS amount,
                    'opening' AS src, NULL AS voucher_id
               FROM opening_bills ob
              WHERE ob.ledger_id = :ledgerId
             UNION ALL
             SELECT ba.bill_name, ba.date, ba.due_date, ba.amount, ba.ref_type, ba.voucher_id
               FROM bill_allocations ba
              WHERE ba.ledger_id = :ledgerId
                AND ba.affects_books = 1
                AND (ba.is_post_dated = 0 OR ba.date <= :today)
                AND ba.date <= :asOf
                AND ba.voucher_id <> :exclude
                AND ba.ref_type <> 'on_account'
                AND ba.bill_name IS NOT NULL
            )
      GROUP BY bill_name
     HAVING SUM(amount) <> 0
      ORDER BY COALESCE(MIN(CASE WHEN src IN ('opening', 'new', 'advance') THEN bdate END), MIN(bdate)), bill_name`,
    { ledgerId, asOf, today, exclude: excludeVoucherId ?? 0 },
  );
  return rows.map((r) => ({
    billName: r.bill_name,
    billDate: r.origin_date ?? r.any_date,
    dueDate: r.due_date,
    amount: r.amount,
    originalAmount: r.original_amount,
    source: r.has_opening === 1 ? 'opening' : 'voucher',
    voucherId: r.has_opening === 1 ? null : r.voucher_id,
  }));
}

/** Pending bills keyed by bill name (lazily loaded per ledger). */
export class PendingBillCache {
  private readonly db: Db;
  private readonly asOf: string;
  private readonly today: string;
  private readonly exclude: number | null;
  private readonly cache = new Map<number, Map<string, PendingBill>>();

  constructor(db: Db, asOf: string, today: string, exclude: number | null) {
    this.db = db;
    this.asOf = asOf;
    this.today = today;
    this.exclude = exclude;
  }

  forLedger(ledgerId: number): Map<string, PendingBill> {
    let m = this.cache.get(ledgerId);
    if (!m) {
      m = new Map(pendingBills(this.db, ledgerId, this.asOf, this.today, this.exclude).map((b) => [b.billName, b]));
      this.cache.set(ledgerId, m);
    }
    return m;
  }
}
