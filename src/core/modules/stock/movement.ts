/**
 * Movement Analysis: how much of an item (or a stock group's items) came in from each party and went
 * out to each party in a period, with quantity, value and average rate.
 *
 * Basis: the lines that physically moved the stock (the engine's stock filter). A delivery/receipt
 * note counts when the goods moved; the invoice that later bills it moves no stock and is not
 * counted again. Value is the line value before GST (qty × rate less discount, or the invoice's
 * taxable value). Stock journals and physical stock have no party: their quantities are reported
 * separately in `internal`.
 */
import { roundTo } from '../../../shared/money.ts';
import type { MovementItemRow, MovementPartyRow, MovementSide, StockMovementInput, StockMovementResult } from '../../../shared/types/stock.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { assertPeriod, EPS, getItemMeta, itemsInGroup, jsonIds, loadItems, loadMovements, QtySum, roundQty, type ItemMeta } from './common.ts';

const INWARD = new Set(['purchase', 'receipt_note', 'rejection_in', 'credit_note']);
const OUTWARD = new Set(['sales', 'delivery_note', 'rejection_out', 'debit_note']);

function avg(value: number, qty: number | null): number | null {
  return qty === null || Math.abs(qty) < EPS ? null : roundTo(value / qty / 100, 4);
}

interface PartyAcc {
  ledgerId: number | null;
  name: string;
  vouchers: Set<number>;
  items: Map<number, { qty: number; value: number }>;
}

function side(accs: Map<string, PartyAcc>, items: Map<number, ItemMeta>): MovementSide {
  const rows: MovementPartyRow[] = [];
  const sideQty = new QtySum();
  let sideValue = 0;
  for (const [key, a] of accs) {
    const q = new QtySum();
    let value = 0;
    const itemRows: MovementItemRow[] = [];
    for (const [itemId, iv] of a.items) {
      const it = items.get(itemId);
      if (!it) continue;
      const qty = roundQty(iv.qty);
      itemRows.push({ itemId, itemName: it.name, unit: it.unit, qty, value: iv.value, avgRate: avg(iv.value, qty) });
      q.add(it.unit, qty);
      sideQty.add(it.unit, qty);
      value += iv.value;
    }
    itemRows.sort((x, y) => y.value - x.value || x.itemName.localeCompare(y.itemName));
    const qty = q.result();
    rows.push({ key, partyLedgerId: a.ledgerId, partyName: a.name, qty, value, avgRate: avg(value, qty), vouchers: a.vouchers.size, items: itemRows });
    sideValue += value;
  }
  rows.sort((x, y) => y.value - x.value || x.partyName.localeCompare(y.partyName));
  const qty = sideQty.result();
  return { rows, qty, value: sideValue, avgRate: avg(sideValue, qty) };
}

export function stockMovement(db: Db, today: string, input: StockMovementInput): StockMovementResult {
  assertPeriod(input.from, input.to);
  if (input.itemId !== undefined && input.groupId !== undefined) {
    throw validation([{ path: 'groupId', message: 'Choose either one stock item or one stock group, not both.' }]);
  }
  const items = loadItems(db);
  let scope: Set<number> | null = null;
  if (input.itemId !== undefined) scope = new Set([getItemMeta(db, input.itemId).id]);
  else scope = itemsInGroup(db, input.groupId);
  const movements = scope && scope.size === 0 ? [] : loadMovements(db, { from: input.from, to: input.to, today, itemIds: scope });

  const parties = new Map(
    db
      .all<{ id: number; party_ledger_id: number | null; party_name: string | null; ledger_name: string | null }>(
        `SELECT v.id, v.party_ledger_id, v.party_name, l.name AS ledger_name FROM vouchers v LEFT JOIN ledgers l ON l.id = v.party_ledger_id
          WHERE v.id IN (SELECT value FROM json_each(:ids))`,
        { ids: jsonIds(new Set(movements.map((m) => m.voucherId))) },
      )
      .map((r) => [r.id, r]),
  );
  const inward = new Map<string, PartyAcc>();
  const outward = new Map<string, PartyAcc>();
  const internalIn = new QtySum();
  const internalOut = new QtySum();
  const internalVouchers = new Set<number>();
  const unitScope = new QtySum();
  for (const id of scope ?? items.keys()) {
    const it = items.get(id);
    if (it && !it.isService) unitScope.add(it.unit, 0);
  }

  for (const m of movements) {
    const it = items.get(m.itemId);
    if (!it) continue;
    const dir = m.qty > 0 ? INWARD : OUTWARD;
    if (!dir.has(m.baseType)) {
      // Stock journals, physical stock (and any reversal line) have no trading party.
      (m.qty > 0 ? internalIn : internalOut).add(it.unit, Math.abs(m.qty));
      internalVouchers.add(m.voucherId);
      continue;
    }
    const p = parties.get(m.voucherId);
    const ledgerId = p?.party_ledger_id ?? null;
    const key = `p:${ledgerId ?? 0}`;
    const accs = m.qty > 0 ? inward : outward;
    let a = accs.get(key);
    if (!a) {
      a = { ledgerId, name: p?.ledger_name || p?.party_name || 'Without a party', vouchers: new Set(), items: new Map() };
      accs.set(key, a);
    }
    a.vouchers.add(m.voucherId);
    const iv = a.items.get(m.itemId) ?? { qty: 0, value: 0 };
    iv.qty += Math.abs(m.qty);
    iv.value += Math.abs(m.amount);
    a.items.set(m.itemId, iv);
  }

  return {
    from: input.from,
    to: input.to,
    itemId: input.itemId ?? null,
    groupId: input.groupId ?? null,
    unit: unitScope.commonUnit(),
    inward: side(inward, items),
    outward: side(outward, items),
    internal: { inwardQty: internalIn.unit === undefined ? 0 : internalIn.result(), outwardQty: internalOut.unit === undefined ? 0 : internalOut.result(), vouchers: internalVouchers.size },
  };
}
