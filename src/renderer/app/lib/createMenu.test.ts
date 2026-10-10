import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createMenuGroups } from './createMenu.ts';
import type { CreateMenuContext } from './createMenu.ts';

const owner: CreateMenuContext = {
  voucherAvailable: () => true,
  canCreateVouchers: true,
  canCreateMasters: true,
  ledgerFormOpenable: true,
  itemFormOpenable: true,
  inventory: true,
};

const keys = (ctx: CreateMenuContext) => createMenuGroups(ctx).map((g) => g.map((i) => (i.shortcut ? `${i.label} ${i.shortcut}` : i.label)));

describe('Create ▾ (top bar)', () => {
  test('everything, in the agreed order, with the existing keys (no new key)', () => {
    assert.deepEqual(keys(owner), [
      ['Sales invoice F8', 'Receipt F6', 'Purchase F9', 'Payment F5', 'Credit note Ctrl+F8'],
      ['Customer', 'Supplier', 'Item'],
      ['Other voucher… F10'],
    ]);
    const [, masters] = createMenuGroups(owner);
    assert.deepEqual(masters[0].target, { kind: 'ledger', groupCode: 'SUNDRY_DEBTORS' });
    assert.deepEqual(masters[1].target, { kind: 'ledger', groupCode: 'SUNDRY_CREDITORS' });
  });

  test('a voucher the F-key would refuse is not offered (same check as the keys)', () => {
    const groups = createMenuGroups({ ...owner, voucherAvailable: (b) => b !== 'credit_note' && b !== 'purchase' });
    assert.deepEqual(
      groups[0].map((i) => i.key),
      ['sales', 'receipt', 'payment'],
    );
  });

  test('inventory off (F11) or no item form: no Item — no trace of the feature', () => {
    assert.deepEqual(keys({ ...owner, inventory: false })[1], ['Customer', 'Supplier']);
    assert.deepEqual(keys({ ...owner, itemFormOpenable: false })[1], ['Customer', 'Supplier']);
  });

  test('without Create masters: vouchers only; without Create vouchers: masters only', () => {
    assert.deepEqual(keys({ ...owner, canCreateMasters: false }), [['Sales invoice F8', 'Receipt F6', 'Purchase F9', 'Payment F5', 'Credit note Ctrl+F8'], ['Other voucher… F10']]);
    assert.deepEqual(keys({ ...owner, canCreateVouchers: false, voucherAvailable: () => false }), [['Customer', 'Supplier', 'Item']]);
  });

  test('a read-only user gets no menu at all', () => {
    assert.deepEqual(createMenuGroups({ ...owner, canCreateVouchers: false, canCreateMasters: false, voucherAvailable: () => false }), []);
  });
});
