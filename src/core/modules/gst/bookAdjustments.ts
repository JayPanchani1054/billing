/**
 * GST entries in the books that are not invoices (written by the gst voucher hook) and their place in
 * GSTR-3B for a date range (books filter, by voucher date):
 *
 *   advances received − adjusted / refunded (Table 11A − 11B)            → 3.1(a)
 *   reverse-charge journals: liability (+ taxable value) / input credit   → 3.1(d) / 4(A)(3)
 *   ITC reversal journals: rules 38, 42, 43 and s.17(5)                   → 4(B)(1)
 *                          rules 37, 37A and others                       → 4(B)(2)
 *   ITC reclaimed (journal)                                               → 4(A)(5) and 4(D)(1)
 *   bills of entry: IGST / cess paid at customs replace the tax computed
 *   on the import purchase                                                 → 4(A)(1)
 */
import type { Gstr3bBookAdjustments } from '../../../shared/types/gst-plus.ts';
import type { TaxAmounts, TaxHead } from '../../../shared/types/gst-returns.ts';
import type { Db } from '../../db/db.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { zeroTax, zeroTV } from './docs.ts';

const RULES = new Set(['itc_reversal_r42', 'itc_reversal_r43', 'itc_reversal_r38', 'itc_reversal_s17_5']);
const OTHERS = new Set(['itc_reversal_r37', 'itc_reversal_r37a', 'itc_reversal_others']);

export function emptyBookAdjustments(): Gstr3bBookAdjustments {
  return {
    advances: zeroTV(),
    rcmLiability: zeroTV(),
    rcmCredit: zeroTax(),
    reversalRules: zeroTax(),
    reversalOthers: zeroTax(),
    reclaimed: zeroTax(),
    billOfEntry: zeroTax(),
    billOfEntryBlocked: zeroTax(),
  };
}

export const isZeroTax = (t: TaxAmounts): boolean => t.igst === 0 && t.cgst === 0 && t.sgst === 0 && t.cess === 0;

