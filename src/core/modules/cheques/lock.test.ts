/**
 * Security review (final wave): cheque-leaf marks follow the period lock (F12) — the cheque register of
 * a locked period stays as it was closed. Today: 15-Apr-2026.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { setPeriodLock } from '../company/service.ts';
import { cancelLeaf, restoreLeaf, saveBook } from './books.ts';
import { chequeKit } from './testkit.ts';

const locked = (e: unknown): boolean => e instanceof AppError && e.code === 'LOCKED';

describe('cheque leaves and the locked period', () => {
  it('refuses cancelling or re-opening a leaf dated on or before the lock date', () => {
    const k = chequeKit();
    try {
      saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 101, toNo: 110 });
      cancelLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '101', reason: 'Spoilt', date: '2026-04-05' });
      setPeriodLock(k.t.ctx, '2026-04-10');
      assert.throws(() => cancelLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '102', reason: 'Torn', date: '2026-04-10' }), locked);
      assert.throws(() => restoreLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '101' }), locked);
      assert.equal(k.t.db.value<number>('SELECT COUNT(*) FROM cheque_leaf_marks WHERE bank_ledger_id = :b', { b: k.L.bank }), 1);
      // After the lock date (and today by default) it works as before.
      cancelLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '102', reason: 'Torn', date: '2026-04-11' });
      restoreLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '102' });
      cancelLeaf(k.t.ctx, { bankLedgerId: k.L.bank, chequeNo: '103', reason: 'Torn' });
    } finally {
      k.t.close();
    }
  });
});
