import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PosReturnContext } from '../../../../shared/types/pos.ts';
import { buildReturnInput, hasPicks, pickAll, pickedValue, pickIssues } from './returns.ts';

const ctx: PosReturnContext = {
  billId: 12,
  billNumber: 'POS/7',
  billDate: '2026-10-08',
  voucherTypeName: 'POS Sales',
  partyLedgerId: 1,
  partyName: 'Cash',
  placeOfSupply: '27',
  billValue: 45_900,
  tenders: [],
  returnVoucherTypeId: 30,
  walkIn: true,
  lines: [
    { index: 0, itemId: 5, name: 'Soap', unit: 'Nos', unitDecimals: 0, sold: 3, returned: 1, returnable: 2, rate: 100, rateInclusiveOfTax: false, discountPct: 0, ledgerId: null, godownId: 2, batchName: null, mrp: 5_900 },
    { index: 1, itemId: 6, name: 'Rice', unit: 'Kg', unitDecimals: 3, sold: 2, returned: 0, returnable: 2, rate: 50, rateInclusiveOfTax: true, discountPct: 10, ledgerId: 8, godownId: null, batchName: 'B1', mrp: null },
  ],
};

describe('POS returns', () => {
  it('checks picked quantities against what is returnable and the unit decimals', () => {
    assert.deepEqual(pickIssues(ctx, new Map([[0, 3]])), { 0: 'Only 2 Nos can be returned.' });
    assert.deepEqual(pickIssues(ctx, new Map([[0, 1.5]])), { 0: 'Nos takes 0 decimal places.' });
    assert.deepEqual(pickIssues(ctx, new Map([[1, 1.25]])), {});
    assert.equal(hasPicks(new Map([[0, 0]])), false);
    assert.deepEqual([...pickAll(ctx)], [
      [0, 2],
      [1, 2],
    ]);
    // 2 × 100 + 1 × 50 − 10 % = 200 + 45 = ₹245.00
    assert.equal(pickedValue(ctx, new Map([[0, 2], [1, 1]])), 24_500);
  });

  it('builds the credit note against the bill', () => {
    const input = buildReturnInput(ctx, new Map([[0, 0], [1, 1]]), { tenders: [{ modeId: 1, amount: 4_725 }] }, { date: '2026-10-09', reason: '', narration: 'Damaged pack' });
    assert.deepEqual(input, {
      voucherTypeId: 30,
      date: '2026-10-09',
      mode: 'item_invoice',
      partyLedgerId: 1,
      placeOfSupply: '27',
      originalInvoiceNo: 'POS/7',
      originalInvoiceDate: '2026-10-08',
      noteReason: 'Sales return',
      narration: 'Damaged pack',
      items: [{ itemId: 6, qty: 1, rate: 50, rateInclusiveOfTax: true, discountPct: 10, ledgerId: 8, batchName: 'B1' }],
      posBill: { tenders: [{ modeId: 1, amount: 4_725 }], returnOfId: 12 },
    });
  });
});
