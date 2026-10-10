/**
 * V2 review: numberGaps on a busy series. A counter that issues ~400 bills a day reaches 150,000 numbers in
 * a year; the gaps view (Invoice Numbering › "Gaps this year") must still answer — no argument-spread of
 * every sequence into Math.max (V8 overflows its stack at ~125,000 arguments).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setupKit } from '../vouchers/testkit.ts';
import { numberGaps } from './numbering.ts';

describe('accounts.voucherType.numberGaps on a large series (V2 review)', () => {
  it('150,000 numbers in one year: first, last and the missing ones are found', () => {
    const k = setupKit({ today: '2026-06-30' });
    const now = k.t.clock.now().toISOString();
    // Sales 1…150,000 except 77 (missing), all dated in FY 2026-27 (default series: plain numbers, yearly).
    k.t.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150000)
       INSERT INTO vouchers (guid, voucher_type_id, base_type, number, number_seq, date, created_at, updated_at)
       SELECT lower(hex(randomblob(16))), :vt, 'sales', CAST(i AS TEXT), i, date('2026-04-01', '+' || (i % 300) || ' days'), :now, :now FROM n WHERE i <> 77`,
      { vt: k.vt.sales, now },
    );
    const g = numberGaps(k.t.db, { id: k.vt.sales, from: '2026-04-01', to: '2027-03-31' });
    assert.deepEqual([g.first, g.last, g.issued, g.missingCount, g.missing], ['1', '150000', 149999, 1, ['77']]);
    k.t.close();
  });
});
