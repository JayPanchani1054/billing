import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { OrderKind, PendingOrdersResult } from '../../../shared/types/stock.ts';
import type { Db } from '../../db/db.ts';
import { allPlanProblems, recordSql } from '../../testing/sqlPlans.ts';
import { applyClosures, closedQtyByOrderItem } from '../documents/closures.ts';
import { precloseOrder } from '../documents/orders.ts';
import { trackingRefs } from '../vouchers/queries.ts';
import { cancelVoucher } from '../vouchers/service.ts';
import { roundQty } from './common.ts';
import { orderPositions, pendingOrders, reorderStatus } from './orders.ts';
import { stockRoutes } from './routes.ts';
import { inventoryVoucher, invoice, post, stockMasters, stockScenario, type StockKit } from './testkit.ts';

describe('stock.pendingOrders', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('purchase order 1: 50 ordered, 20 received, 30 pending worth ₹3,600, overdue since 25-May', () => {
    const r = pendingOrders(k.t.db, { kind: 'purchase', asOf: '2026-06-30' });
    assert.equal(r.rows.length, 1);
    const l = r.rows[0];
    assert.deepEqual(
      [l.orderNo, l.partyName, l.itemName, l.orderedQty, l.fulfilledQty, l.pendingQty, l.rate, l.pendingValue, l.dueDate, l.overdueDays],
      // 30 × ₹120 = 3,60,000 paise; 25-May → 30-Jun = 6 + 30 = 36 days
      ['1', 'Supreme Suppliers', 'Steel Tumbler', 50, 20, 30, 120, 3_60_000, '2026-05-25', 36],
    );
    assert.deepEqual(r.totals, { orders: 1, pendingValue: 3_60_000, overdueLines: 1 });
  });

  test('sales order 1: 10 ordered, 4 delivered, 6 pending; no due date → never overdue', () => {
    const r = pendingOrders(k.t.db, { kind: 'sales', asOf: '2026-06-30' });
    assert.deepEqual(
      r.rows.map((l) => [l.partyName, l.orderedQty, l.fulfilledQty, l.pendingQty, l.pendingValue, l.overdueDays]),
      // 6 × ₹170 = 1,02,000
      [['Metro Retail', 10, 4, 6, 1_02_000, null]],
    );
  });

  test('as of an earlier date: the receipt note of 20-May has not happened yet; before the order date nothing is pending', () => {
    assert.deepEqual(
      pendingOrders(k.t.db, { kind: 'purchase', asOf: '2026-05-19' }).rows.map((l) => [l.pendingQty, l.overdueDays]),
      [[50, null]],
    );
    assert.deepEqual(pendingOrders(k.t.db, { kind: 'purchase', asOf: '2026-05-14' }).rows, []);
  });

  test('agrees with the vouchers module tracking (vouchers.trackingRefs) as of today', () => {
    const open = trackingRefs(k.t.db, k.L.supreme, 'purchase_order');
    assert.deepEqual(open.map((d) => d.lines.map((x) => x.pendingQty)), [[30]]);
  });
});

describe('order fulfilment rules', () => {
  test('an invoice billing a delivery note that fulfilled the order is not counted twice; a direct invoice is', () => {
    const m = stockMasters();
    const k = { ...m, V: {} };
    try {
      post(k, inventoryVoucher(m, 'sales_order', '2026-06-01', [{ itemId: m.I.A, qty: 8, rate: 150 }], { partyLedgerId: m.L.acme }));
      post(k, inventoryVoucher(m, 'delivery_note', '2026-06-02', [{ itemId: m.I.A, qty: 3, rate: 150, orderRef: '1' }], { partyLedgerId: m.L.acme }));
      post(k, invoice(m, 'sales', '2026-06-03', m.L.acme, [{ itemId: m.I.A, qty: 3, rate: 150, trackingRef: '1', orderRef: '1' }]));
      post(k, invoice(m, 'sales', '2026-06-04', m.L.acme, [{ itemId: m.I.A, qty: 2, rate: 150, orderRef: '1' }]));
      // ordered 8 − delivered 3 (note) − invoiced directly 2 = 3 pending (the billing invoice adds nothing)
      const r = pendingOrders(m.t.db, { kind: 'sales', asOf: '2026-06-30' });
      assert.deepEqual(r.rows.map((l) => [l.fulfilledQty, l.pendingQty]), [[5, 3]]);
    } finally {
      m.t.close();
    }
  });

  test('cancelled and optional orders are not pending', () => {
    const m = stockMasters();
    const k = { ...m, V: {} };
    try {
      post(k, inventoryVoucher(m, 'purchase_order', '2026-06-01', [{ itemId: m.I.A, qty: 5, rate: 100 }], { partyLedgerId: m.L.supreme, isOptional: true }));
      assert.deepEqual(pendingOrders(m.t.db, { kind: 'purchase', asOf: '2026-06-30' }).rows, []);
    } finally {
      m.t.close();
    }
  });
});

