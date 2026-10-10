/**
 * Returns and exchanges from a POS bill. A return is an ordinary Credit Note (the POS Return type by
 * default) saved through vouchers.save with `posBill.returnOfId` = the bill: the goods come back into
 * stock, output GST is reversed (CGST s.34), the refund goes out by the tenders chosen — or as exchange
 * credit taken in goods on a later bill. This file only prepares what the counter shows: the bill's
 * lines with what is still returnable, and the exchange credit still open.
 */
import type { PosExchangeCredit, PosReturnContext, PosReturnContextInput, PosReturnLine, PosTenderView } from '../../../shared/types/pos.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import { getVoucher } from '../vouchers/queries.ts';
import { ledgerClass } from '../accounts/books.ts';
import { returnedQty } from './hook.ts';
import { assertPosEnabled, resolvedReturnTypeId } from './store.ts';

/** Tenders of a saved POS bill / return (magnitudes), in line order. */
export function billTenders(db: Db, voucherId: number): PosTenderView[] {
  return db
    .all<{ mode_id: number; mode_name: string; kind: PosTenderView['kind']; ledger_id: number; ledger_name: string; amount: number; reference: string | null; exchange_voucher_id: number | null }>(
      `SELECT p.mode_id, p.mode_name, p.kind, p.ledger_id, l.name AS ledger_name, p.amount, p.reference, p.exchange_voucher_id
         FROM pos_payments p JOIN ledgers l ON l.id = p.ledger_id WHERE p.voucher_id = :id ORDER BY p.line_no`,
      { id: voucherId },
    )
    .map((r) => ({
      modeId: r.mode_id,
      name: r.mode_name,
      kind: r.kind,
      ledgerId: r.ledger_id,
      ledgerName: r.ledger_name,
      amount: Math.abs(r.amount),
      reference: r.reference,
      exchangeVoucherId: r.exchange_voucher_id,
    }));
}

function findBill(db: Db, input: PosReturnContextInput): number {
  if (input.voucherId !== undefined) return input.voucherId;
  const number = (input.number ?? '').trim();
  if (number === '') throw validation([{ path: 'number', message: 'Enter the number of the bill being returned.' }]);
  const rows = db.all<{ id: number }>(
    `SELECT v.id FROM vouchers v JOIN pos_bills b ON b.voucher_id = v.id
      WHERE b.kind = 'sale' AND v.number = :number COLLATE NOCASE AND v.date <= :date
        AND (:vt IS NULL OR v.voucher_type_id = :vt)
      ORDER BY v.date DESC, v.id DESC LIMIT 1`,
    { number, date: input.date, vt: input.voucherTypeId ?? null },
  );
  if (rows.length === 0) throw validation([{ path: 'number', message: `No POS bill numbered ${number} on or before this date.` }]);
  return rows[0].id;
}

