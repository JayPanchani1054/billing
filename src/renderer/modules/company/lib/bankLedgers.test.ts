import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BANK_PICKER_LIMIT, bankLedgerQuery, parseBankLedgers } from './bankLedgers.ts';

describe('F12 bank account picker', () => {
  test('asks accounts.ledger.list for active bank ledgers matching the typed text, limited', () => {
    assert.deepEqual(bankLedgerQuery('  hdfc '), { search: 'hdfc', classes: ['bank'], activeOnly: true, limit: BANK_PICKER_LIMIT });
    assert.deepEqual(bankLedgerQuery(''), { classes: ['bank'], activeOnly: true, limit: BANK_PICKER_LIMIT });
  });

  test('reads { rows } (and arrays); keeps bank ledgers under any sub-group name; skips junk', () => {
    const out = { rows: [{ id: 3, name: 'HDFC Bank', groupName: 'Bank Accounts' }, { id: 9, name: 'SBI Current', groupName: 'Branch Banking' }, { id: 'x', name: 'bad' }, null], total: 2 };
    assert.deepEqual(parseBankLedgers(out), [
      { id: 3, name: 'HDFC Bank' },
      { id: 9, name: 'SBI Current' },
    ]);
    assert.deepEqual(parseBankLedgers([{ id: 1, name: 'Axis' }]), [{ id: 1, name: 'Axis' }]);
    assert.deepEqual(parseBankLedgers(undefined), []);
  });
});
