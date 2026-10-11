import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recordPaymentTarget, savedBarDetails, savedBarTitle, savedBarVisible, barToast } from './savedBar.ts';
import type { SavedBarState } from './savedBar.ts';

const bar = (over: Partial<SavedBarState> = {}): SavedBarState => ({
  id: 42,
  number: 'INV/26-27/0042',
  typeName: 'Sales',
  amount: 1_180_00,
  baseType: 'sales',
  partyId: 7,
  partyClasses: ['party', 'debtor'],
  ...over,
});

describe('Saved bar after creating a voucher', () => {
  it('title names the voucher', () => {
    assert.equal(savedBarTitle(bar()), 'Saved Sales INV/26-27/0042');
    assert.equal(savedBarTitle(bar({ number: null, typeName: 'Journal' })), 'Saved Journal');
  });

  it('Record payment: a Receipt for a sale to a customer, a Payment for a purchase from a supplier', () => {
    assert.deepEqual(recordPaymentTarget(bar()), { baseType: 'receipt', partyId: 7 });
    assert.deepEqual(recordPaymentTarget(bar({ baseType: 'purchase', partyClasses: ['party', 'creditor'] })), { baseType: 'payment', partyId: 7 });
  });

  it('no Record payment for a cash sale, a voucher without party, or other documents', () => {
    assert.equal(recordPaymentTarget(bar({ partyClasses: ['cash', 'cash_bank'] })), null, 'Cash of a cash sale is already paid');
    assert.equal(recordPaymentTarget(bar({ partyId: null })), null);
    assert.equal(recordPaymentTarget(bar({ baseType: 'credit_note' })), null);
    assert.equal(recordPaymentTarget(bar({ baseType: 'delivery_note' })), null);
  });

  it('shown until the next voucher is touched', () => {
    assert.equal(savedBarVisible(bar(), false), true);
    assert.equal(savedBarVisible(bar(), true), false);
    assert.equal(savedBarVisible(null, false), false);
  });
});

describe('2.1: the Saved bar is one line and "saved" is said once (D20)', () => {
  it('the line reads the voucher, the amount and the party back', () => {
    assert.equal(`${savedBarTitle(bar({ number: '33' }))}${savedBarDetails(bar({ amount: 27_140_00, partyName: 'Asha Retail' }))}`, 'Saved Sales 33 · ₹ 27,140.00 · Asha Retail');
    assert.equal(savedBarDetails(bar({ partyName: null })), ' · ₹ 1,180.00');
  });

  it('no "saved" toast while the bar shows; the save\'s notes still get one', () => {
    assert.equal(barToast([]), null);
    assert.deepEqual(barToast(['B2C large: report in GSTR-1 table 5.', 'Check stock.']), { title: 'Please note', message: 'B2C large: report in GSTR-1 table 5. Check stock.' });
  });
});