describe('order lines told apart by their descriptions (2.2: the Alt+T rule)', () => {
  // Sales Order 1 (Acme), Steel Tumbler: Red 5 @ ₹200 and Blue 5 @ ₹250. Alt+T gave both lines; Blue went
  // first on Delivery Note 1 (05-Jun), and only 3 red were in stock, invoiced directly on 10-Jun.
  function redBlue(): { m: ReturnType<typeof stockMasters>; so: number } {
    const m = stockMasters();
    const k = { ...m, V: {} };
    const so = post(
      k,
      inventoryVoucher(
        m,
        'sales_order',
        '2026-06-01',
        [
          { itemId: m.I.A, qty: 5, rate: 200, description: 'Red' },
          { itemId: m.I.A, qty: 5, rate: 250, description: 'Blue' },
        ],
        { partyLedgerId: m.L.acme },
      ),
    ).id;
    post(k, inventoryVoucher(m, 'delivery_note', '2026-06-05', [{ itemId: m.I.A, qty: 5, rate: 250, orderRef: '1', description: 'Blue' }], { partyLedgerId: m.L.acme }));
    post(k, invoice(m, 'sales', '2026-06-10', m.L.acme, [{ itemId: m.I.A, qty: 3, rate: 200, orderRef: '1', description: 'Red' }]));
    return { m, so };
  }
  const offered = (db: Db, party: number, kind: 'sales_order' | 'purchase_order') =>
    trackingRefs(db, party, kind).flatMap((d) => d.lines.map((l) => [l.description, l.pendingQty]));

  test('Red 2 is pending, valued at Red’s rate — the line the Alt+T picker offers (in line order alone it read Blue 2)', async () => {
    const { m, so } = redBlue();
    try {
      const r = await m.t.callOk<PendingOrdersResult>(stockRoutes, 'stock.pendingOrders', { kind: 'sales', asOf: '2026-06-30' });
      assert.deepEqual(
        r.rows.map((l) => [l.key, l.orderedQty, l.fulfilledQty, l.pendingQty, l.rate, l.pendingValue]),
        // 2 × ₹200 = 40,000 paise (Blue 2 × ₹250 would be 50,000)
        [[`o:${so}:1`, 5, 3, 2, 200, 40_000]],
      );
      assert.deepEqual(r.totals, { orders: 1, pendingValue: 40_000, overdueLines: 0 });
      assert.deepEqual(offered(m.t.db, m.L.acme, 'sales_order'), [['Red', 2], ['Blue', 0]]);
      // Each line keeps its own text in the positions (Reorder Status and pre-close read the same rows).
      assert.deepEqual(
        orderPositions(m.t.db, 'sales', '2026-06-30').map((p) => [p.line_no, p.description, p.fulfilled, p.pending]),
        [[1, 'Red', 3, 2], [2, 'Blue', 5, 0]],
      );
      // Reorder Status: 10 opening − 5 delivered − 3 invoiced = 2 on hand, 2 still to go out.
      const [row] = reorderStatus(m.t.db, m.t.today, { asOf: '2026-06-30' }).rows;
      assert.deepEqual([row.closingQty, row.pendingSalesQty, row.netAvailable], [2, 2, 0]);
    } finally {
      m.t.close();
    }
  });

  test('three statements per kind (lines, what fulfils them grouped by text, closures), each through an index', () => {
    const { m } = redBlue();
    try {
      const rec = recordSql(m.t.db);
      rec.start();
      orderPositions(m.t.db, 'sales', '2026-06-30');
      orderPositions(m.t.db, 'purchase', '2026-06-30');
      const statements = rec.stop();
      // No look-up per line or per text, however many orders and descriptions there are.
      assert.equal(statements.length, 6);
      assert.ok(statements.some((s) => /GROUP BY v\.party_ledger_id, ie\.order_ref, ie\.item_id, ie\.description$/.test(s.sql.replace(/\s+/g, ' ').trim())));
      assert.deepEqual(allPlanProblems(m.t.db, statements, 'orderPositions'), []);
    } finally {
      m.t.close();
    }
  });

  test('as of a past date only what was fulfilled by then counts: on 07-Jun Blue is delivered and Red 5 is pending', () => {
    const { m, so } = redBlue();
    try {
      const r = pendingOrders(m.t.db, { kind: 'sales', asOf: '2026-06-07' });
      // 5 × ₹200 = 1,00,000 (in line order alone: Red fulfilled, Blue 5 × ₹250 = 1,25,000 pending)
      assert.deepEqual(r.rows.map((l) => [l.key, l.fulfilledQty, l.pendingQty, l.pendingValue]), [[`o:${so}:1`, 0, 5, 1_00_000]]);
    } finally {
      m.t.close();
    }
  });

  test('a purchase order received out of line order: the line received under its own text is the one fulfilled', () => {
    const m = stockMasters();
    const k = { ...m, V: {} };
    try {
      const po = post(
        k,
        inventoryVoucher(
          m,
          'purchase_order',
          '2026-06-01',
          [
            { itemId: m.I.A, qty: 10, rate: 120, description: '18 cm' },
            { itemId: m.I.A, qty: 10, rate: 150, description: '22 cm' },
          ],
          { partyLedgerId: m.L.supreme, effectiveDate: '2026-06-15' },
        ),
      ).id;
      // 22 cm came in full on Receipt Note 1 (the purchase invoice billing it adds nothing); 4 of 18 cm were invoiced directly.
      post(k, inventoryVoucher(m, 'receipt_note', '2026-06-08', [{ itemId: m.I.A, qty: 10, rate: 150, orderRef: '1', description: '22 cm' }], { partyLedgerId: m.L.supreme }));
      post(k, invoice(m, 'purchase', '2026-06-09', m.L.supreme, [{ itemId: m.I.A, qty: 10, rate: 150, trackingRef: '1', orderRef: '1', description: '22 cm' }]));
      post(k, invoice(m, 'purchase', '2026-06-12', m.L.supreme, [{ itemId: m.I.A, qty: 4, rate: 120, orderRef: '1', description: '18 cm' }]));
      const r = pendingOrders(m.t.db, { kind: 'purchase', asOf: '2026-06-30' });
      assert.deepEqual(
        r.rows.map((l) => [l.key, l.fulfilledQty, l.pendingQty, l.pendingValue, l.overdueDays]),
        // 6 × ₹120 = 72,000, due 15-Jun (in line order alone: 18 cm fulfilled, 22 cm 6 × ₹150 = 90,000)
        [[`o:${po}:1`, 4, 6, 72_000, 15]],
      );
      assert.deepEqual(offered(m.t.db, m.L.supreme, 'purchase_order'), [['18 cm', 6], ['22 cm', 0]]);
    } finally {
      m.t.close();
    }
  });

  test('pre-closed: the closure still comes off the order’s last lines first, after each line took its own fulfilment', () => {
    const m = stockMasters();
    const k = { ...m, V: {} };
    try {
      // Red 5 @ ₹200, Blue 5 @ ₹250, Green 5 @ ₹300; invoiced Red 3 and Blue 5 → Red 2, Blue 0, Green 5 pending.
      const so = post(
        k,
        inventoryVoucher(
          m,
          'sales_order',
          '2026-06-01',
          [
            { itemId: m.I.A, qty: 5, rate: 200, description: 'Red' },
            { itemId: m.I.A, qty: 5, rate: 250, description: 'Blue' },
            { itemId: m.I.A, qty: 5, rate: 300, description: 'Green' },
          ],
          { partyLedgerId: m.L.acme },
        ),
      ).id;
      post(
        k,
        invoice(m, 'sales', '2026-06-10', m.L.acme, [
          { itemId: m.I.A, qty: 3, rate: 200, orderRef: '1', description: 'Red' },
          { itemId: m.I.A, qty: 5, rate: 250, orderRef: '1', description: 'Blue' },
        ]),
      );
      // 6 of the 7 pending pre-closed on 20-Jun: Green's 5 (the last line), then 1 of Red (Blue has none pending).
      precloseOrder(m.t.ctx, { orderId: so, date: '2026-06-20', reason: 'Customer reduced the order', items: [{ itemId: m.I.A, qty: 6 }] });
      const rows = (asOf: string) => pendingOrders(m.t.db, { kind: 'sales', asOf }).rows.map((l) => [l.key, l.pendingQty, l.closedQty ?? 0, l.pendingValue]);
      // In line order alone: Blue 2 and Green 5 pending, the closure Green 5 + Blue 1 → Blue 1 × ₹250 left.
      assert.deepEqual(rows('2026-06-30'), [[`o:${so}:1`, 1, 1, 20_000]]);
      assert.deepEqual(rows('2026-06-15'), [[`o:${so}:1`, 2, 0, 40_000], [`o:${so}:3`, 5, 0, 1_50_000]], 'not yet closed on 15-Jun');
      assert.deepEqual(offered(m.t.db, m.L.acme, 'sales_order'), [['Red', 1], ['Blue', 0], ['Green', 0]]);
      assert.deepEqual(
        orderPositions(m.t.db, 'sales', '2026-06-30').map((p) => [p.description, p.fulfilled, p.closed, p.pending]),
        [['Red', 3, 1, 1], ['Blue', 5, 0, 0], ['Green', 0, 5, 0]],
      );
    } finally {
      m.t.close();
    }
  });
});

