import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { explodeBom } from './bom.ts';
import { costJournal, type ProductionTerm } from './costing.ts';
import { itc04Periods, returnDueDate, returnLimitFor, returnStatus } from './jobwork.ts';

describe('costJournal (manufacturing costing rule)', () => {
  test('finished goods = consumption + additional − by-products, split by quantity', () => {
    // C = 1,000.00 + 500.00 = 1,500.00 (1,50,000 p)
    // A = 200.00 + 10% of C (150.00) = 350.00 → P = 1,850.00
    // scrap at a fixed 50.00, by-product 10% of P = 185.00 → FG = 1,850 − 50 − 185 = 1,615.00 for 20 → ₹80.75
    const terms = new Map<number, ProductionTerm>([
      [3, { basis: 'residual' }],
      [4, { basis: 'fixed' }],
      [5, { basis: 'percent', pct: 10 }],
    ]);
    const r = costJournal({
      consumption: [
        { lineNo: 1, qty: 10, cost: 100000 },
        { lineNo: 2, qty: 5, cost: 50000 },
      ],
      production: [
        { lineNo: 3, qty: 20, amount: 0 },
        { lineNo: 4, qty: 5, amount: 5000 },
        { lineNo: 5, qty: 2, amount: 0 },
      ],
      terms,
      additional: [
        { basis: 'amount', value: 20000 },
        { basis: 'percent', value: 10 },
      ],
    });
    assert.equal(r.consumed, 150000);
    assert.deepEqual(r.additionalValues, [20000, 15000]);
    assert.equal(r.additional, 35000);
    assert.equal(r.pool, 185000);
    assert.equal(r.values.get(4), 5000);
    assert.equal(r.values.get(5), 18500);
    assert.equal(r.values.get(3), 161500);
    assert.equal(r.byProducts, 23500);
    assert.equal(r.shortfall, 0);
  });

  test('two finished lines share the residual by quantity (largest remainder, exact total)', () => {
    const r = costJournal({ consumption: [{ lineNo: 1, qty: 1, cost: 1000 }], production: [{ lineNo: 2, qty: 1, amount: 0 }, { lineNo: 3, qty: 2, amount: 0 }], terms: new Map(), additional: [] });
    // 1000 / 3 = 333.33 → 333 + 667 (largest remainder gives the odd paisa to the larger share)
    assert.equal((r.values.get(2) ?? 0) + (r.values.get(3) ?? 0), 1000);
    assert.equal(r.values.get(2), 333);
  });

  test('a transfer keeps its own cost and stays out of the pool', () => {
    const terms = new Map<number, ProductionTerm>([
      [2, { basis: 'source', sourceLineNo: 1 }],
      [4, { basis: 'residual' }],
    ]);
    const r = costJournal({
      consumption: [
        { lineNo: 1, qty: 3, cost: 12345 },
        { lineNo: 3, qty: 1, cost: 1000 },
      ],
      production: [
        { lineNo: 2, qty: 3, amount: 0 },
        { lineNo: 4, qty: 1, amount: 0 },
      ],
      terms,
      additional: [],
    });
    assert.equal(r.values.get(2), 12345);
    assert.equal(r.transferred, 12345);
    assert.equal(r.consumed, 1000);
    assert.equal(r.values.get(4), 1000);
  });

  test('a partial transfer carries its share of the source cost', () => {
    const r = costJournal({
      consumption: [{ lineNo: 1, qty: 4, cost: 1001 }],
      production: [{ lineNo: 2, qty: 1, amount: 0 }],
      terms: new Map([[2, { basis: 'source', sourceLineNo: 1 }]]),
      additional: [],
    });
    // 1001 × 1/4 = 250.25 → 250
    assert.equal(r.values.get(2), 250);
  });

  test('nothing to share → residual lines enter at current cost (null); by-products above cost → shortfall', () => {
    const none = costJournal({ consumption: [], production: [{ lineNo: 1, qty: 5, amount: 0 }], terms: new Map(), additional: [] });
    assert.equal(none.values.get(1), null);
    const over = costJournal({
      consumption: [{ lineNo: 1, qty: 1, cost: 1000 }],
      production: [{ lineNo: 2, qty: 1, amount: 0 }, { lineNo: 3, qty: 1, amount: 1500 }],
      terms: new Map([[3, { basis: 'fixed' }]]),
      additional: [],
    });
    assert.equal(over.values.get(2), 0);
    assert.equal(over.shortfall, 500);
  });

  test('additional cost alone is shared when there is no consumption', () => {
    const r = costJournal({ consumption: [], production: [{ lineNo: 1, qty: 2, amount: 0 }], terms: new Map(), additional: [{ basis: 'amount', value: 999 }] });
    assert.equal(r.values.get(1), 999);
  });
});

