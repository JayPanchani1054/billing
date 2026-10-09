/**
 * Stock Item Vouchers (Tally "Stock Item Vouchers" / item ledger): every voucher that moved the item
 * in the period with inward / outward quantity and value (at cost) and the running closing balance.
 * Opening, closing, every line's cost and each day's closing come from ONE engine replay
 * (traceStockMovements), and the running value is re-based on the engine's closing at the end of
 * every day, so it always agrees with the Stock Summary.
 */
import type { StockItemVoucherRow, StockItemVouchersInput, StockItemVouchersResult } from '../../../shared/types/stock.ts';
import type { Db } from '../../db/db.ts';
import { traceStockMovements } from '../inventory/index.ts';
import { assertPeriod, getItemMeta, godownScope, jsonIds, rateOf, roundQty } from './common.ts';

const PARTICULARS: Record<string, string> = {
  stock_journal: 'Stock Journal',
  physical_stock: 'Physical stock count',
};

export function itemVouchers(db: Db, today: string, input: StockItemVouchersInput): StockItemVouchersResult {
  assertPeriod(input.from, input.to);
  const item = getItemMeta(db, input.itemId);
  godownScope(db, input.godownId); // NOT_FOUND for an unknown godown
  const godownId = input.godownId ?? null;
  const groupName = item.groupId === null ? null : (db.value<string>('SELECT name FROM stock_groups WHERE id = :id', { id: item.groupId }) ?? null);

  const trace = traceStockMovements(db, { from: input.from, to: input.to, today, itemIds: [item.id], godownId, includeSubGodowns: true, traceItemIds: [item.id] });
  const pr = trace.valuation.rows.find((r) => r.itemId === item.id);
  const opening = { qty: pr?.opening.qty ?? 0, value: pr?.opening.value ?? 0 };
  const closing = { qty: pr?.closing.qty ?? 0, value: pr?.closing.value ?? 0 };

  const voucherIds = [...new Set(trace.movements.map((m) => m.voucherId))];
  const headers = new Map(
    db
      .all<{ id: number; number: string | null; date: string; base_type: string; party_name: string | null; type_name: string }>(
        `SELECT v.id, v.number, v.date, v.base_type, v.party_name, vt.name AS type_name
           FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
          WHERE v.id IN (SELECT value FROM json_each(:ids))`,
        { ids: jsonIds(voucherIds) },
      )
      .map((h) => [h.id, h]),
  );
  const godownNames = new Map(db.all<{ id: number; name: string }>('SELECT id, name FROM godowns').map((g) => [g.id, g.name]));
  const dayClose = trace.closing.get(item.id);

  const rows: StockItemVoucherRow[] = [];
  let runQty = opening.qty;
  let runValue = opening.value;
  const totals = { inwardQty: 0, inwardValue: 0, outwardQty: 0, outwardValue: 0 };
  const ms = trace.movements;
  let i = 0;
  while (i < ms.length) {
    const first = ms[i];
    let j = i;
    const gset = new Set<string>();
    let inQ = 0;
    let inV = 0;
    let outQ = 0;
    let outV = 0;
    while (j < ms.length && ms[j].voucherId === first.voucherId) {
      const m = ms[j];
      const v = trace.values.get(m.id) ?? 0;
      if (m.qty > 0) {
        inQ += m.qty;
        inV += v;
      } else {
        outQ += -m.qty;
        outV += v;
      }
      if (m.godownId !== null) gset.add(godownNames.get(m.godownId) ?? '');
      j++;
    }
    i = j;
    inQ = roundQty(inQ);
    outQ = roundQty(outQ);
    runQty = roundQty(runQty + inQ - outQ);
    runValue += inV - outV;
    // Last voucher of its day: re-base on the engine's closing (absorbs any re-pricing).
    if (i >= ms.length || ms[i].date !== first.date) {
      const c = dayClose?.get(first.date);
      if (c) {
        runQty = c.qty;
        runValue = c.value;
      }
    }
    const h = headers.get(first.voucherId);
    const baseType = h?.base_type ?? first.baseType;
    rows.push({
      key: `v:${first.voucherId}`,
      voucherId: first.voucherId,
      date: first.date,
      voucherTypeName: h?.type_name ?? baseType,
      baseType,
      number: h?.number ?? null,
      particulars: h?.party_name || PARTICULARS[baseType] || h?.type_name || baseType,
      godowns: [...gset].filter((g) => g !== '').join(', '),
      inward: { qty: inQ, value: inV },
      outward: { qty: outQ, value: outV },
      closing: { qty: runQty, value: runValue },
    });
    totals.inwardQty += inQ;
    totals.inwardValue += inV;
    totals.outwardQty += outQ;
    totals.outwardValue += outV;
  }
  totals.inwardQty = roundQty(totals.inwardQty);
  totals.outwardQty = roundQty(totals.outwardQty);

  return {
    item: {
      id: item.id,
      name: item.name,
      unit: item.unit,
      unitDecimals: item.unitDecimals,
      groupId: item.groupId,
      groupName,
      costingMethod: item.costingMethod,
      isService: item.isService,
    },
    from: input.from,
    to: input.to,
    godownId,
    opening,
    rows,
    totals,
    closing: { ...closing, rate: rateOf(closing.value, closing.qty) },
  };
}
