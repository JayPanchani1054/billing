import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LedgerListRow } from '../../../../shared/types/accounts.ts';
import { ledgerGotoItems } from './gotoItems.ts';

const row: LedgerListRow = {
  id: 7,
  name: 'Sharma Traders',
  alias: 'ST',
  groupId: 3,
  groupName: 'Sundry Debtors',
  primaryGroupCode: 'CURRENT_ASSETS',
  classes: ['party', 'debtor', 'asset'],
  gstin: '27AAPFU0939F1ZV',
  stateCode: '27',
  registrationType: 'regular',
  billWise: true,
  closingBalance: 1_180_000,
  reservedCode: null,
  isPredefined: false,
  isActive: true,
};

describe('ledgerGotoItems', () => {
  it('opens the Ledger report when it exists', () => {
    const [item] = ledgerGotoItems([row], true);
    assert.equal(item.screen, 'reports.ledger');
    assert.deepEqual(item.params, { ledgerId: 7 });
    assert.equal(item.id, 'ledger:7');
    // 1,180,000 paise = ₹11,800.00 Dr
    assert.equal(item.description, 'Sundry Debtors · 11,800.00 Dr');
    assert.deepEqual(item.keywords, ['ST', '27AAPFU0939F1ZV']);
  });

  it('carries the ledger form as fallback for users who may not open reports', () => {
    const [item] = ledgerGotoItems([row], true);
    assert.deepEqual(item.fallback, { screen: 'accounts.ledger.form', params: { id: 7 } });
    assert.equal(ledgerGotoItems([row], false)[0].fallback, undefined);
  });

  it('falls back to the ledger form; marks inactive ledgers', () => {
    const [item] = ledgerGotoItems([{ ...row, isActive: false, closingBalance: 0, alias: null, gstin: null }], false);
    assert.equal(item.screen, 'accounts.ledger.form');
    assert.deepEqual(item.params, { id: 7 });
    assert.equal(item.description, 'Sundry Debtors · inactive');
    assert.deepEqual(item.keywords, []);
  });
});