// ───────────────────────────── Seeded random books ─────────────────────────────

/** `orderPositions` before 2.2 — line order only — kept as the reference for books without matching texts. */
function lineOrderPositions(db: Db, kind: OrderKind, asOf: string) {
  const [orderBase, noteBase, invoiceBase] = kind === 'sales' ? ['sales_order', 'delivery_note', 'sales'] : ['purchase_order', 'receipt_note', 'purchase'];
  const lines = db.all<{
    voucher_id: number;
    line_no: number;
    number: string | null;
    date: string;
    due: string | null;
    party_ledger_id: number | null;
    party_name: string | null;
    ref: string;
    item_id: number;
    qty: number;
    rate: number;
    discount_pct: number;
  }>(
    `SELECT ie.voucher_id, ie.line_no, v.number, v.date, v.effective_date AS due, v.party_ledger_id,
            COALESCE(l.name, v.party_name) AS party_name, ie.order_ref AS ref, ie.item_id, ABS(ie.qty) AS qty, ie.rate, ie.discount_pct
       FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id LEFT JOIN ledgers l ON l.id = v.party_ledger_id
      WHERE v.base_type = :base AND v.is_cancelled = 0 AND v.is_optional = 0 AND v.date <= :asOf AND ie.order_ref IS NOT NULL
      ORDER BY v.date, v.id, ie.line_no`,
    { base: orderBase, asOf },
  );
  const consumed = new Map<string, number>();
  for (const c of db.all<{ party: number | null; ref: string; item_id: number; qty: number }>(
    `SELECT v.party_ledger_id AS party, ie.order_ref AS ref, ie.item_id, SUM(ABS(ie.qty)) AS qty
       FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
      WHERE v.is_cancelled = 0 AND v.is_optional = 0 AND v.date <= :asOf AND ie.order_ref IS NOT NULL
        AND (v.base_type = :note OR (v.base_type = :invoice AND ie.tracking_ref IS NULL))
      GROUP BY v.party_ledger_id, ie.order_ref, ie.item_id`,
    { asOf, note: noteBase, invoice: invoiceBase },
  )) {
    consumed.set(`${c.party ?? 0}|${c.ref}|${c.item_id}`, Number(c.qty));
  }
  const out = lines.map((l) => {
    const key = `${l.party_ledger_id ?? 0}|${l.ref}|${l.item_id}`;
    const left = consumed.get(key) ?? 0;
    const take = Math.min(left, Number(l.qty));
    consumed.set(key, left - take);
    return { ...l, qty: Number(l.qty), fulfilled: roundQty(take), closed: 0, pending: roundQty(Number(l.qty) - take) };
  });
  applyClosures(
    out,
    closedQtyByOrderItem(db, asOf),
    (l) => ({ orderId: l.voucher_id, itemId: l.item_id, pending: l.pending }),
    (l, pending, closed) => {
      l.pending = roundQty(pending);
      l.closed = roundQty(l.closed + closed);
    },
  );
  return out;
}

