import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GstSetoffResult } from '../../../../shared/types/gst-plus.ts';
import {
  setoffDirty,
  amendmentTableLabel,
  boeFieldErrors,
  cashLedgerMatrix,
  filingRoute,
  gstDetailsForBase,
  rateFormErrors,
  challanDefaults,
  cmp08DueDate,
  compositionDues,
  challanFieldErrors,
  challanGrid,
  cleanGstDetails,
  gridToHeads,
  gstDetailsKinds,
  gstDetailsSummary,
  initialQuarter,
  quarterLabel,
  quarterOfMonthKey,
  quartersFrom,
  setoffExport,
} from './gstplus.ts';

const cashRow = (head: 'igst' | 'cgst' | 'sgst' | 'cess', o: Partial<GstSetoffResult['cash'][number]> = {}): GstSetoffResult['cash'][number] => ({
  head,
  label: head,
  tax: 0,
  interest: 0,
  penalty: 0,
  fee: 0,
  others: 0,
  total: 0,
  available: 0,
  toDeposit: 0,
  ...o,
});

describe('challan defaults', () => {
  it('deposits what each minor head needs less the cash already in the ledger (tax first)', () => {
    // CGST: tax 6,950 + interest 100, 1,000 already deposited → tax 5,950 + interest 100. SGST: 8,750.
    const heads = challanDefaults({
      cash: [cashRow('igst'), cashRow('cgst', { tax: 6_950_00, interest: 100_00, available: 1_000_00 }), cashRow('sgst', { tax: 8_750_00 }), cashRow('cess')],
    });
    assert.deepEqual(heads, [
      { head: 'cgst', minor: 'tax', amount: 5_950_00 },
      { head: 'cgst', minor: 'interest', amount: 100_00 },
      { head: 'sgst', minor: 'tax', amount: 8_750_00 },
    ]);
    // Round trip through the editing grid.
    assert.deepEqual(gridToHeads(challanGrid(heads)), heads);
  });

  it('checks CPIN and CIN shapes', () => {
    assert.deepEqual(challanFieldErrors({ cpin: '26052700012345', cin: '' }), {});
    assert.ok(challanFieldErrors({ cpin: '123', cin: '' }).cpin);
    assert.ok(challanFieldErrors({ cpin: '', cin: '' }).cpin);
    assert.ok(challanFieldErrors({ cpin: '26052700012345', cin: 'SHORT' }).cin);
  });
});

describe('GST details of a voucher', () => {
  it('offers the section that fits the voucher', () => {
    assert.deepEqual(gstDetailsKinds('receipt', false), ['advance']);
    assert.deepEqual(gstDetailsKinds('payment', false), ['refund', 'challan']);
    assert.deepEqual(gstDetailsKinds('sales', true), ['adjust']);
    assert.deepEqual(gstDetailsKinds('debit_note', false), []);
    assert.deepEqual(gstDetailsKinds('debit_note', true), ['adjust']);
    assert.deepEqual(gstDetailsKinds('purchase', false), ['boe']);
    assert.deepEqual(gstDetailsKinds('journal', false), ['adjustment']);
    assert.deepEqual(gstDetailsKinds('contra', false), []);
  });

  it('drops empty sections and summarises the rest', () => {
    assert.equal(cleanGstDetails({ advanceAdjustments: [{ receiptVoucherId: 1, amount: 0 }], billOfEntry: { number: ' ', date: '2026-05-01', assessableValue: 0, igst: 0 } }), undefined);
    const d = { advance: { supplyType: 'services' as const, rate: 18 } };
    assert.deepEqual(cleanGstDetails(d), d);
    assert.equal(gstDetailsSummary(d), 'Advance @ 18%');
    assert.equal(gstDetailsSummary({ adjustment: { nature: 'itc_reversal_r42' } }), 'Reversal of ITC — Rule 42 (common inputs / input services)');
    assert.equal(gstDetailsSummary(undefined), null);
  });
});

describe('exports', () => {
  it('lists credit used and cash by head with the cash total', () => {
    const s = {
      composition: false,
      credit: [{ from: 'igst', to: 'cgst', amount: 1_800_00 }],
      cash: [cashRow('cgst', { tax: 6_950_00, interest: 100_00, total: 7_050_00 })],
      cashTotal: 7_050_00,
    } as unknown as GstSetoffResult;
    const e = setoffExport(s);
    assert.deepEqual(e.rows, [
      ['Credit IGST used for CGST', 1_800_00, '', '', '', '', ''],
      ['Cash CGST', 6_950_00, 100_00, 0, 0, 0, 7_050_00],
    ]);
    assert.deepEqual(e.totals, ['Cash total', '', '', '', '', '', 7_050_00]);
  });
});


describe('quarters', () => {
  it('maps months to GST quarters and picks the quarter being filed', () => {
    assert.equal(quarterOfMonthKey('042026'), '2026-27-Q1');
    assert.equal(quarterOfMonthKey('032027'), '2026-27-Q4');
    assert.equal(quarterLabel('2026-27-Q4'), 'Q4 (Jan–Mar) 2026-27');
    const q = quartersFrom(['082026', '072026', '062026', '042026']);
    assert.deepEqual(q.map((x) => x.value), ['2026-27-Q2', '2026-27-Q1']);
    assert.equal(initialQuarter(q, '2026-08-15'), '2026-27-Q1');
    assert.equal(initialQuarter(q, '2026-08-15', '2026-27-Q2'), '2026-27-Q2');
  });
});

