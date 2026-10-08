import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OpeningBalanceSummary } from '../../../../shared/types/accounts.ts';
import { chipClasses, explainOpening, ledgerKind } from './ledgerFilters.ts';

describe('ledger filters and opening summary', () => {
  it('chips map to classes', () => {
    assert.deepEqual(chipClasses('parties'), ['party']);
    assert.equal(chipClasses('all'), undefined);
    assert.equal(ledgerKind({ classes: ['party', 'creditor', 'liability'] }), 'Supplier');
    assert.equal(ledgerKind({ classes: ['bank', 'cash_bank', 'asset'] }), 'Bank');
  });

  const sum = (totalDebit: number, totalCredit: number, ledgerCount = 2): OpeningBalanceSummary => ({ totalDebit, totalCredit, difference: totalDebit - totalCredit, ledgerCount });

  it('balanced openings', () => {
    assert.equal(explainOpening(sum(50_000, 50_000), null).tone, 'success');
  });

  it('difference explained with side and amount: Dr 60,000 − Cr 50,000 = 10,000 Dr (₹100.00)', () => {
    const x = explainOpening(sum(60_000, 50_000), null);
    assert.equal(x.tone, 'warning');
    assert.equal(x.title, 'Difference in opening balances: ₹ 100.00 Dr');
  });

  it('opening stock (a debit) closes a credit difference: Dr 40,000 − Cr 50,000 + stock 10,000 = 0', () => {
    const x = explainOpening(sum(40_000, 50_000), 10_000);
    assert.equal(x.tone, 'success');
    assert.match(x.body, /opening stock of ₹ 100\.00/);
  });

  it('no openings at all', () => {
    assert.equal(explainOpening(sum(0, 0, 0), null).title, 'No opening balances entered');
  });
});