/** A small deterministic generator (mulberry32): `rnd(n)` is 0 … n − 1. */
function prng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

const ORDER_TEXTS = [null, 'Red', 'Blue', 'Green'] as const;
/** Never an order line's own text ('red': the case differs). */
const OTHER_TEXTS = [null, 'Gift wrapped', 'red'] as const;

/**
 * Seeded random books posted through the vouchers service. For each kind: 6 orders of 2–4 lines (Steel
 * Tumbler most often, Copper Bottle, Sugar in Kg with fractional quantities), the lines of an order with
 * different texts from ORDER_TEXTS (one may have none); 16 notes and direct invoices fulfilling them —
 * mostly the order's party and number (a few another party, or no such order), a line mostly one of the
 * order's lines with a smaller quantity, as Alt+T brings it and the user edits it (sometimes another
 * item), some optional, some cancelled; invoices billing some of the notes (they add nothing); and
 * pre-closures of a few order items. A fulfilling line keeps its order line's text when `ownTexts` (three
 * times in four; else one of OTHER_TEXTS), and always takes one of OTHER_TEXTS otherwise.
 */
function randomBooks(seed: number, ownTexts: boolean): { m: ReturnType<typeof stockMasters>; asOfs: string[]; parties: Record<OrderKind, number[]> } {
  const m = stockMasters();
  const k = { ...m, V: {} };
  const rnd = prng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[rnd(xs.length)];
  const sugar = m.t.addStockItem({ name: 'Sugar', unit: 'Kg', gstRate: 5, hsnSac: '1701', openingQty: 1_000, openingRate: 40 });
  const items = [m.I.A, m.I.A, m.I.A, m.I.F, sugar];
  // Orders run larger than what each note or invoice takes, so lines stay partly pending.
  const ordered = (itemId: number): number => (itemId === sugar ? pick([1.5, 2.75, 3.125]) : pick([3, 5, 8, 10]));
  const taken = (itemId: number): number => (itemId === sugar ? pick([0.1, 0.2, 0.3, 0.125, 0.5]) : pick([1, 2, 3]));
  const dates = Array.from({ length: 12 }, (_, i) => `2026-06-${String(2 + 2 * i).padStart(2, '0')}`);
  const parties: Record<OrderKind, number[]> = { sales: [m.L.acme, m.L.metro], purchase: [m.L.supreme, m.L.bharat] };
  const spec = {
    sales: { order: 'sales_order', note: 'delivery_note', invoice: 'sales' },
    purchase: { order: 'purchase_order', note: 'receipt_note', invoice: 'purchase' },
  } as const;
  let refNo = 0;
  for (const kind of ['sales', 'purchase'] as const) {
    const s = spec[kind];
    const orders: Array<{ id: number; no: string; party: number; lines: Array<{ itemId: number; description?: string }> }> = [];
    for (let i = 0; i < 6; i++) {
      const party = pick(parties[kind]);
      // The lines of an order differ in their texts (one of them may have none), as lines of one item told apart.
      const first = rnd(ORDER_TEXTS.length);
      const lines = Array.from({ length: 2 + rnd(3) }, (_, j) => {
        const itemId = pick(items);
        return { itemId, qty: ordered(itemId), rate: pick([100, 150, 200]), description: ORDER_TEXTS[(first + j) % ORDER_TEXTS.length] ?? undefined };
      });
      const r = post(k, inventoryVoucher(m, s.order, pick(dates), lines, { partyLedgerId: party }));
      orders.push({ id: r.id, no: r.number ?? '', party, lines });
    }
    for (let i = 0; i < 16; i++) {
      const o = pick(orders);
      const party = rnd(8) === 0 ? pick(parties[kind]) : o.party;
      const ref = rnd(10) === 0 ? '99' : o.no;
      const lines = Array.from({ length: 1 + rnd(3) }, () => {
        const from = rnd(5) === 0 ? { itemId: pick(items), description: pick(ORDER_TEXTS) ?? undefined } : pick(o.lines);
        const description = ownTexts && rnd(4) !== 0 ? from.description : (pick(OTHER_TEXTS) ?? undefined);
        return { itemId: from.itemId, qty: taken(from.itemId), rate: pick([100, 150, 200]), orderRef: ref, description };
      });
      const date = pick(dates);
      const isOptional = rnd(10) === 0;
      const asNote = rnd(2) === 0;
      const over = { partyLedgerId: party, isOptional, referenceNo: `R-${++refNo}` };
      const r = post(k, asNote ? inventoryVoucher(m, s.note, date, lines, over) : invoice(m, s.invoice, date, party, lines, over));
      if (rnd(10) === 0) {
        cancelVoucher(m.t.ctx, r.id, 'Entered twice');
      } else if (asNote && !isOptional && rnd(3) === 0) {
        // Billed later (the same lines, with the note's number): the invoice fulfils nothing again.
        const billed = lines.map((l) => ({ ...l, trackingRef: r.number ?? '' }));
        post(k, invoice(m, s.invoice, pick(dates.filter((d) => d >= date)), party, billed, { referenceNo: `R-${++refNo}` }));
      }
    }
    // Pre-closed balances, stored as documents.order.preclose stores them (one row per order + item).
    const closed = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const o = pick(orders);
      const itemId = pick(o.lines).itemId;
      if (closed.has(`${o.id}|${itemId}`)) continue;
      closed.add(`${o.id}|${itemId}`);
      m.t.db.run(
        `INSERT INTO order_closures (voucher_id, item_id, closed_qty, date, reason, created_at) VALUES (:v, :item, :qty, :date, 'Short-closed', :now)`,
        { v: o.id, item: itemId, qty: taken(itemId), date: pick(dates), now: '2026-06-30T10:00:00.000Z' },
      );
    }
  }
  return { m, asOfs: ['2026-06-01', ...dates, '2026-06-30'], parties };
}

