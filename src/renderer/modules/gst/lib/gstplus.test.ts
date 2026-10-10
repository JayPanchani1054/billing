import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GstSetoffResult } from '../../../../shared/types/gst-plus.ts';
import {
  challanDefaults,
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
