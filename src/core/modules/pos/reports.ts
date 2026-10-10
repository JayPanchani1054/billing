/**
 * POS day-end summary and POS register — read only, from the derived rows pos_bills / pos_payments
 * (books filter: regular vouchers, post-dated ones once their date has come; optional and cancelled
 * vouchers never count). Bills and returns are attributed to the user who entered them
 * (vouchers.created_by; name from the voucher's meta) and to the counter typed on the bill.
 */
import { formatMoney } from '../../../shared/format.ts';
import type { PosRegister, PosRegisterInput, PosRegisterRow, PosSummary, PosSummaryInput, PosSummaryTenderRow, PosTenderKind } from '../../../shared/types/pos.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { tenderLabel } from './hook.ts';
import { assertPosEnabled } from './store.ts';

const MAX_REGISTER_LIMIT = 1000;

interface Filter {
  where: string;
  params: Record<string, string | number>;
}

/**
 * WHERE clause over `pos_bills b JOIN vouchers v` from constant fragments only (never input text);
 * values are bound parameters. A return counts for a type filter through the bill it came from.
 */
function filterOf(input: { from: string; to: string; voucherTypeIds?: number[]; userId?: number | null; counter?: string; modeId?: number; kind?: 'sale' | 'return' }, today: string): Filter {
  if (input.from > input.to) throw validation([{ path: 'from', message: 'The period starts after it ends.' }]);
  const parts = ['b.date BETWEEN :from AND :to', 'b.affects_books = 1', '(b.is_post_dated = 0 OR b.date <= :today)'];
  const params: Record<string, string | number> = { from: input.from, to: input.to, today };
  if (input.voucherTypeIds && input.voucherTypeIds.length > 0) {
    parts.push(`(CASE WHEN b.kind = 'sale' THEN v.voucher_type_id ELSE (SELECT o.voucher_type_id FROM vouchers o WHERE o.id = b.return_of_id) END) IN (SELECT value FROM json_each(:types))`);
    params.types = JSON.stringify(input.voucherTypeIds);
  }
  if (input.userId === null) {
    parts.push('v.created_by IS NULL');
  } else if (input.userId !== undefined) {
    parts.push('v.created_by = :user');
    params.user = input.userId;
  }
  if (input.modeId !== undefined) {
    parts.push('EXISTS (SELECT 1 FROM pos_payments pm WHERE pm.voucher_id = b.voucher_id AND pm.mode_id = :mode)');
    params.mode = input.modeId;
  }
  if (input.counter !== undefined) {
    parts.push(`COALESCE(b.counter, '') = :counter`);
    params.counter = input.counter.trim();
  }
  if (input.kind !== undefined) {
    parts.push('b.kind = :kind');
    params.kind = input.kind;
  }
  return { where: parts.join(' AND '), params };
}

const USER_NAME = `COALESCE(json_extract(v.meta, '$.createdByName'), '')`;

