import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherListRow } from '../../../../shared/types/vouchers.ts';
import { VOUCHER_FEATURE } from '../../../app/lib/shortcuts.ts';
import { voucherGotoItems, voucherMenuEntries } from './menu.ts';

const row = (over: Partial<VoucherListRow>): VoucherListRow => ({
  id: 7,
  date: '2026-10-05',
  number: 'INV/42',
  voucherTypeId: 1,
  voucherTypeName: 'Sales',
  baseType: 'sales',
  partyLedgerId: 3,
  partyName: 'Sharma & Sons',
  narration: null,
  amount: 1180000,
  taxable: 1000000,
  tax: 180000,
  referenceNo: 'PO-9',
  gstNature: 'b2b',
  isOptional: false,
  isCancelled: false,
  isPostDated: false,
  irnStatus: null,
  ...over,
});

describe('Transactions menu', () => {
  const entries = voucherMenuEntries(VOUCHER_FEATURE);

  it('lists the conventional vouchers first, in the conventional order, with their global hotkeys', () => {
    // ARCHITECTURE §7 global keys.
    assert.deepEqual(
      entries.slice(0, 8).map((e) => [e.label, e.hotkey]),
      [
        ['Sales', 'F8'],
        ['Purchase', 'F9'],
        ['Receipt', 'F6'],
        ['Payment', 'F5'],
        ['Contra', 'F4'],
        ['Journal', 'F7'],
        ['Credit Note', 'Ctrl+F8'],
        ['Debit Note', 'Ctrl+F9'],
      ],
    );
    assert.equal(entries[0].hotkey, 'F8');
    // Ascending order numbers keep this sequence on the Gateway.
    assert.deepEqual(
      entries.map((e) => e.order),
      [...entries.map((e) => e.order)].sort((a, b) => a - b),
    );
  });

  it('feature-gated documents carry their F11 feature; accounting vouchers none', () => {
    const by = new Map(entries.map((e) => [e.baseType, e]));
    assert.equal(by.get('sales_order')?.feature, 'orderProcessing');
    assert.equal(by.get('rejection_in')?.feature, 'rejectionNotes');
    assert.equal(by.get('stock_journal')?.feature, 'inventory');
    assert.equal(by.get('sales')?.feature, undefined);
    assert.equal(by.get('journal')?.feature, undefined);
  });

  it('never shows F10 as a hotkey (it opens the voucher picker) and every entry is described', () => {
    for (const e of entries) {
      assert.notEqual(e.hotkey, 'F10');
      assert.ok(e.description.length > 0, `${e.label} has a description`);
      assert.ok(e.keywords.includes('voucher'));
    }
  });
});

describe('Go To voucher results', () => {
  it('opens a live voucher in alteration, labelled by type and number', () => {
    const [it0] = voucherGotoItems([row({})]);
    assert.equal(it0.screen, 'vouchers.entry');
    assert.deepEqual(it0.params, { id: 7 });
    assert.equal(it0.label, 'Sales INV/42');
    assert.equal(it0.description, '05-Oct-2026 · Sharma & Sons · ₹ 11,800.00');
    assert.deepEqual(it0.keywords, ['INV/42', 'Sharma & Sons', 'PO-9']);
  });

  it('cancelled vouchers and generated e-invoices open read-only', () => {
    const [c, e] = voucherGotoItems([row({ id: 8, isCancelled: true }), row({ id: 9, irnStatus: 'generated' })]);
    assert.equal(c.screen, 'vouchers.view');
    assert.match(c.description, /Cancelled/);
    assert.doesNotMatch(c.description, /₹/);
    assert.equal(e.screen, 'vouchers.view');
  });

  it('an unnumbered voucher still has a readable label', () => {
    assert.equal(voucherGotoItems([row({ number: null, voucherTypeName: 'Stock Journal' })])[0].label, 'Stock Journal (no number)');
  });
});
