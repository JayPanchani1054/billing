/**
 * GST details (gst module, Alt+J) on the voucher form: sent with the input, kept when a voucher is
 * altered (else saving an advance receipt again would silently drop its GST), and limited to what the
 * voucher's base type can carry.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../../shared/types/vouchers.ts';
import { buildVoucherInput, formFromInput } from './buildInput.ts';
import { formReducer, newForm } from './formState.ts';

describe('GST details on the voucher form', () => {
  it('sends an advance on a receipt and keeps it through an alteration', () => {
    let f = newForm({ voucherTypeId: 6, baseType: 'receipt', mode: 'ledger', date: '2026-10-05' });
    f = formReducer(f, { type: 'patch', patch: { gstDetails: { advance: { supplyType: 'services', rate: 18, placeOfSupply: '27' } } } });
    const input = buildVoucherInput(f).input;
    assert.deepEqual(input.gstDetails, { advance: { supplyType: 'services', rate: 18, placeOfSupply: '27' } });

    const saved: VoucherInput = { ...input, id: 41, voucherTypeId: 6, date: '2026-10-05' };
    const altered = formFromInput(saved, { baseType: 'receipt', alter: true });
    assert.deepEqual(buildVoucherInput(altered).input.gstDetails, saved.gstDetails, 'an alteration keeps the advance');
    // The form holds a copy: changing it does not change the loaded input.
    if (altered.gstDetails?.advance) altered.gstDetails.advance.rate = 5;
    assert.equal(saved.gstDetails?.advance?.rate, 18);
  });

  it('drops sections the base type cannot carry and empty ones', () => {
    let f = newForm({ voucherTypeId: 5, baseType: 'payment', mode: 'ledger', date: '2026-10-05' });
    f = formReducer(f, {
      type: 'patch',
      patch: {
        gstDetails: {
          advance: { supplyType: 'services', rate: 18 },
          advanceRefund: { receiptVoucherId: 9, amount: 0 },
          challan: { cpin: '26102700012345', heads: [{ head: 'cgst', minor: 'tax', amount: 5_000_00 }] },
        },
      },
    });
    assert.deepEqual(buildVoucherInput(f).input.gstDetails, { challan: { cpin: '26102700012345', heads: [{ head: 'cgst', minor: 'tax', amount: 5_000_00 }] } });
    const none = formReducer(f, { type: 'patch', patch: { gstDetails: { billOfEntry: { number: ' ', date: '2026-10-01', assessableValue: 0, igst: 0 } } } });
    assert.equal(buildVoucherInput(none).input.gstDetails, undefined);
  });
});
