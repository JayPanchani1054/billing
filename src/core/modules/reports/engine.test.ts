/**
 * Balance engine performance contract: a drill-down snapshot of some ledgers equals the whole-company
 * snapshot for them without valuing stock; the stock-dependent parts are computed on first read, all
 * from one valuation replay; and prepareStock fetches several dates at once.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stockReplayCount } from '../inventory/index.ts';
import { buildSnapshot, ledgersUnder, prepareStock, stockAt, stockAtEnd } from './engine.ts';
import { exceptions } from './registers.ts';
import { makeBooks } from './testkit.ts';

/** The April 2026 books, plus a second year (sales, purchase and rent in FY 2027-28) so the P&L A/c carries a profit brought forward. */
function twoYears() {
  const b = makeBooks({ today: '2027-06-30' });
  const vt = b.t.ids.voucherTypes;
  b.post({ voucherTypeId: vt.sales, date: '2027-04-10', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 5, rate: 1500 }] });
  b.post({ voucherTypeId: vt.purchase, date: '2027-05-05', mode: 'item_invoice', partyLedgerId: b.L.supreme, referenceNo: 'SUP-9', items: [{ itemId: b.widget, qty: 10, rate: 1300 }] });
  b.post({ voucherTypeId: vt.payment, date: '2027-05-20', mode: 'ledger', ledgers: [{ ledgerId: b.L.rent, amount: 2_000_000 }, { ledgerId: b.L.cash, amount: -2_000_000 }] });
  return b;
}

const Q = { from: '2027-05-01', to: '2027-06-30' };

describe('reports engine: drill-downs never value stock', () => {
  it('a snapshot of some ledgers equals the whole-company snapshot for them, with no stock replay', () => {
    const b = twoYears();
    try {
      const env = b.env();
      const before = stockReplayCount();
      const subsets = [[b.L.acme], [b.L.rent], [b.L.cash, b.L.bank], ledgersUnder(env, [b.t.ids.groups.SUNDRY_DEBTORS])];
      const parts = subsets.map((ids) => buildSnapshot(env, { ...Q, ledgerIds: ids }));
      const debtors = parts[3].groups.get(b.t.ids.groups.SUNDRY_DEBTORS);
      assert.equal(stockReplayCount(), before, 'no valuation for a ledger / group drill-down');
      // Exceptions reads every ledger's closing but never the P&L A/c / stock parts of the snapshot.
      exceptions(b.env(), Q);
      assert.equal(stockReplayCount(), before, 'no valuation for the exception reports');

      const full = buildSnapshot(b.env(), Q);
      subsets.forEach((ids, k) => {
        for (const id of ids) assert.deepEqual({ ...parts[k].ledgers.get(id) }, { ...full.ledgers.get(id) }, `ledger ${id}`);
      });
      assert.deepEqual(debtors, full.groups.get(b.t.ids.groups.SUNDRY_DEBTORS));
      // Acme on 1-May-27: April 2026 closing 41,600.00 Dr (testkit EXPECTED) + 10-Apr-27 sale 5 × ₹1,500 × 1.18 = 8,850.00
      //   → 50,450.00 Dr
      assert.equal(parts[0].ledgers.get(b.L.acme)?.opening, 4_160_000 + 885_000);
    } finally {
      b.t.close();
    }
  });

  it('the stock-dependent parts are computed on first read, all from one replay; the P&L A/c drill-down gets the full snapshot', () => {
    const b = twoYears();
    try {
      const env = b.env();
      const before = stockReplayCount();
      const snap = buildSnapshot(env, Q);
      assert.equal(stockReplayCount(), before, 'building the snapshot values no stock');
      const pl = snap.ledgers.get(b.L.pl);
      assert.ok(pl);
      // Profit brought forward = the April 2026 net profit (6,66,667 Cr), carried by the P&L A/c.
      assert.equal(snap.retained, -666_667);
      assert.equal(pl.opening, -666_667);
      assert.equal(pl.closing, -666_667);
      assert.equal(stockReplayCount(), before + 1, 'one replay for the year-start and books-beginning stock');
      assert.equal(snap.openingStock, stockAt(env, '2027-04-01'));
      void snap.openingDifference;
      assert.equal(stockReplayCount(), before + 1, 'opening difference reuses it');

      // Asking for the P&L A/c alone computes every nominal ledger (its brought-forward profit needs them).
      const only = buildSnapshot(b.env(), { ...Q, ledgerIds: [b.L.pl] });
      assert.equal(only.ledgers.get(b.L.pl)?.opening, -666_667);
      assert.equal(only.ledgers.size, env.ledgers.length);
    } finally {
      b.t.close();
    }
  });

  it('prepareStock: several dates from one replay; stockAt / stockAtEnd then read them', () => {
    const b = twoYears();
    try {
      const env = b.env();
      const before = stockReplayCount();
      prepareStock(env, { opening: ['2026-04-01', '2027-04-01', '2027-05-01'], closing: ['2026-04-30', '2027-06-30'] });
      assert.equal(stockReplayCount(), before + 1);
      // Widget: opening 100 @ ₹1,000 = 1,00,00,000; April 2026 closing 70 @ ₹1,066.67 avg = 74,66,667 (testkit EXPECTED)
      assert.equal(stockAt(env, '2026-04-01'), 10_000_000);
      assert.equal(stockAtEnd(env, '2026-04-30'), 7_466_667);
      assert.equal(stockAt(env, '2027-04-01'), 7_466_667);
      assert.equal(stockReplayCount(), before + 1);
    } finally {
      b.t.close();
    }
  });
});