export function returnContext(db: Db, today: string, input: PosReturnContextInput): PosReturnContext {
  assertPosEnabled(db);
  const billId = findBill(db, input);
  const pb = db.get<{ kind: string; bill_value: number }>('SELECT kind, bill_value FROM pos_bills WHERE voucher_id = :id', { id: billId });
  if (!pb || pb.kind !== 'sale') throw notFound('POS bill', billId);
  const v = getVoucher(db, billId);
  if (v.isCancelled) throw rule(`${v.voucherType.name} ${v.number ?? ''} is cancelled; nothing can be returned against it.`);
  if (!v.affectsBooks) throw rule(`${v.voucherType.name} ${v.number ?? ''} is not in the books (optional); nothing can be returned against it.`);
  const items = v.input.items ?? [];
  const meta = new Map<number, { name: string; unit: string; decimals: number; mrp: number | null; inclusive: number }>();
  if (items.length > 0) {
    for (const r of db.all<{ id: number; name: string; unit: string; decimals: number; mrp: number | null; inclusive: number }>(
      `SELECT si.id, si.name, u.symbol AS unit, u.decimal_places AS decimals, si.mrp, si.rate_inclusive_of_tax AS inclusive
         FROM stock_items si JOIN units u ON u.id = si.unit_id WHERE si.id IN (SELECT value FROM json_each(:ids))`,
      { ids: JSON.stringify([...new Set(items.map((i) => i.itemId))]) },
    )) {
      meta.set(r.id, r);
    }
  }
  // Quantities already returned are taken off the bill's lines of that item in order.
  const left = returnedQty(db, billId, today);
  const lines: PosReturnLine[] = items.map((it, index) => {
    const m = meta.get(it.itemId);
    const sold = it.billedQty ?? it.qty;
    const taken = Math.min(sold, left.get(it.itemId) ?? 0);
    left.set(it.itemId, (left.get(it.itemId) ?? 0) - taken);
    return {
      index,
      itemId: it.itemId,
      name: m?.name ?? `Item #${it.itemId}`,
      unit: m?.unit ?? '',
      unitDecimals: m?.decimals ?? 0,
      sold,
      returned: taken,
      returnable: Math.max(0, sold - taken),
      rate: it.rate,
      rateInclusiveOfTax: it.rateInclusiveOfTax ?? m?.inclusive === 1,
      discountPct: it.discountPct ?? 0,
      ledgerId: it.ledgerId ?? null,
      godownId: it.godownId ?? null,
      batchName: it.batchName ?? null,
      mrp: m?.mrp ?? null,
    };
  });
  const returnTypeId = resolvedReturnTypeId(db);
  if (returnTypeId === null) throw rule('There is no active Credit Note voucher type for returns. Activate one under Masters › Voucher Types.');
  // A bill to the walk-in (cash / bank) party is refunded in full; a customer's return may be credited.
  const partyIsCash = v.partyLedgerId !== null && ledgerClass(db, v.partyLedgerId).isCashOrBank;
  return {
    billId,
    billNumber: v.number,
    billDate: v.date,
    voucherTypeName: v.voucherType.name,
    partyLedgerId: v.partyLedgerId,
    partyName: v.party.name ?? v.partyLedgerName,
    placeOfSupply: v.placeOfSupply,
    billValue: pb.bill_value,
    tenders: billTenders(db, billId),
    lines,
    returnVoucherTypeId: returnTypeId,
    walkIn: partyIsCash,
  };
}

const EXCHANGE_SQL = (byParty: boolean): string => `
  SELECT v.id, v.number, v.date, v.party_name,
         -(SELECT COALESCE(SUM(p.amount), 0) FROM pos_payments p
            WHERE p.voucher_id = v.id AND p.kind = 'exchange' AND p.affects_books = 1 AND (p.is_post_dated = 0 OR p.date <= :today)) AS issued,
         (SELECT COALESCE(SUM(u.amount), 0) FROM pos_payments u
            WHERE u.exchange_voucher_id = v.id AND u.affects_books = 1 AND (u.is_post_dated = 0 OR u.date <= :today)) AS used
    FROM pos_bills b JOIN vouchers v ON v.id = b.voucher_id
   WHERE b.kind = 'return' AND b.affects_books = 1 AND (b.is_post_dated = 0 OR b.date <= :today)
     ${byParty ? 'AND v.party_ledger_id = :party' : ''}
     AND EXISTS (SELECT 1 FROM pos_payments e WHERE e.voucher_id = v.id AND e.kind = 'exchange')
   ORDER BY v.date DESC, v.id DESC`;
const EXCHANGE_ALL_SQL = EXCHANGE_SQL(false);
const EXCHANGE_PARTY_SQL = EXCHANGE_SQL(true);

/** Exchange credit issued by POS returns and not yet used (books), newest first. */
export function openExchangeCredits(db: Db, today: string, opts: { partyLedgerId?: number; limit?: number } = {}): PosExchangeCredit[] {
  assertPosEnabled(db);
  const rows = db.all<{ id: number; number: string | null; date: string; party_name: string | null; issued: number; used: number }>(
    opts.partyLedgerId !== undefined ? EXCHANGE_PARTY_SQL : EXCHANGE_ALL_SQL,
    opts.partyLedgerId !== undefined ? { today, party: opts.partyLedgerId } : { today },
  );
  const out: PosExchangeCredit[] = [];
  for (const r of rows) {
    const available = r.issued - r.used;
    if (available <= 0) continue;
    out.push({ voucherId: r.id, number: r.number, date: r.date, partyName: r.party_name, issued: r.issued, used: r.used, available });
    if (out.length >= (opts.limit ?? 50)) break;
  }
  return out;
}
