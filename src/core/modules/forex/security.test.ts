/**
 * Security review (final wave): the openings in the currency belong to the books beginning, so the
 * period lock protects them like the rupee openings (accounts/ledgers.ts assertOpeningUnlocked).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { setPeriodLock } from '../company/service.ts';
import { getForexOpening, saveForexOpening } from './service.ts';
import { forexCompany } from './testkit.ts';

describe('forex openings and the period lock', () => {
  it('refuses to change the opening in the currency once the books beginning is locked; an unchanged save passes', () => {
    const f = forexCompany();
    const booksFrom = f.t.db.value<string>('SELECT books_from FROM company WHERE id = 1') as string;
    const led = f.t.addLedger({
      name: 'Locked Overseas Buyer',
      group: 'SUNDRY_DEBTORS',
      registrationType: 'overseas',
      billWise: true,
      openingBalance: 4_100_000,
      openingBills: [
        { name: 'OB-1', date: '2026-03-15', amount: 2_460_000 },
        { name: 'OB-2', date: '2026-03-20', amount: 1_640_000 },
      ],
      columns: { currency_id: f.usd },
    });
    const bills = (a: number, b: number) => [{ billName: 'OB-1', forexAmount: a }, { billName: 'OB-2', forexAmount: b }];
    saveForexOpening(f.t.ctx, { ledgerId: led, openingForex: 500, bills: bills(300, 200) });
    setPeriodLock(f.t.ctx, booksFrom);
    const locked = (e: unknown): boolean => e instanceof AppError && e.code === 'LOCKED' && /opening/.test(e.message);
    assert.throws(() => saveForexOpening(f.t.ctx, { ledgerId: led, openingForex: 510, bills: bills(310, 200) }), locked);
    assert.throws(() => saveForexOpening(f.t.ctx, { ledgerId: led, openingForex: 500, bills: bills(310, 190) }), locked);
    assert.equal(getForexOpening(f.t.db, led).openingForex, 500);
    // Re-saving the same figures is not a change.
    assert.equal(saveForexOpening(f.t.ctx, { ledgerId: led, openingForex: 500, bills: bills(300, 200) }).openingForex, 500);
    // A lock ending before the books beginning does not cover the openings.
    setPeriodLock(f.t.ctx, null);
    assert.equal(saveForexOpening(f.t.ctx, { ledgerId: led, openingForex: 510, bills: bills(310, 200) }).openingForex, 510);
  });
});