export function posSummary(db: Db, today: string, input: PosSummaryInput): PosSummary {
  assertPosEnabled(db);
  const f = filterOf(input, today);
  const head = db.get<{
    bills: number;
    sales: number;
    taxable: number;
    tax: number;
    returns: number;
    return_value: number;
    return_tax: number;
    credit_sales: number;
    credit_returns: number;
    change_given: number;
  }>(
    `SELECT COALESCE(SUM(b.kind = 'sale'), 0) AS bills,
            COALESCE(SUM(CASE WHEN b.kind = 'sale' THEN b.bill_value END), 0) AS sales,
            COALESCE(SUM(CASE WHEN b.kind = 'sale' THEN v.taxable_amount END), 0) AS taxable,
            COALESCE(SUM(CASE WHEN b.kind = 'sale' THEN v.tax_amount END), 0) AS tax,
            COALESCE(SUM(b.kind = 'return'), 0) AS returns,
            COALESCE(SUM(CASE WHEN b.kind = 'return' THEN b.bill_value END), 0) AS return_value,
            COALESCE(SUM(CASE WHEN b.kind = 'return' THEN v.tax_amount END), 0) AS return_tax,
            COALESCE(SUM(CASE WHEN b.kind = 'sale' THEN b.credit END), 0) AS credit_sales,
            COALESCE(SUM(CASE WHEN b.kind = 'return' THEN b.credit END), 0) AS credit_returns,
            COALESCE(SUM(b.change_due), 0) AS change_given
       FROM pos_bills b JOIN vouchers v ON v.id = b.voucher_id
      WHERE ${f.where}`,
    f.params,
  ) ?? { bills: 0, sales: 0, taxable: 0, tax: 0, returns: 0, return_value: 0, return_tax: 0, credit_sales: 0, credit_returns: 0, change_given: 0 };

  const tenderRows = db.all<{ mode_id: number; name: string; kind: PosTenderKind; ledger_name: string; received: number; refunded: number; count: number }>(
    `SELECT p.mode_id, MAX(p.mode_name) AS name, MAX(p.kind) AS kind, MAX(l.name) AS ledger_name,
            COALESCE(SUM(CASE WHEN p.amount > 0 THEN p.amount END), 0) AS received,
            COALESCE(SUM(CASE WHEN p.amount < 0 THEN -p.amount END), 0) AS refunded,
            COUNT(DISTINCT p.voucher_id) AS count
       FROM pos_bills b JOIN vouchers v ON v.id = b.voucher_id
       JOIN pos_payments p ON p.voucher_id = b.voucher_id
       JOIN ledgers l ON l.id = p.ledger_id
      WHERE ${f.where}
      GROUP BY p.mode_id
      ORDER BY MIN(p.line_no), name`,
    f.params,
  );
  const byTender: PosSummaryTenderRow[] = tenderRows.map((r) => ({
    modeId: r.mode_id,
    name: r.name,
    kind: r.kind,
    ledgerName: r.ledger_name,
    received: r.received,
    refunded: r.refunded,
    net: r.received - r.refunded,
    count: r.count,
  }));
  const kindSum = (kind: PosTenderKind, side: 'received' | 'refunded' | 'net'): number => byTender.filter((t) => t.kind === kind).reduce((a, t) => a + t[side], 0);

  const byUser = db
    .all<{ user_id: number | null; user_name: string; bills: number; sales: number; returns: number; return_value: number }>(
      `SELECT v.created_by AS user_id, MAX(${USER_NAME}) AS user_name,
              COALESCE(SUM(b.kind = 'sale'), 0) AS bills,
              COALESCE(SUM(CASE WHEN b.kind = 'sale' THEN b.bill_value END), 0) AS sales,
              COALESCE(SUM(b.kind = 'return'), 0) AS returns,
              COALESCE(SUM(CASE WHEN b.kind = 'return' THEN b.bill_value END), 0) AS return_value
         FROM pos_bills b JOIN vouchers v ON v.id = b.voucher_id
        WHERE ${f.where}
        GROUP BY v.created_by
        ORDER BY sales DESC`,
      f.params,
    )
    .map((r) => ({
      userId: r.user_id,
      userName: r.user_name || (r.user_id === null ? 'Owner (no login)' : `User #${r.user_id}`),
      bills: r.bills,
      sales: r.sales,
      returns: r.returns,
      returnValue: r.return_value,
      net: r.sales - r.return_value,
    }));

  const byCounter = db
    .all<{ counter: string; bills: number; sales: number; return_value: number }>(
      `SELECT COALESCE(b.counter, '') AS counter,
              COALESCE(SUM(b.kind = 'sale'), 0) AS bills,
              COALESCE(SUM(CASE WHEN b.kind = 'sale' THEN b.bill_value END), 0) AS sales,
              COALESCE(SUM(CASE WHEN b.kind = 'return' THEN b.bill_value END), 0) AS return_value
         FROM pos_bills b JOIN vouchers v ON v.id = b.voucher_id
        WHERE ${f.where}
        GROUP BY COALESCE(b.counter, '')
        ORDER BY counter`,
      f.params,
    )
    .map((r) => ({ counter: r.counter, bills: r.bills, sales: r.sales, returnValue: r.return_value, net: r.sales - r.return_value }));

  return {
    from: input.from,
    to: input.to,
    bills: head.bills,
    sales: head.sales,
    taxable: head.taxable,
    tax: head.tax,
    returns: head.returns,
    returnValue: head.return_value,
    returnTax: head.return_tax,
    net: head.sales - head.return_value,
    creditSales: head.credit_sales,
    creditReturns: head.credit_returns,
    netCash: kindSum('cash', 'net'),
    changeGiven: head.change_given,
    exchangeIssued: kindSum('exchange', 'refunded'),
    exchangeUsed: kindSum('exchange', 'received'),
    mrpSavings: mrpSavings(db, f),
    byTender,
    byUser,
    byCounter,
  };
}

/**
 * Saving against MRP on the bills (current MRP of the item master × quantity − value charged incl.
 * GST, per line, never negative). GST lines carry the charged value per item line; a company without
 * GST lines (unregistered) uses the line value.
 */
