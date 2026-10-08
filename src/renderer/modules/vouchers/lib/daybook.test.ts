import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherListRow } from '../../../../shared/types/vouchers.ts';
import { baseTypesOf, dayBookExportRows, dayBookExportTotals, dayBookTotals, keyAfterRemoval, openTarget, SEARCH_MAX, searchText, toDayBookRow, toggleChip } from './daybook.ts';
import { dayBookSide, defaultTypeFor, partyRequired, singleEntryAccountSide, trackingKinds } from './kinds.ts';

const row = (over: Partial<VoucherListRow>): VoucherListRow => ({
  id: 1,
  date: '2026-10-05',
  number: '1',
  voucherTypeId: 1,
  voucherTypeName: 'Sales',
  baseType: 'sales',
  partyLedgerId: 3,
  partyName: 'Sharma & Sons',
  narration: null,
  amount: 1180000,
  taxable: 1000000,
  tax: 180000,
  referenceNo: null,
  gstNature: 'b2b',
  isOptional: false,
  isCancelled: false,
  isPostDated: false,
  irnStatus: null,
  ...over,
});

describe('day book rows', () => {
  it('sales in Debit, purchase / receipt in Credit, payment in Debit', () => {
    assert.equal(toDayBookRow(row({})).debit, 1180000);
    assert.equal(toDayBookRow(row({ baseType: 'purchase' })).credit, 1180000);
    assert.equal(toDayBookRow(row({ baseType: 'receipt' })).credit, 1180000);
    assert.equal(toDayBookRow(row({ baseType: 'payment' })).debit, 1180000);
    assert.equal(dayBookSide('receipt_note'), 'cr');
    assert.equal(dayBookSide('delivery_note'), 'dr');
  });

  it('cancelled: no amount, flagged; totals skip optional and cancelled', () => {
    const rows = [
      toDayBookRow(row({})),
      toDayBookRow(row({ id: 2, isCancelled: true })),
      toDayBookRow(row({ id: 3, isOptional: true, baseType: 'purchase' })),
      toDayBookRow(row({ id: 4, baseType: 'receipt', amount: 500000, partyName: null, narration: 'Cash deposit' })),
    ];
    assert.deepEqual(rows[1].flags, ['Cancelled']);
    assert.equal(rows[1].debit, 0);
    assert.equal(rows[3].particulars, 'Cash deposit');
    // 11,800.00 Dr; 5,000.00 Cr (the optional purchase is left out)
    assert.deepEqual(dayBookTotals(rows), { debit: 1180000, credit: 500000 });
    assert.deepEqual(dayBookExportRows(rows)[1], ['2026-10-05', 'Sharma & Sons (Cancelled)', 'Sales', '1', null, null]);
  });

  it('chips → base types', () => {
    assert.equal(baseTypesOf([]), undefined);
    assert.deepEqual(baseTypesOf(['notes', 'sales']), ['sales', 'credit_note', 'debit_note']);
    assert.deepEqual(toggleChip(['a'], 'a'), []);
    assert.deepEqual(toggleChip(['a'], 'b'), ['a', 'b']);
  });
});

describe('voucher kinds', () => {
  it('party, single-entry side, tracking documents', () => {
    assert.equal(partyRequired('sales', 'ledger'), false);
    assert.equal(partyRequired('sales', 'item_invoice'), true);
    assert.equal(partyRequired('delivery_note', 'inventory'), true);
    assert.equal(partyRequired('stock_journal', 'inventory'), false);
    assert.equal(singleEntryAccountSide('payment'), 'cr');
    assert.equal(singleEntryAccountSide('receipt'), 'dr');
    assert.equal(singleEntryAccountSide('journal'), null);
    assert.deepEqual(trackingKinds('sales', { trackingNumbers: true, orderProcessing: true }), ['delivery', 'sales_order']);
    assert.deepEqual(trackingKinds('sales', { trackingNumbers: false, orderProcessing: false }), []);
  });

  it('default voucher type: active predefined first', () => {
    const types = [
      { id: 1, baseType: 'sales' as const, isActive: false, isPredefined: true },
      { id: 2, baseType: 'sales' as const, isActive: true, isPredefined: false },
      { id: 3, baseType: 'sales' as const, isActive: true, isPredefined: true },
    ];
    assert.equal(defaultTypeFor(types, 'sales')?.id, 3);
    assert.equal(defaultTypeFor(types.slice(0, 2), 'sales')?.id, 2);
    assert.equal(defaultTypeFor(types, 'payment'), null);
  });
});

describe('opening, deleting and exporting from a register', () => {
  it('Enter alters; cancelled vouchers, generated e-invoices and read-only users get the view', () => {
    const live = toDayBookRow(row({}));
    assert.equal(live.irnGenerated, false);
    assert.equal(openTarget(live, true), 'vouchers.entry');
    assert.equal(openTarget(live, false), 'vouchers.view');
    assert.equal(openTarget(toDayBookRow(row({ isCancelled: true })), true), 'vouchers.view');
    const irn = toDayBookRow(row({ irnStatus: 'generated' }));
    assert.equal(irn.irnGenerated, true);
    assert.equal(openTarget(irn, true), 'vouchers.view');
    assert.equal(openTarget(toDayBookRow(row({ irnStatus: 'pending' })), true), 'vouchers.entry');
  });

  it('after a delete the next row is highlighted (else the previous one)', () => {
    const rows = [1, 2, 3].map((id) => toDayBookRow(row({ id })));
    assert.equal(keyAfterRemoval(rows, 2), '3');
    assert.equal(keyAfterRemoval(rows, 3), '2');
    assert.equal(keyAfterRemoval(rows.slice(0, 1), 1), null);
    assert.equal(keyAfterRemoval(rows, 99), null);
  });

  it('export totals skip optional and cancelled vouchers, like the screen', () => {
    const rows = [
      row({ id: 1, amount: 1180000 }), // sales → Debit 11,800.00
      row({ id: 2, baseType: 'receipt', voucherTypeName: 'Receipt', amount: 500000 }), // receipt → Credit 5,000.00
      row({ id: 3, amount: 99900, isOptional: true }), // not counted
      row({ id: 4, amount: 77700, isCancelled: true }), // not counted (and shown blank)
    ].map(toDayBookRow);
    assert.deepEqual(dayBookExportTotals(rows), ['', 'Total (optional and cancelled vouchers not counted)', '', '', 1180000, 500000]);
  });

  it('search text is trimmed and capped at the route limit (100 characters)', () => {
    assert.equal(searchText('  INV/42  '), 'INV/42');
    assert.equal(searchText('x'.repeat(150)).length, SEARCH_MAX);
    assert.equal(SEARCH_MAX, 100);
  });
});