describe('explodeBom', () => {
  test('scales from the output quantity and rounds to unit decimals', () => {
    const lines = [
      { kind: 'component' as const, itemId: 1, qty: 50, godownId: null, valueBasis: null, valueRate: null, valuePct: null, unitDecimals: 3 },
      { kind: 'component' as const, itemId: 2, qty: 1, godownId: null, valueBasis: null, valueRate: null, valuePct: null, unitDecimals: 0 },
      { kind: 'scrap' as const, itemId: 3, qty: 0.4, godownId: null, valueBasis: 'rate' as const, valueRate: 20, valuePct: null, unitDecimals: 0 },
    ];
    // BOM for 10; make 25 → ×2.5: 125 kg, 2.5 → 3 Nos (whole), 1.0 kg scrap → 1
    const out = explodeBom(lines, 10, 25);
    assert.deepEqual(out.map((e) => e.qty), [125, 3, 1]);
    assert.deepEqual(explodeBom(lines, 10, 0), []);
  });
});

describe('job work rules (s.143, rule 45)', () => {
  test('return due dates by goods type', () => {
    assert.equal(returnDueDate('inputs', '2025-10-10'), '2026-10-10');
    assert.equal(returnDueDate('capital_goods', '2025-10-10'), '2028-10-10');
    assert.equal(returnDueDate('tools', '2025-10-10'), null);
    assert.equal(returnDueDate('inputs', '2024-02-29'), '2025-02-28');
    assert.equal(returnDueDate('inputs', '2025-10-10', '2027-01-31'), '2027-01-31', 'an extension replaces the limit');
    assert.equal(returnLimitFor('inputs', '2017-06-30'), null, 'no rule before GST');
  });

  test('status: overdue / due soon / ok / no limit', () => {
    assert.deepEqual(returnStatus('2026-05-10', '2026-06-30'), { status: 'overdue', daysLeft: -51 });
    assert.deepEqual(returnStatus('2026-07-20', '2026-06-30'), { status: 'due_soon', daysLeft: 20 });
    assert.equal(returnStatus('2026-12-31', '2026-06-30').status, 'ok');
    assert.equal(returnStatus(null, '2026-06-30').status, 'no_limit');
  });

  test('ITC-04 periods: half-yearly above ₹5 crore, annual otherwise; quarterly before Oct-2021', () => {
    const big = itc04Periods('2026-10-09', true);
    assert.deepEqual(big.map((p) => [p.from, p.to, p.dueDate]), [
      ['2026-04-01', '2026-09-30', '2026-10-25'],
      ['2026-10-01', '2027-03-31', '2027-04-25'],
    ]);
    const small = itc04Periods('2026-10-09', false);
    assert.deepEqual(small.map((p) => [p.from, p.to, p.frequency, p.dueDate]), [['2026-04-01', '2027-03-31', 'annual', '2027-04-25']]);
    const y2122 = itc04Periods('2021-05-01', false);
    assert.deepEqual(y2122.map((p) => [p.from, p.to, p.frequency]), [
      ['2021-04-01', '2021-06-30', 'quarterly'],
      ['2021-07-01', '2021-09-30', 'quarterly'],
      ['2021-10-01', '2022-03-31', 'annual'],
    ]);
  });
});