describe('electronic ledgers, composition rates, bills of entry, filings', () => {
  it('folds the cash ledger rows into one row per major head', () => {
    const m = cashLedgerMatrix({
      rows: [
        { head: 'cgst', minor: 'tax', opening: 0, deposited: 5_000_00, utilised: 4_000_00, closing: 1_000_00 },
        { head: 'cgst', minor: 'interest', opening: 0, deposited: 50_00, utilised: 0, closing: 50_00 },
        { head: 'sgst', minor: 'tax', opening: 0, deposited: 0, utilised: 0, closing: 0 },
      ],
    });
    const cgst = m.find((r) => r.head === 'cgst');
    // 1,000.00 tax + 50.00 interest = 1,050.00
    assert.equal(cgst?.total, 1_050_00);
    assert.equal(cgst?.closing.interest, 50_00);
    assert.equal(m.length, 4);
  });

  it('validates the composition rate and bill of entry forms', () => {
    assert.deepEqual(rateFormErrors({ effectiveFrom: '2026-04-01', rate: 1 }), {});
    assert.ok(rateFormErrors({ effectiveFrom: '2017-06-30', rate: 1 }).effectiveFrom);
    assert.ok(rateFormErrors({ effectiveFrom: '2026-04-01', rate: 0 }).rate);
    assert.deepEqual(boeFieldErrors({ number: '1234567', date: '2026-09-02', portCode: 'INNSA1', assessableValue: 10_00_000_00, igst: 1_80_000_00 }), {});
    const e = boeFieldErrors({ number: '', date: null, portCode: 'NSA', assessableValue: null, igst: null });
    assert.deepEqual(Object.keys(e).sort(), ['assessableValue', 'date', 'igst', 'number', 'portCode']);
  });

  it('keeps only the GST details the base type carries', () => {
    const d = { advance: { supplyType: 'services' as const, rate: 18 }, adjustment: { nature: 'rcm_liability' as const } };
    assert.deepEqual(gstDetailsForBase(d, 'receipt'), { advance: d.advance });
    assert.deepEqual(gstDetailsForBase(d, 'journal'), { adjustment: d.adjustment });
    assert.equal(gstDetailsForBase(d, 'contra'), undefined);
  });

  it('labels amendment tables and routes filed returns to their screen', () => {
    const snap = { section: 'b2b' } as never;
    assert.equal(amendmentTableLabel({ table: '9A', original: snap, amended: snap }), '9A B2BA');
    assert.equal(amendmentTableLabel({ table: 'late', original: null, amended: snap }), 'Added');
    assert.deepEqual(filingRoute({ form: 'cmp08', period: '2026-27-Q1' }), { screen: 'gst.cmp08', params: { period: '2026-27-Q1' } });
    assert.deepEqual(filingRoute({ form: 'gstr4', period: '2025-26' }), { screen: 'gst.gstr4', params: { fy: '2025-26' } });
  });
});

describe('composition due dates', () => {
  it('CMP-08 is due on the 18th after the quarter; GSTR-4 on 30 April after the year', () => {
    assert.equal(cmp08DueDate('2026-27-Q1'), '2026-07-18');
    assert.equal(cmp08DueDate('2026-27-Q3'), '2027-01-18');
    assert.equal(cmp08DueDate('2026-27-Q4'), '2027-04-18');
    // 10 Oct 2026: Q2 (Jul–Sep) due 18 Oct, Q3 next; GSTR-4 FY 2025-26 (due 30 Apr 2026) overdue unless filed.
    const d = compositionDues('2026-10-10', [{ form: 'cmp08', period: '2026-27-Q1' }]);
    assert.deepEqual(
      d.map((x) => [x.form, x.period, x.dueDate, x.filed, x.overdue]),
      [
        ['cmp08', '2026-27-Q2', '2026-10-18', false, false],
        ['cmp08', '2026-27-Q3', '2027-01-18', false, false],
        ['gstr4', '2025-26', '2026-04-30', false, true],
      ],
    );
    // In April the previous quarter is Q4 of the last year.
    const apr = compositionDues('2027-04-05', [{ form: 'gstr4', period: '2025-26' }, { form: 'gstr4', period: '2026-27' }]);
    assert.deepEqual(apr.map((x) => x.period), ['2026-27-Q4', '2027-28-Q1']);
  });
});

describe('return period typed in the GST details dialog', () => {
  it('accepts a month or a quarter (empty = the voucher date) and explains anything else', async () => {
    const { periodKeyError } = await import('./gstplus.ts');
    for (const ok of ['', '  ', '092026', '122026', '2026-27-Q2']) assert.equal(periodKeyError(ok), undefined, ok);
    for (const bad of ['132026', '2026-28-Q1', '2026-27-Q5', 'Sep 2026', '92026']) assert.match(periodKeyError(bad) ?? '', /MMYYYY/, bad);
  });
});

describe('GST set-off: leaving with typed amounts asks first', () => {
  const z = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  it('is dirty only while something is typed and nothing is posted', () => {
    assert.equal(setoffDirty(z, z, null), false);
    assert.equal(setoffDirty({ ...z, cgst: 50_000 }, z, null), true);
    assert.equal(setoffDirty(z, { ...z, cess: 100 }, null), true);
    // Posted: the amounts are in the journal, nothing to lose.
    assert.equal(setoffDirty({ ...z, igst: 50_000 }, z, { voucherId: 9 }), false);
  });
});