function mrpSavings(db: Db, f: Filter): number {
  // Summed in SQL (one row back, not one per bill line — a period summary may cover 60k bills).
  return (
    db.value<number>(
      `SELECT COALESCE(SUM(MAX(0, CAST(ROUND(mrp * qty) AS INTEGER) - charged)), 0) FROM (
         SELECT si.mrp AS mrp, ABS(COALESCE(g.qty, 0)) AS qty, g.taxable_value + g.igst + g.cgst + g.sgst + g.cess AS charged
           FROM pos_bills b JOIN vouchers v ON v.id = b.voucher_id
           JOIN gst_lines g ON g.voucher_id = b.voucher_id AND g.source = 'item'
           JOIN stock_items si ON si.id = g.item_id
          WHERE ${f.where} AND b.kind = 'sale' AND si.mrp > 0 AND g.is_reverse_charge = 0
         UNION ALL
         SELECT si.mrp, ABS(COALESCE(ie.billed_qty, ie.qty)), ie.amount
           FROM pos_bills b JOIN vouchers v ON v.id = b.voucher_id
           JOIN inventory_entries ie ON ie.voucher_id = b.voucher_id
           JOIN stock_items si ON si.id = ie.item_id
          WHERE ${f.where} AND b.kind = 'sale' AND si.mrp > 0
            AND NOT EXISTS (SELECT 1 FROM gst_lines g2 WHERE g2.voucher_id = b.voucher_id)
       )`,
      f.params,
    ) ?? 0
  );
}

export function posRegister(db: Db, today: string, input: PosRegisterInput): PosRegister {
  assertPosEnabled(db);
  const f = filterOf(input, today);
  let where = f.where;
  const params: Record<string, string | number> = { ...f.params };
  const search = (input.search ?? '').trim();
  if (search !== '') {
    where += ` AND (v.number LIKE :like ESCAPE '\\' OR v.party_name LIKE :like ESCAPE '\\')`;
    params.like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }
  const limit = Math.min(input.limit ?? 200, MAX_REGISTER_LIMIT);
  const offset = input.offset ?? 0;
  const sums = db.get<{ n: number; value: number; paid: number; credit: number }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN b.kind = 'sale' THEN b.bill_value ELSE -b.bill_value END), 0) AS value,
            COALESCE(SUM(CASE WHEN b.kind = 'sale' THEN b.paid ELSE -b.paid END), 0) AS paid,
            COALESCE(SUM(CASE WHEN b.kind = 'sale' THEN b.credit ELSE -b.credit END), 0) AS credit
       FROM pos_bills b JOIN vouchers v ON v.id = b.voucher_id WHERE ${where}`,
    params,
  ) ?? { n: 0, value: 0, paid: 0, credit: 0 };
  const rows = db.all<{
    id: number;
    kind: 'sale' | 'return';
    type_name: string;
    number: string | null;
    date: string;
    party_name: string | null;
    bill_value: number;
    paid: number;
    credit: number;
    change_due: number;
    counter: string | null;
    user_name: string;
    return_of_id: number | null;
    return_of_number: string | null;
    is_optional: number;
  }>(
    `SELECT v.id, b.kind, vt.name AS type_name, v.number, v.date, v.party_name, b.bill_value, b.paid, b.credit, b.change_due, b.counter,
            ${USER_NAME} AS user_name, b.return_of_id, (SELECT o.number FROM vouchers o WHERE o.id = b.return_of_id) AS return_of_number, v.is_optional
       FROM pos_bills b JOIN vouchers v ON v.id = b.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE ${where}
      ORDER BY v.date, v.id
      LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset },
  );
  const tenders = new Map<number, string[]>();
  if (rows.length > 0) {
    for (const t of db.all<{ voucher_id: number; mode_name: string; kind: PosTenderKind; amount: number; reference: string | null }>(
      `SELECT voucher_id, mode_name, kind, amount, reference FROM pos_payments WHERE voucher_id IN (SELECT value FROM json_each(:ids)) ORDER BY voucher_id, line_no`,
      { ids: JSON.stringify(rows.map((r) => r.id)) },
    )) {
      const list = tenders.get(t.voucher_id) ?? [];
      list.push(`${tenderLabel(t.mode_name, t.kind, t.reference)} ${formatMoney(Math.abs(t.amount))}`);
      tenders.set(t.voucher_id, list);
    }
  }
  const out: PosRegisterRow[] = rows.map((r) => ({
    voucherId: r.id,
    kind: r.kind,
    voucherTypeName: r.type_name,
    number: r.number,
    date: r.date,
    partyName: r.party_name,
    billValue: r.bill_value,
    paid: r.paid,
    credit: r.credit,
    change: r.change_due,
    tenders: (tenders.get(r.id) ?? []).join(' · '),
    counter: r.counter,
    userName: r.user_name || null,
    returnOf: r.return_of_id !== null ? { id: r.return_of_id, number: r.return_of_number } : null,
    isOptional: r.is_optional === 1,
  }));
  return { rows: out, total: sums.n, sums: { billValue: sums.value, paid: sums.paid, credit: sums.credit } };
}