/** `voucherId` (optional): one voucher's rows only (its GSTR-3B effect, filed3b.ts). */
export function bookAdjustments(db: Db, from: string, to: string, today: string, voucherId?: number): Gstr3bBookAdjustments {
  const out = emptyBookAdjustments();
  const params = voucherId === undefined ? { from, to, today } : { from, to, today, vid: voucherId };
  const one = (alias: string): string => (voucherId === undefined ? '' : `AND ${alias}.voucher_id = :vid`);
  for (const r of db.all<{ kind: string; taxable: number; igst: number; cgst: number; sgst: number; cess: number }>(
    `SELECT kind, SUM(taxable_value) AS taxable, SUM(igst) AS igst, SUM(cgst) AS cgst, SUM(sgst) AS sgst, SUM(cess) AS cess
       FROM gst_advance_lines a WHERE a.date >= :from AND a.date <= :to AND ${BOOKS_FILTER('a')} ${one('a')} GROUP BY kind`,
    params,
  )) {
    const s = r.kind === 'received' ? 1 : -1;
    out.advances.taxable += s * r.taxable;
    out.advances.igst += s * r.igst;
    out.advances.cgst += s * r.cgst;
    out.advances.sgst += s * r.sgst;
    out.advances.cess += s * r.cess;
  }
  for (const r of db.all<{ nature: string; head: TaxHead; amount: number; taxable: number }>(
    `SELECT nature, head, SUM(amount) AS amount, SUM(taxable_value) AS taxable
       FROM gst_stat_lines s
      WHERE s.date >= :from AND s.date <= :to AND ${BOOKS_FILTER('s')} ${one('s')}
        AND s.nature NOT IN ('cash_deposit', 'cash_utilised', 'itc_utilised')
      GROUP BY nature, head`,
    params,
  )) {
    if (RULES.has(r.nature)) out.reversalRules[r.head] += r.amount;
    else if (OTHERS.has(r.nature)) out.reversalOthers[r.head] += r.amount;
    else if (r.nature === 'itc_reclaim') out.reclaimed[r.head] += r.amount;
    else if (r.nature === 'rcm_liability') {
      out.rcmLiability[r.head] += r.amount;
      out.rcmLiability.taxable += r.taxable;
    } else if (r.nature === 'rcm_credit') out.rcmCredit[r.head] += r.amount;
  }
  // Bills of entry: BOE tax − tax on the purchase's own gst_lines. A purchase claiming ITC replaces its
  // lines' tax in 4(A)(1); blocked goods (itc_claimed 0, lines marked ineligible) are shown in 4(A)(1)
  // and reversed in 4(B)(1) like other blocked credit — at the BOE amount too.
  for (const r of db.all<{ itc: number; igst: number; cess: number; li: number; lc: number }>(
    `SELECT b.itc_claimed AS itc, COALESCE(SUM(b.igst), 0) AS igst, COALESCE(SUM(b.cess), 0) AS cess,
            COALESCE(SUM((SELECT COALESCE(SUM(g.igst), 0) FROM gst_lines g WHERE g.voucher_id = b.voucher_id AND g.taxability = 'taxable'
                          AND (g.itc_eligibility IS NULL OR g.itc_eligibility <> 'ineligible' OR b.itc_claimed = 0))), 0) AS li,
            COALESCE(SUM((SELECT COALESCE(SUM(g.cess), 0) FROM gst_lines g WHERE g.voucher_id = b.voucher_id AND g.taxability = 'taxable'
                          AND (g.itc_eligibility IS NULL OR g.itc_eligibility <> 'ineligible' OR b.itc_claimed = 0))), 0) AS lc
       FROM gst_bill_of_entry b
      WHERE b.date >= :from AND b.date <= :to AND ${BOOKS_FILTER('b')} ${one('b')}
      GROUP BY b.itc_claimed`,
    params,
  )) {
    out.billOfEntry.igst += r.igst - r.li;
    out.billOfEntry.cess += r.cess - r.lc;
    if (r.itc === 0) {
      out.billOfEntryBlocked.igst += r.igst - r.li;
      out.billOfEntryBlocked.cess += r.cess - r.lc;
    }
  }
  return out;
}

/**
 * Fingerprint of the book adjustments per month (for the GSTR-3B credit chain memo): changes whenever
 * a derived row of those months changes.
 */
export function bookAdjustmentFingerprints(db: Db, from: string, to: string, today: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (ym: string, f: string): void => {
    out.set(ym, `${out.get(ym) ?? ''}${f};`);
  };
  const sql = (table: string, cols: string): string =>
    `SELECT substr(t.date, 1, 7) AS ym, COUNT(*) || ':' || SUM(t.voucher_id) || ':' || SUM((${cols}) % 1000000007) || ':' ||
            SUM(t.affects_books + 2 * (t.is_post_dated = 1 AND t.date > :today)) AS f
       FROM ${table} t WHERE t.date >= :from AND t.date <= :to GROUP BY ym`;
  for (const r of db.all<{ ym: string; f: string }>(sql('gst_advance_lines', 't.taxable_value + 3 * t.igst + 5 * t.cgst + 7 * t.sgst + 11 * t.cess + 13 * length(t.kind)'), { from, to, today })) add(r.ym, `a${r.f}`);
  for (const r of db.all<{ ym: string; f: string }>(sql('gst_stat_lines', 't.amount * (length(t.nature) + 3 * length(t.head)) + t.taxable_value'), { from, to, today })) add(r.ym, `s${r.f}`);
  for (const r of db.all<{ ym: string; f: string }>(sql('gst_bill_of_entry', 't.igst + 3 * t.cess + 5 * t.itc_claimed'), { from, to, today })) add(r.ym, `b${r.f}`);
  return out;
}
