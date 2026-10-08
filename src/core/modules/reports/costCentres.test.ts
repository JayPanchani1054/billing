import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveCostCentre } from '../accounts/costCentres.ts';
import { costCentreReport } from './costCentres.ts';
import { APRIL, makeBooks } from './testkit.ts';

function setup() {
  const b = makeBooks({ features: { costCentres: true }, skipVouchers: true });
  const cat = b.t.ids.costCategoryId;
  const ho = saveCostCentre(b.t.ctx, { name: 'Head Office', categoryId: cat }).id;
  const mum = saveCostCentre(b.t.ctx, { name: 'Mumbai Branch', categoryId: cat }).id;
  const mumSales = saveCostCentre(b.t.ctx, { name: 'Mumbai Sales Team', categoryId: cat, parentId: mum }).id;
  const travel = b.t.addLedger({ name: 'Travel', group: 'INDIRECT_EXPENSES', costCentres: true });
  const vt = b.t.ids.voucherTypes;
  const pay = (amount: number, allocations: Array<{ costCentreId: number; amount: number }>, extra: object = {}) =>
    b.post({
      voucherTypeId: vt.payment,
      date: '2026-04-12',
      mode: 'ledger',
      ledgers: [
        { ledgerId: travel, amount, costAllocations: allocations },
        { ledgerId: b.L.cash, amount: -amount },
      ],
      ...extra,
    });
  // ₹30,000 travel: ₹10,000 Head Office, ₹20,000 Mumbai Sales Team
  pay(3_000_000, [
    { costCentreId: ho, amount: 1_000_000 },
    { costCentreId: mumSales, amount: 2_000_000 },
  ]);
  // Optional voucher: never counts
  pay(500_000, [{ costCentreId: ho, amount: 500_000 }], { isOptional: true });
  return { b, cat, ho, mum, mumSales, travel };
}

test('cost centres: category summary rolls sub-centres up into their parent', () => {
  const { b, cat, ho, mum, mumSales } = setup();
  const r = costCentreReport(b.env(), APRIL);
  const row = (key: string) => r.rows.find((x) => x.key === key);
  assert.equal(row(`cat:${cat}`)?.debit, 3_000_000);
  assert.equal(row(`cc:${ho}`)?.net, 1_000_000);
  assert.equal(row(`cc:${mum}`)?.net, 2_000_000);
  assert.equal(row(`cc:${mum}`)?.hasChildren, true);
  assert.equal(row(`cc:${mumSales}`)?.level, 2);
  assert.equal(row(`cc:${mumSales}`)?.parentKey, `cc:${mum}`);
});

test('cost centres: ledger breakup of a centre includes its sub-centres; category filter', () => {
  const { b, cat, mum, travel } = setup();
  const r = costCentreReport(b.env(), { ...APRIL, categoryId: cat, costCentreId: mum });
  assert.deepEqual(r.centre?.ledgers.map((l) => [l.ledgerId, l.debit, l.credit, l.net]), [[travel, 2_000_000, 0, 2_000_000]]);
  assert.deepEqual(r.centre?.totals, { debit: 2_000_000, credit: 0, net: 2_000_000 });
  assert.ok(r.rows.every((x) => x.kind === 'centre' || x.id === cat));
});

test('cost centres: a period without allocations shows only the category', () => {
  const { b, cat } = setup();
  const r = costCentreReport(b.env(), { from: '2026-05-01', to: '2026-05-31' });
  assert.deepEqual(r.rows.map((x) => x.key), [`cat:${cat}`]);
});
