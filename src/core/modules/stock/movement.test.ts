import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { stockAgeing } from './ageing.ts';
import { stockMovement } from './movement.ts';
import { APRIL, stockScenario, type StockKit } from './testkit.ts';

describe('stock.movement', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('Steel Tumbler in April: inward by supplier (and the customer return), outward by customer', () => {
    const r = stockMovement(k.t.db, k.t.today, { itemId: k.I.A, ...APRIL });
    assert.equal(r.unit, 'Nos');
    assert.deepEqual(
      r.inward.rows.map((x) => [x.partyName, x.qty, x.value, x.avgRate, x.vouchers]),
      [
        ['Supreme Suppliers', 20, 2_30_000, 115, 1],
        ['Bharat Wholesale', 10, 1_33_330, 133.33, 1],
        ['Acme Traders', 3, 45_000, 150, 1],
      ],
    );
    // 2,30,000 + 1,33,330 + 45,000 = 4,08,330 for 33 → ₹123.7364
    assert.deepEqual([r.inward.qty, r.inward.value, r.inward.avgRate], [33, 4_08_330, 123.7364]);
    assert.deepEqual(
      r.outward.rows.map((x) => [x.partyName, x.qty, x.value, x.avgRate]),
      [
        ['Acme Traders', 15, 2_25_000, 150],
        ['Metro Retail', 12, 1_92_000, 160],
      ],
    );
    // 4,17,000 / 27 = ₹154.4444
    assert.deepEqual([r.outward.qty, r.outward.value, r.outward.avgRate], [27, 4_17_000, 154.4444]);
    assert.deepEqual(r.internal, { inwardQty: 0, outwardQty: 8, vouchers: 1 }, 'the stock journal consumption has no party');
  });

  test('delivery note counts once: the invoice billing it is not counted again', () => {
    const r = stockMovement(k.t.db, k.t.today, { itemId: k.I.A, from: '2026-05-01', to: '2026-05-31' });
    const acme = r.outward.rows.find((x) => x.partyName === 'Acme Traders');
    assert.deepEqual([acme?.qty, acme?.value, acme?.vouchers], [5, 80_000, 1]);
    const metro = r.outward.rows.find((x) => x.partyName === 'Metro Retail');
    assert.deepEqual([metro?.qty, metro?.value], [4, 68_000]);
    assert.deepEqual(r.inward.rows.map((x) => [x.partyName, x.qty, x.value]), [['Supreme Suppliers', 20, 2_40_000]]);
    assert.deepEqual(r.internal.outwardQty, 1, 'physical stock shortage');
  });

  test('a stock group mixes units → quantities are null at the side level but kept per item', () => {
    const r = stockMovement(k.t.db, k.t.today, { from: '2026-04-01', to: '2026-06-30' });
    assert.equal(r.unit, null);
    assert.equal(r.outward.qty, null);
    const metro = r.outward.rows.find((x) => x.partyName === 'Metro Retail');
    assert.ok(metro);
    assert.equal(metro.qty, null, 'Nos and Kg to the same party');
    const rice = metro.items.find((x) => x.itemId === k.I.R);
    // 30 Kg @ ₹80 = 2,40,000
    assert.deepEqual([rice?.qty, rice?.value, rice?.unit], [30, 2_40_000, 'Kg']);
    const kitchen = stockMovement(k.t.db, k.t.today, { ...APRIL, groupId: k.groups.kitchen });
    assert.equal(kitchen.unit, 'Nos');
    // A 27 + F 27 to customers in April
    assert.equal(kitchen.outward.qty, 54);
  });

  test('item and group together are refused', () => {
    assert.throws(() => stockMovement(k.t.db, k.t.today, { ...APRIL, itemId: k.I.A, groupId: k.groups.kitchen }), /either one stock item or one stock group/);
  });
});

describe('stock.ageing', () => {
  let k: StockKit;
  before(() => {
    k = stockScenario();
  });
  after(() => k.t.close());

  test('default buckets: what is on hand on 30-Jun, aged by its (latest) inwards', () => {
    const r = stockAgeing(k.t.db, k.t.today, { asOf: '2026-06-30' });
    assert.deepEqual(
      r.buckets.map((b) => b.label),
      ['0–30 days', '31–60 days', '61–90 days', '91–180 days', 'Over 180 days'],
    );
    const by = new Map(r.rows.map((x) => [x.itemId, x]));
    // Tumbler 18: the receipt note of 20-May (41 days) covers it all; the 15-Jun transfer nets to 0
    assert.deepEqual(by.get(k.I.A)?.buckets.map((b) => b.qty), [0, 18, 0, 0, 0]);
    assert.equal(by.get(k.I.A)?.oldestDate, '2026-05-20');
    assert.equal(by.get(k.I.A)?.averageAgeDays, 41);
    // Rice 120 Kg from the 01-Jun purchase (29 days)
    assert.deepEqual(by.get(k.I.R)?.buckets.map((b) => b.value), [7_28_000, 0, 0, 0, 0]);
    // Cable Roll is negative → not aged; Spare Part has nothing
    assert.equal(by.has(k.I.N), false);
    assert.equal(by.has(k.I.S), false);
    assert.equal(r.totals.value, r.rows.reduce((s, x) => s + x.value, 0));
  });

  test('custom buckets: Copper Bottle 16 = return 3 (71 days) + purchase 10 (76) + 3 of the 05-Apr purchase (86)', () => {
    const r = stockAgeing(k.t.db, k.t.today, { asOf: '2026-06-30', buckets: [75] });
    const f = r.rows.find((x) => x.itemId === k.I.F);
    assert.ok(f);
    // value 2,02,330 split 3 : 13 → 37,936.875 / 1,64,393.125 → largest remainder → 37,937 + 1,64,393
    assert.deepEqual(f.buckets, [
      { qty: 3, value: 37_937 },
      { qty: 13, value: 1_64_393 },
    ]);
    // (3 × 71 + 10 × 76 + 3 × 86) / 16 = 1,231 / 16 = 76.9 → 77
    assert.equal(f.averageAgeDays, 77);
    assert.equal(f.oldestDate, '2026-04-05');
    assert.deepEqual(r.buckets.map((b) => b.label), ['0–75 days', 'Over 75 days']);
  });

  test('buckets must go up', () => {
    assert.throws(() => stockAgeing(k.t.db, k.t.today, { asOf: '2026-06-30', buckets: [60, 30] }), /must go up/);
  });

  test('group filter', () => {
    const r = stockAgeing(k.t.db, k.t.today, { asOf: '2026-06-30', groupId: k.groups.grains });
    assert.deepEqual(r.rows.map((x) => x.itemId), [k.I.R]);
  });
});
