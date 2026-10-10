import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildVoucherInput } from './buildInput.ts';
import { disclosedHasValue, headerDisclosure, isSalesSideDoc, placeOfSupplyAssumed, placeOfSupplyChip } from './disclosure.ts';
import { formReducer, newForm } from './formState.ts';

const base = {
  baseType: 'sales' as const,
  mode: 'item_invoice' as const,
  direction: 'outward' as const,
  showRef: true,
  supplierRef: false,
  gstDoc: true,
  referenceNo: '',
  referenceDate: null,
  reverseCharge: false,
  pinned: false,
};

describe('voucher header: what is inline and what waits in More details (Ctrl+I)', () => {
  it('a new sales invoice: reference and reverse charge only in More details', () => {
    assert.deepEqual(headerDisclosure(base), { refInline: false, refInMore: true, rcInline: false, rcInMore: true });
  });

  it('a value brings them inline (and they stay pinned while the voucher is entered)', () => {
    assert.equal(headerDisclosure({ ...base, referenceNo: 'PO-77' }).refInline, true);
    assert.equal(headerDisclosure({ ...base, referenceDate: '2026-10-01' }).refInline, true);
    assert.equal(headerDisclosure({ ...base, reverseCharge: true }).rcInline, true);
    assert.deepEqual(headerDisclosure({ ...base, pinned: true }), { refInline: true, refInMore: true, rcInline: true, rcInMore: true });
    assert.equal(disclosedHasValue({ referenceNo: ' ', referenceDate: null, reverseCharge: false }), false);
    assert.equal(disclosedHasValue({ referenceNo: '', referenceDate: null, reverseCharge: true }), true);
  });

  it('purchase-side documents keep "Supplier invoice no." and reverse charge inline (ITC / 2B matching)', () => {
    const p = headerDisclosure({ ...base, baseType: 'purchase', direction: 'inward', supplierRef: true });
    assert.deepEqual(p, { refInline: true, refInMore: false, rcInline: true, rcInMore: false });
    assert.equal(isSalesSideDoc('purchase', 'item_invoice', true), false);
  });

  it('receipts and payments (no More details) keep the reference inline', () => {
    const r = headerDisclosure({ ...base, baseType: 'receipt', mode: 'ledger', direction: 'inward', gstDoc: false });
    assert.deepEqual(r, { refInline: true, refInMore: false, rcInline: false, rcInMore: false });
  });

  it('sales-side stock documents and quotations disclose the reference too; non-GST documents have no reverse charge', () => {
    assert.equal(isSalesSideDoc('delivery_note', 'inventory', false), true);
    assert.equal(isSalesSideDoc('quotation', 'accounting_invoice', false), true);
    const d = headerDisclosure({ ...base, baseType: 'delivery_note', mode: 'inventory', gstDoc: false });
    assert.deepEqual(d, { refInline: false, refInMore: true, rcInline: false, rcInMore: false });
  });

  it('a debit note to a supplier keeps 1.0 layout; one to a customer shows reverse charge only when set', () => {
    const toSupplier = headerDisclosure({ ...base, baseType: 'debit_note', direction: 'inward', supplierRef: true });
    assert.deepEqual(toSupplier, { refInline: true, refInMore: false, rcInline: true, rcInMore: false });
    const toCustomer = headerDisclosure({ ...base, baseType: 'debit_note', direction: 'outward', supplierRef: false });
    assert.equal(toCustomer.rcInline, false);
    assert.equal(toCustomer.refInline, true, 'debit notes are not sales-side documents: reference stays inline');
  });

  it('moving fields between header and More details never changes what is sent (buildInput)', () => {
    let f = newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'item_invoice', date: '2026-10-10', partyLedgerId: 9 });
    f = formReducer(f, { type: 'item', key: f.items[0].key, patch: { itemId: 3, qty: 2, rate: 500 } });
    // The More details dialog patches the same form fields the inline inputs used to.
    const viaMore = formReducer(f, { type: 'patch', patch: { referenceNo: 'PO-77', referenceDate: '2026-10-01', reverseCharge: true } });
    const viaInline = formReducer(formReducer(formReducer(f, { type: 'patch', patch: { referenceNo: 'PO-77' } }), { type: 'patch', patch: { referenceDate: '2026-10-01' } }), {
      type: 'patch',
      patch: { reverseCharge: true },
    });
    assert.deepEqual(buildVoucherInput(viaMore).input, buildVoucherInput(viaInline).input);
    const input = buildVoucherInput(viaMore).input;
    assert.equal(input.referenceNo, 'PO-77');
    assert.equal(input.referenceDate, '2026-10-01');
    assert.equal(input.reverseCharge, true);
  });
});

