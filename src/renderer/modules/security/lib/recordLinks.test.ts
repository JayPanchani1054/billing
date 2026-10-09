import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeletedRecord, recordLink } from './recordLinks.ts';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Edit Log → the record (Alt+A Open record)', () => {
  it('opens the voucher view or the master form of the audited record', () => {
    assert.deepEqual(recordLink('voucher', 42), { screen: 'vouchers.view', params: { id: 42 }, label: 'Open voucher' });
    assert.deepEqual(recordLink('ledger', 7), { screen: 'accounts.ledger.form', params: { id: 7 }, label: 'Open ledger' });
    assert.deepEqual(recordLink('stock_item', 3)?.screen, 'inventory.item.form');
    assert.deepEqual(recordLink('voucher_type', 5)?.screen, 'accounts.voucherType.form');
    assert.deepEqual(recordLink('group', 5)?.screen, 'accounts.group.form');
    assert.deepEqual(recordLink('company', 1), { screen: 'company.profile', params: {}, label: 'Open company details' });
  });

  it('offers nothing for deleted records, record-less entries and types without a screen', () => {
    assert.equal(recordLink('ledger', 7, true), null);
    assert.equal(recordLink('ledger', null), null);
    assert.equal(recordLink(null, 7), null);
    assert.equal(recordLink('report', 1), null);
    assert.equal(recordLink('toString', 1), null, 'no prototype keys');
    assert.equal(isDeletedRecord([{ action: 'create' }, { action: 'alter' }, { action: 'delete' }]), true);
    assert.equal(isDeletedRecord([{ action: 'create' }, { action: 'alter' }]), false);
    assert.equal(isDeletedRecord([]), false);
  });

  it('every target screen is registered by its module with the same id', () => {
    const registered = new Set<string>();
    for (const m of fs.readdirSync(modulesDir)) {
      const idx = path.join(modulesDir, m, 'index.ts');
      if (!fs.existsSync(idx)) continue;
      for (const hit of fs.readFileSync(idx, 'utf8').matchAll(/\{\s*id:\s*'([a-zA-Z.]+)'/g)) registered.add(hit[1]);
    }
    for (const t of ['voucher', 'ledger', 'group', 'voucher_type', 'stock_item', 'stock_group', 'stock_category', 'unit', 'godown', 'role', 'user', 'company']) {
      const link = recordLink(t, 1);
      assert.ok(link && registered.has(link.screen), `${t} → ${link?.screen} is not a registered screen`);
    }
  });
});

describe('master forms → their Edit history (Alt+H)', () => {
  // [file, entityType the core audits for that master]
  const forms: Array<[string, string]> = [
    ['accounts/LedgerFormScreen.tsx', 'ledger'],
    ['accounts/GroupScreens.tsx', 'group'],
    ['accounts/VoucherTypeScreens.tsx', 'voucher_type'],
    ['inventory/ItemForm.tsx', 'stock_item'],
    ['company/CompanyProfileScreen.tsx', 'company'],
  ];
  for (const [file, type] of forms) {
    it(`${file} opens security.audit for '${type}' with Alt+H`, () => {
      const src = fs.readFileSync(path.join(modulesDir, file), 'utf8');
      assert.match(src, /key: 'Alt\+H',\s*label: 'Edit history'/, 'Alt+H Edit history action');
      assert.ok(src.includes(`nav.push('security.audit', { entityType: '${type}'`), `pushes security.audit for ${type}`);
      assert.match(src, /useCan\('audit\.view'\)/, 'hidden without the Edit Log permission');
    });
  }
});