describe('order positions on seeded random books', () => {
  const SEEDS = [20261031, 7, 42];
  const withoutText = <T extends { description: string | null }>(rows: T[]) => rows.map(({ description: _, ...rest }) => rest);

  test('no fulfilling line carries an order line’s own text: exactly the line-order result of before 2.2', () => {
    let partly = 0;
    let closures = 0;
    for (const seed of SEEDS) {
      const { m, asOfs } = randomBooks(seed, false);
      try {
        for (const kind of ['sales', 'purchase'] as const) {
          for (const asOf of asOfs) {
            const now = orderPositions(m.t.db, kind, asOf);
            assert.deepEqual(withoutText(now), lineOrderPositions(m.t.db, kind, asOf), `seed ${seed}, ${kind} orders as of ${asOf}`);
            partly += now.filter((p) => p.fulfilled > 0 && p.pending > 0).length;
            closures += now.filter((p) => p.closed > 0).length;
          }
        }
      } finally {
        m.t.close();
      }
    }
    // The books are not trivial: lines partly fulfilled, and closures applied.
    assert.ok(partly > 0 && closures > 0, `${partly} partly fulfilled lines, ${closures} closed`);
  });

  test('with lines fulfilled under their own texts: every line pending as the Alt+T picker offers it; totals per order + item unchanged', () => {
    let moved = 0;
    for (const seed of SEEDS) {
      const { m, parties } = randomBooks(seed, true);
      try {
        for (const kind of ['sales', 'purchase'] as const) {
          const now = orderPositions(m.t.db, kind, '2026-06-30');
          const before = lineOrderPositions(m.t.db, kind, '2026-06-30');
          // Alt+T (vouchers.trackingRefs) lists the orders of a party with something pending, each with all its lines.
          for (const party of parties[kind]) {
            const mine = now.filter((p) => p.party_ledger_id === party);
            const open = [...new Set(mine.map((p) => p.voucher_id))].filter((id) => mine.some((p) => p.voucher_id === id && p.pending > 0));
            assert.deepEqual(
              trackingRefs(m.t.db, party, kind === 'sales' ? 'sales_order' : 'purchase_order').map((d) => [d.voucherId, d.lines.map((l) => [l.description, l.pendingQty])]),
              open.map((id) => [id, mine.filter((p) => p.voucher_id === id).map((p) => [p.description, p.pending])]),
              `seed ${seed}, ${kind} orders of party ${party}`,
            );
          }
          // What each order + item has fulfilled, closed and pending in all is what line order gave.
          const totals = (rows: ReadonlyArray<{ voucher_id: number; item_id: number; fulfilled: number; closed: number; pending: number }>) => {
            const t = new Map<string, number[]>();
            for (const p of rows) {
              const key = `${p.voucher_id}|${p.item_id}`;
              const [f, c, n] = t.get(key) ?? [0, 0, 0];
              t.set(key, [roundQty(f + p.fulfilled), roundQty(c + p.closed), roundQty(n + p.pending)]);
            }
            return t;
          };
          assert.deepEqual(totals(now), totals(before), `seed ${seed}, ${kind}: totals per order + item`);
          moved += now.filter((p, i) => p.pending !== before[i].pending).length;
        }
      } finally {
        m.t.close();
      }
    }
    assert.ok(moved > 0, 'some lines are pending differently from line order (the texts were used)');
  });
});