describe('place of supply chip', () => {
  it('derived and known: "Gujarat (24) · intra-state"', () => {
    assert.deepEqual(placeOfSupplyChip({ chosen: '', computed: '24', interState: false, hasError: false }), { label: 'Gujarat (24) · intra-state', code: '24' });
    assert.equal(placeOfSupplyChip({ chosen: '', computed: '27', interState: true, hasError: false })?.label, 'Maharashtra (27) · inter-state');
  });

  it('the select shows when chosen by hand, not derivable, overseas, unknown or in error', () => {
    assert.equal(placeOfSupplyChip({ chosen: '27', computed: '27', interState: true, hasError: false }), null);
    assert.equal(placeOfSupplyChip({ chosen: '', computed: null, interState: null, hasError: false }), null);
    assert.equal(placeOfSupplyChip({ chosen: '', computed: '96', interState: true, hasError: false }), null);
    assert.equal(placeOfSupplyChip({ chosen: '', computed: '24', interState: null, hasError: false }), null);
    assert.equal(placeOfSupplyChip({ chosen: '', computed: '24', interState: false, hasError: true }), null);
    assert.equal(placeOfSupplyChip({ chosen: '', computed: '00', interState: false, hasError: false }), null, 'unknown state code');
  });

  it('a party without a state (no consignee state) only ASSUMES the company state: the select shows (SPEC 6.3)', () => {
    const assumed = placeOfSupplyAssumed({ direction: 'outward', partyChosen: true, partyStateCode: null, consigneeStateCode: undefined });
    assert.equal(assumed, true);
    assert.equal(placeOfSupplyChip({ chosen: '', computed: '27', interState: false, hasError: false, assumed }), null);
    // A consignee state, or the party's own state, is a real basis: the chip stays.
    assert.equal(placeOfSupplyAssumed({ direction: 'outward', partyChosen: true, partyStateCode: ' ', consigneeStateCode: '24' }), false);
    assert.equal(placeOfSupplyAssumed({ direction: 'outward', partyChosen: true, partyStateCode: '24', consigneeStateCode: null }), false);
    // No party yet: the chip (no layout jump while the party is being chosen); purchases: always our state.
    assert.equal(placeOfSupplyAssumed({ direction: 'outward', partyChosen: false, partyStateCode: null, consigneeStateCode: null }), false);
    assert.equal(placeOfSupplyAssumed({ direction: 'inward', partyChosen: true, partyStateCode: null, consigneeStateCode: null }), false);
    assert.ok(placeOfSupplyChip({ chosen: '', computed: '27', interState: false, hasError: false, assumed: false }));
  });

  it('the chip does not change what is sent: placeOfSupply stays automatic until chosen', () => {
    const f = newForm({ voucherTypeId: 1, baseType: 'sales', mode: 'item_invoice', date: '2026-10-10' });
    assert.equal(buildVoucherInput(f).input.placeOfSupply, undefined);
    assert.equal(buildVoucherInput(formReducer(f, { type: 'patch', patch: { placeOfSupply: '24' } })).input.placeOfSupply, '24');
  });
});

describe('initial focus is unchanged by the disclosure', () => {
  it('a sales invoice still starts on the party; a purchase on the supplier invoice no., which stays in the header', () => {
    const fieldsFor = (baseType: 'sales' | 'purchase' | 'debit_note', direction: 'outward' | 'inward', supplierRef: boolean) =>
      headerDisclosure({ ...base, baseType, direction, supplierRef });
    // gridNav.initialFocusId: referenceFirst is set exactly for a purchase / a debit note to a supplier.
    assert.equal(fieldsFor('purchase', 'inward', true).refInline, true, 'the first field of a purchase is rendered');
    assert.equal(fieldsFor('debit_note', 'inward', true).refInline, true);
    // A sale starts on the party (nothing before it to skip): its reference is in More details.
    assert.equal(fieldsFor('sales', 'outward', false).refInline, false);
  });
});
