/**
 * TDS / TCS module (src/core/modules/tds), second step of the tds block (160–169). Additive only.
 *
 *  - tds_lines.advance_adjusted: the part of a bill / journal credit already covered by an advance the
 *    party was paid earlier under the same nature (a Payment voucher whose TDS line is the advance).
 *    That part was counted (and taxed, when liable) when the advance was paid, so the credit takes only
 *    the rest into the threshold aggregate and the tax base — no second deduction on the same sum.
 *  - Seed correction: TCS u/s 206C(1) on timber / other forest produce (not tendu leaves) is 2% from
 *    1-Oct-2024 (Finance (No. 2) Act 2024; it was 2.5%). Added as a dated rate row of the system
 *    nature; the earlier 2.5% row stays for sales before that date. Skipped when the user already has a
 *    row from that date.
 */
export const migration161 = {
  version: 161,
  name: 'tds_advances',
  sql: /* sql */ `
ALTER TABLE tds_lines ADD COLUMN advance_adjusted INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO tds_nature_rates (nature_id, applicable_from, rate_individual, rate_company, rate_others, rate_no_pan, threshold_single,
  threshold_aggregate, aggregate_period, threshold_basis, base_includes_gst, note)
SELECT id, '2024-10-01', 2, 2, 2, 5, NULL, NULL, 'fy', 'whole', 1,
       'Rate 2% from 1-Oct-2024 (Finance (No. 2) Act 2024; earlier 2.5%). No PAN: twice the rate or 5%, whichever is higher (s.206CC).'
  FROM tds_natures WHERE kind = 'tcs' AND is_system = 1 AND name = 'Sale of timber or other forest produce';
`,
} as const;
