/**
 * Filed quarterly statements (filed.ts): a voucher whose TDS / TCS or challan was reported in a
 * statement marked filed asks before its reported figures change, and cannot be deleted / cancelled.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { deleteVoucher, saveVoucher } from '../vouchers/service.ts';
import { saveStatementStatus } from './masters.ts';
import { purchase, save, setupTds } from './testkit.ts';

const P = (rupees: number): number => Math.round(rupees * 100);

const needsConfirmation = (re: RegExp) => (e: unknown): boolean =>
  e instanceof AppError && (e.details as { needsConfirmation?: boolean } | undefined)?.needsConfirmation === true && re.test(e.message);

describe('tds: statements marked filed', () => {
  it('asks before a reported figure changes, refuses removal, and leaves other quarters / unchanged figures alone', () => {
    const k = setupTds({ today: '2026-08-10' });
    try {
      // 194C @ 2% on ₹40,000 = ₹800, 20-Apr-2026 (Q1 of FY 2026-27).
      const input = purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-1');
      const v1 = save(k, input);
      assert.equal(k.t.db.value<number>('SELECT amount FROM tds_lines WHERE voucher_id = :id', { id: v1.id }), P(800));

      // Nothing filed yet: an alter needs no confirmation.
      saveVoucher(k.t.ctx, { ...input, id: v1.id, narration: 'Before filing' });

      saveStatementStatus(k.t.ctx, { form: '26Q', fyStart: 2026, quarter: 1, filedOn: '2026-07-25', tokenNo: '123456789012345' });

      // Narration only: the reported figures are unchanged — no question.
      saveVoucher(k.t.ctx, { ...input, id: v1.id, narration: 'Narration changed after filing' });

      // Amount changed: the filed 26Q no longer matches — confirm, then saved.
      const bigger = purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(50_000), 'SC-1');
      assert.throws(() => saveVoucher(k.t.ctx, { ...bigger, id: v1.id }), needsConfirmation(/Form 26Q for Q1 of FY 2026-27 .*correction statement/));
      saveVoucher(k.t.ctx, { ...bigger, id: v1.id, acknowledgeWarnings: true });
      assert.equal(k.t.db.value<number>('SELECT amount FROM tds_lines WHERE voucher_id = :id', { id: v1.id }), P(1_000));

      // Moving it out of the filed quarter also changes the filed statement.
      assert.throws(
        () => saveVoucher(k.t.ctx, { ...purchase(k, '2026-07-02', k.L.contractor, k.L.contractExp, P(50_000), 'SC-1'), id: v1.id }),
        needsConfirmation(/Form 26Q for Q1/),
      );

      // A new deduction dated in the filed quarter.
      assert.throws(
        () => saveVoucher(k.t.ctx, purchase(k, '2026-05-05', k.L.contractor, k.L.contractExp, P(40_000), 'SC-2')),
        needsConfirmation(/already been filed without this deduction/),
      );
      // A new deduction in Q2 (not filed): no question.
      const q2 = saveVoucher(k.t.ctx, purchase(k, '2026-07-05', k.L.contractor, k.L.contractExp, P(40_000), 'SC-3'));
      assert.ok(q2.id > 0);

      // Removal is refused while the statement is marked filed…
      assert.throws(() => deleteVoucher(k.t.ctx, v1.id, 'duplicate'), (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE' && /cannot be deleted/.test(e.message));
      assert.equal(k.t.db.value<number>('SELECT COUNT(*) FROM vouchers WHERE id = :id', { id: v1.id }), 1);

      deleteVoucher(k.t.ctx, q2.id, 'not needed');

      // …and once the filing record is removed (audited), the voucher can go — a TCS statement (27EQ)
      // of the same quarter does not cover a TDS deduction.
      saveStatementStatus(k.t.ctx, { form: '26Q', fyStart: 2026, quarter: 1, filedOn: null });
      saveStatementStatus(k.t.ctx, { form: '27EQ', fyStart: 2026, quarter: 1, filedOn: '2026-07-10' });
      deleteVoucher(k.t.ctx, v1.id, 'duplicate');
      assert.equal(k.t.db.value<number>('SELECT COUNT(*) FROM tds_lines WHERE voucher_id = :id', { id: v1.id }), 0);
    } finally {
      k.t.close();
    }
  });
});
