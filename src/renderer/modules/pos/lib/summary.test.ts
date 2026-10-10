import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PosRegister, PosSummary } from '../../../../shared/types/pos.ts';
import { drawerDifference, drillCounter, drillTender, drillUser, expectedDrawer, signed, summaryExport, summaryTiles } from './summary.ts';

const s: PosSummary = {
  from: '2026-10-09',
  to: '2026-10-09',
  bills: 2,
  sales: 45_900,
  taxable: 40_000,
  tax: 5_900,
  returns: 1,
  returnValue: 11_800,
  returnTax: 1_800,
  net: 34_100,
  creditSales: 13_600,
  creditReturns: 11_800,
  netCash: 12_300,
  changeGiven: 2_700,
  exchangeIssued: 0,
  exchangeUsed: 0,
  mrpSavings: 0,
  byTender: [
    { modeId: 1, name: 'Cash', kind: 'cash', ledgerName: 'Cash', received: 12_300, refunded: 0, net: 12_300, count: 1 },
    { modeId: 2, name: 'UPI', kind: 'upi', ledgerName: 'HDFC', received: 10_000, refunded: 0, net: 10_000, count: 1 },
  ],
  byUser: [{ userId: null, userName: 'Owner', bills: 2, sales: 45_900, returns: 1, returnValue: 11_800, net: 34_100 }],
  byCounter: [{ counter: '', bills: 2, sales: 45_900, returnValue: 11_800, net: 34_100 }],
};

describe('POS summary helpers', () => {
  it('tiles and drawer', () => {
    const tiles = summaryTiles(s);
    assert.deepEqual(tiles.map((t) => [t.label, t.value]), [
      ['Net sales', 34_100],
      ['Cash in drawer from POS', 12_300],
      ['Sold on credit', 13_600],
      ['GST on sales', 4_100],
    ]);
    assert.match(tiles[1].caption, /change given ₹ 27\.00/);
    assert.equal(expectedDrawer(s, 2_000_00), 2_123_00);
    assert.equal(drawerDifference(2_120_00, 2_123_00), -300);
    assert.equal(drawerDifference(null, 2_123_00), null);
  });

  it('export tables per view', () => {
    const t = summaryExport(s, 'tender');
    assert.deepEqual(t.rows, [
      ['Cash', 'Cash', 'Cash', 12_300, 0, 12_300, 1],
      ['UPI', 'UPI', 'HDFC', 10_000, 0, 10_000, 1],
    ]);
    assert.deepEqual(t.totals, ['Total', '', '', 22_300, 0, 22_300, null]);
    assert.deepEqual(summaryExport(s, 'counter').rows, [['(not named)', 2, 45_900, 11_800, 34_100]]);
    const reg: PosRegister = {
      rows: [
        { voucherId: 3, kind: 'return', voucherTypeName: 'POS Return', number: 'PR/1', date: '2026-10-09', partyName: 'Cash', billValue: 11_800, paid: 11_800, credit: 0, change: 0, tenders: 'Cash 118.00', counter: null, userName: null, returnOf: { id: 1, number: 'POS/1' }, isOptional: false },
      ],
      total: 1,
      sums: { billValue: -11_800, paid: -11_800, credit: 0 },
    };
    const b = summaryExport(s, 'bills', reg);
    assert.equal(b.rows[0][1], 'POS Return (return of POS/1)');
    assert.equal(b.rows[0][4], -11_800);
    assert.equal(signed({ kind: 'sale', billValue: 5, paid: 4, credit: 1 }, 'credit'), 1);
  });
});

describe('drill-down from a summary row (review: Enter used to open every bill, unfiltered)', () => {
  it('filters the register by the row: tender mode, cashier (null = no login) or counter (blank = not named)', () => {
    assert.deepEqual(drillTender({ modeId: 7, name: 'UPI' }), { label: 'Paid by UPI', filter: { modeId: 7 } });
    assert.deepEqual(drillUser({ userId: null, userName: 'Owner (no login)' }), { label: 'Cashier Owner (no login)', filter: { userId: null } });
    assert.deepEqual(drillUser({ userId: 3, userName: 'Asha' }).filter, { userId: 3 });
    assert.deepEqual(drillCounter({ counter: '' }), { label: 'Counter (not named)', filter: { counter: '' } });
  });
});
