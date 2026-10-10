import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  blankRate,
  challanErrors,
  challanInput,
  challanTotal,
  enabledKinds,
  initialKind,
  lineSummary,
  monthChoices,
  natureErrors,
  panError,
  previousMonth,
  quarterChoices,
  tanError,
  tdsApplies,
  withNature,
  withOverride,
  type ChallanDraft,
} from './model.ts';
import type { TdsVoucherLine } from '../../../../shared/types/tds.ts';

const draft = (over: Partial<ChallanDraft> = {}): ChallanDraft => ({
  kind: 'tds',
  section: '194C',
  period: '2026-04',
  date: '2026-05-07',
  depositDate: '2026-05-07',
  bankLedgerId: 7,
  bsrCode: '0510001',
  challanNo: '12345',
  minorHead: '200',
  tax: 80_000,
  surcharge: null,
  cess: null,
  interest: null,
  fee: null,
  others: null,
  ...over,
});

describe('tds renderer model', () => {
  it('feature gating: kinds on, initial kind, entry panel base types', () => {
    assert.deepEqual(enabledKinds({ tds: true, tcs: false }), ['tds']);
    assert.equal(initialKind('tcs', { tds: true, tcs: false }), 'tds');
    assert.equal(initialKind('tcs', { tds: true, tcs: true }), 'tcs');
    assert.equal(initialKind(undefined, { tds: false, tcs: false }), null);
    assert.equal(tdsApplies('purchase', { tds: true, tcs: false }), true);
    assert.equal(tdsApplies('sales', { tds: true, tcs: false }), false);
    assert.equal(tdsApplies('sales', { tds: false, tcs: true }), true);
    assert.equal(tdsApplies('receipt', { tds: true, tcs: true }), false);
  });

  it('periods: quarters, months and the previous month', () => {
    assert.deepEqual(quarterChoices('2027-02-10'), { fyStart: 2026, quarter: 4, years: [2026, 2025, 2024] });
    assert.equal(previousMonth('2026-01-15'), '2025-12');
    const m = monthChoices('2026-02-01', 3);
    assert.deepEqual(m.map((x) => x.value), ['2026-02', '2026-01', '2025-12']);
  });

  it('PAN / TAN checks', () => {
    assert.equal(panError(''), undefined);
    assert.equal(panError('abcfs1234c'), undefined);
    assert.match(panError('ABCXS1234C') ?? '', /holder type/);
    assert.equal(tanError('MUMA12345B'), undefined);
    assert.match(tanError('MUM12345B') ?? '', /TAN/);
  });

  it('challan draft: errors, total and the voucher input (blank amounts dropped)', () => {
    assert.deepEqual(challanErrors(draft()), {});
    const e = challanErrors(draft({ bsrCode: '123', challanNo: '123456', tax: null, bankLedgerId: null }));
    assert.deepEqual(Object.keys(e).sort(), ['bankLedgerId', 'bsrCode', 'challanNo', 'tax']);
    assert.equal(challanTotal(draft({ interest: 2_400 })), 82_400);
    assert.deepEqual(challanInput(draft({ interest: 2_400 })), {
      kind: 'tds',
      section: '194C',
      period: '2026-04',
      bsrCode: '0510001',
      challanNo: '12345',
      depositDate: '2026-05-07',
      minorHead: '200',
      tax: 80_000,
      interest: 2_400,
    });
  });

  it('nature form checks', () => {
    assert.deepEqual(natureErrors({ name: 'Contracts', section: '194C', rates: [blankRate('2025-04-01')] }), {});
    const e = natureErrors({ name: '', section: 'abc', rates: [blankRate('2025-04-01'), { ...blankRate('2025-04-01'), thresholdBasis: 'excess' }] });
    assert.deepEqual(Object.keys(e).sort(), ['name', 'rates[1].applicableFrom', 'rates[1].thresholdBasis', 'section']);
  });

  it('overrides and the advance nature compose into VoucherInput.tds (null = automatic)', () => {
    let t = withOverride(null, 5, 0, ' Declaration u/s 194C(6) ');
    assert.deepEqual(t, { overrides: [{ natureId: 5, amount: 0, reason: 'Declaration u/s 194C(6)' }] });
    t = withNature(t, 9);
    assert.deepEqual(t, { overrides: [{ natureId: 5, amount: 0, reason: 'Declaration u/s 194C(6)' }], natureId: 9 });
    t = withOverride(t, 5, null, '');
    assert.deepEqual(t, { natureId: 9 });
    assert.equal(withNature(t, null), null);
  });

  it('line summary for the entry panel', () => {
    const l = { kind: 'tds', section: '194C', rate: 2, base: 4_000_000, amount: 80_000, status: 'deducted' } as TdsVoucherLine;
    assert.equal(lineSummary(l), 'TDS u/s 194C @ 2% on ₹ 40,000.00');
    assert.equal(lineSummary({ ...l, amount: 0, status: 'below_threshold' }), 'TDS u/s 194C: nil — below threshold');
  });
});
