/**
 * Documents-module fields on the voucher form: quotation / proforma "valid until", reversing journal
 * "applicable up to", and the conversion / recurring links a draft carries (create only).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../../shared/types/vouchers.ts';
import { buildVoucherInput, formFromInput } from './buildInput.ts';
import { formReducer, newForm } from './formState.ts';

describe('documents fields on the voucher form', () => {
  it('sends "valid until" only for quotations / proforma and "applicable up to" only for reversing journals', () => {
    let q = newForm({ voucherTypeId: 30, baseType: 'quotation', mode: 'item_invoice', date: '2026-10-05', partyLedgerId: 7 });
    q = formReducer(q, { type: 'item', key: q.items[0].key, patch: { itemId: 1, qty: 2, rate: 100 } });
    q = formReducer(q, { type: 'patch', patch: { validUntil: '2026-10-31', applicableUpto: '2026-11-30' } });
    const qi = buildVoucherInput(q).input;
    assert.equal(qi.validUntil, '2026-10-31');
    assert.equal(qi.applicableUpto, undefined);

    let rj = newForm({ voucherTypeId: 18, baseType: 'reversing_journal', mode: 'ledger', date: '2026-03-31' });
    rj = formReducer(rj, { type: 'patch', patch: { applicableUpto: '2026-04-30', validUntil: '2026-04-30' } });
    const ri = buildVoucherInput(rj).input;
    assert.equal(ri.applicableUpto, '2026-04-30');
    assert.equal(ri.validUntil, undefined);
  });

  it('keeps a draft\'s conversion / recurring link on create, drops it when altering', () => {
    const draft: VoucherInput = {
      voucherTypeId: 5,
      date: '2026-10-05',
      mode: 'item_invoice',
      partyLedgerId: 7,
      convertedFromId: 42,
      items: [{ itemId: 1, qty: 2, rate: 100 }],
    };
    const created = buildVoucherInput(formFromInput(draft, { baseType: 'sales', alter: false })).input;
    assert.equal(created.convertedFromId, 42);
    const rec = buildVoucherInput(formFromInput({ ...draft, convertedFromId: undefined, recurring: { templateId: 3, periodKey: '2026-10' } }, { baseType: 'sales', alter: false })).input;
    assert.deepEqual(rec.recurring, { templateId: 3, periodKey: '2026-10' });
    const altered = buildVoucherInput(formFromInput({ ...draft, id: 9 }, { baseType: 'sales', alter: true })).input;
    assert.equal(altered.convertedFromId, undefined, 'links are made on create only');
    const q = formFromInput({ ...draft, voucherTypeId: 30, validUntil: '2026-10-20' }, { baseType: 'quotation', alter: true });
    assert.equal(q.validUntil, '2026-10-20');
  });
});