describe('stock.reorder', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('Steel Tumbler: closing 18 + pending PO 30 − pending SO 6 = 42 < level 50 → short 8, order the minimum 25', () => {
    const r = reorderStatus(k.t.db, k.t.today, { asOf: '2026-06-30' });
    assert.equal(r.itemsWithLevel, 1);
    assert.deepEqual(r.rows, [
      {
        itemId: k.I.A,
        name: 'Steel Tumbler',
        unit: 'Nos',
        groupName: 'Kitchenware',
        closingQty: 18,
        reorderLevel: 50,
        minOrderQty: 25,
        pendingPurchaseQty: 30,
        pendingSalesQty: 6,
        netAvailable: 42,
        shortfall: 8,
        suggestedQty: 25,
      },
    ]);
  });

  test('without a minimum order quantity the suggestion is the shortfall; above the level nothing is listed', () => {
    k.t.db.run('UPDATE stock_items SET min_order_qty = NULL WHERE id = :id', { id: k.I.A });
    try {
      assert.equal(reorderStatus(k.t.db, k.t.today, { asOf: '2026-06-30' }).rows[0].suggestedQty, 8);
    } finally {
      k.t.db.run('UPDATE stock_items SET min_order_qty = 25 WHERE id = :id', { id: k.I.A });
    }
    k.t.db.run('UPDATE stock_items SET reorder_level = 10 WHERE id = :id', { id: k.I.A });
    try {
      const r = reorderStatus(k.t.db, k.t.today, { asOf: '2026-06-30' });
      assert.deepEqual(r.rows, []);
      assert.equal(r.itemsWithLevel, 1);
    } finally {
      k.t.db.run('UPDATE stock_items SET reorder_level = 50 WHERE id = :id', { id: k.I.A });
    }
  });

  test('stock below the level but covered by open purchase orders: listed with no order to place', () => {
    k.t.db.run('UPDATE stock_items SET reorder_level = 40 WHERE id = :id', { id: k.I.A });
    try {
      const [row] = reorderStatus(k.t.db, k.t.today, { asOf: '2026-06-30' }).rows;
      // net 42 ≥ 40 → no shortfall, but on hand 18 < 40
      assert.deepEqual([row.closingQty, row.netAvailable, row.shortfall, row.suggestedQty], [18, 42, 0, 0]);
    } finally {
      k.t.db.run('UPDATE stock_items SET reorder_level = 50 WHERE id = :id', { id: k.I.A });
    }
  });
});
