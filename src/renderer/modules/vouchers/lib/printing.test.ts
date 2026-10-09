import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { afterSavePrint, entryPrintTarget, savedToastMessage, voucherRefLabel } from './printing.ts';

describe('printing from the voucher screens', () => {
  it('Alt+P on a new voucher prints the one just saved; on an alteration, the voucher itself', () => {
    assert.equal(entryPrintTarget(null, null), null, 'nothing saved yet: no Print action');
    assert.deepEqual(entryPrintTarget(null, { id: 41, number: 'INV/12', typeName: 'Sales' }), { id: 41, label: 'Print Sales INV/12' });
    assert.deepEqual(entryPrintTarget(7, { id: 41, number: '12', typeName: 'Sales' }), { id: 7, label: 'Print' });
    assert.deepEqual(entryPrintTarget(null, { id: 3, number: null, typeName: 'Stock Journal' }), { id: 3, label: 'Print Stock Journal' });
  });

  it('print after saving opens the preview with autoPrint (sent to the printer when ready)', () => {
    assert.deepEqual(afterSavePrint(41, true), { id: 41, autoPrint: true });
    assert.equal(afterSavePrint(41, false), null);
  });

  it('the saved toast tells how to print', () => {
    assert.equal(savedToastMessage('1,180.00', [], false), '₹ 1,180.00 · Alt+P to print');
    assert.equal(savedToastMessage('1,180.00', ['Credit limit is close.'], true), '₹ 1,180.00 · Printing… · Credit limit is close.');
    assert.equal(voucherRefLabel({ typeName: 'Sales', number: ' 12 ' }), 'Sales 12');
    // Without the print module Alt+P is hidden, so the toast does not advertise it.
    assert.equal(savedToastMessage('1,180.00', ['Credit limit is close.'], false, false), '₹ 1,180.00 · Credit limit is close.');
  });
});
