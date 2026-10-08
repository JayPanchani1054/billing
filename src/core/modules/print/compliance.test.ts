/**
 * Statutory particulars checks (compliance.ts) — unit cases on hand-adjusted documents plus the
 * warnings a real voucher gets through print.voucherData. Company: Maharashtra (27), regular dealer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrintVoucherData } from '../../../shared/types/print.ts';
import { save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { B2C_ADDRESS_THRESHOLD_PAISE, complianceWarnings, type ComplianceContext } from './compliance.ts';
import { buildPrintDataFor } from './data.ts';

const DATE = '2026-04-15';
const CTX: ComplianceContext = { issuedByCompany: true, companyGst: 'regular', hsnDigits: 4, einvoice: false };

function addressed(k: Kit): Kit {
  k.t.db.run("UPDATE ledgers SET address = '12, MG Road, Pune' WHERE id IN (:a, :b)", { a: k.L.acme, b: k.L.blr });
  return k;
}

/** A B2B tax invoice that satisfies every check: Rice 10 × 50 @5% to Acme (27, with address). */
function goodInvoice(k: Kit): PrintVoucherData {
  const id = save(k, { voucherTypeId: k.vt.sales, date: DATE, mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.rice, qty: 10, rate: 50 }] }).id;
  return buildPrintDataFor(k.t.ctx, id);
}

describe('compliance warnings (Rule 46 / 49 / 53 / 55 particulars)', () => {
  it('a complete B2B tax invoice has no warnings', () => {
    const k = addressed(setupKit());
    const d = goodInvoice(k);
    assert.deepEqual(d.warnings, []);
    assert.deepEqual(complianceWarnings(d, CTX), []);
    k.t.close();
  });

  it('serial number: missing, longer than 16 characters, or with characters GSTN rejects', () => {
    const k = addressed(setupKit());
    const d = goodInvoice(k);
    assert.match(complianceWarnings({ ...d, number: null }, CTX)[0], /has no number/);
    // 'INV/2026-27/000001' is 18 characters.
    assert.match(complianceWarnings({ ...d, number: 'INV/2026-27/000001' }, CTX)[0], /at most 16 characters/);
    assert.match(complianceWarnings({ ...d, number: 'INV 12' }, CTX)[0], /letters, digits, "-" and "\/" only/);
    assert.deepEqual(complianceWarnings({ ...d, number: 'MH/2026-27/00001' }, CTX), [], '16 characters is fine');
    // Challans are numbered documents too (Rule 55); a payment voucher is not.
    assert.equal(complianceWarnings({ ...d, kind: 'delivery_challan', layout: 'inventory', number: null }, CTX).length, 1);
    assert.deepEqual(complianceWarnings({ ...d, kind: 'payment_voucher', layout: 'voucher', number: null }, CTX), []);
    k.t.close();
  });

  it('recipient: registered buyer needs an address; unregistered buyer at ₹50,000 or more needs name, address and state', () => {
    const k = addressed(setupKit());
    const d = goodInvoice(k);
    const party = d.party;
    assert.ok(party);
    assert.match(complianceWarnings({ ...d, party: { ...party, address: null } }, CTX)[0], /GST-registered but has no address/);
    assert.match(complianceWarnings({ ...d, party: { ...party, gstin: null, registrationType: 'regular' } }, CTX)[0], /marked as GST-registered but has no GSTIN/);
    const b2c = { ...party, gstin: null, address: null, stateCode: null, stateName: null, registrationType: 'unregistered' };
    // Below the threshold (₹500.00 taxable): nothing required.
    assert.deepEqual(complianceWarnings({ ...d, party: b2c }, CTX), []);
    const big = { ...d, party: b2c, totals: { ...d.totals, taxable: B2C_ADDRESS_THRESHOLD_PAISE } };
    const w = complianceWarnings(big, CTX);
    assert.equal(w.length, 1);
    assert.match(w[0], /₹50,000 or more/);
    assert.match(w[0], /Missing: address, state\./);
    k.t.close();
  });

  it('place of supply, HSN digits, credit note reference and e-invoice IRN', () => {
    const k = addressed(setupKit());
    const d = goodInvoice(k);
    assert.match(complianceWarnings({ ...d, placeOfSupply: null }, CTX)[0], /no place of supply/);
    const noHsn = { ...d, lines: d.lines.map((l) => ({ ...l, hsnSac: '10' })) };
    assert.match(complianceWarnings(noHsn, CTX)[0], /HSN\/SAC code missing or shorter than 4 digits on line 1 \(Rice Bag\)/);
    // Above ₹5 crore turnover (6 digits) every invoice — B2C too — needs 6 digits: '1006' is short.
    const b2c = { ...d, party: d.party ? { ...d.party, gstin: null, registrationType: 'unregistered' } : null };
    assert.match(complianceWarnings(b2c, { ...CTX, hsnDigits: 6 })[0], /shorter than 6 digits/);
    assert.deepEqual(complianceWarnings(b2c, CTX), [], 'up to ₹5 crore, B2C invoices may omit HSN');
    const note = { ...d, kind: 'credit_note' as const, originalInvoice: null };
    assert.match(complianceWarnings(note, CTX)[0], /Rule 53 requires the original invoice number and date/);
    assert.deepEqual(complianceWarnings({ ...note, originalInvoice: { number: '1', date: DATE, reason: null } }, CTX), []);
    assert.match(complianceWarnings(d, { ...CTX, einvoice: true })[0], /has no IRN yet/);
    assert.deepEqual(complianceWarnings({ ...d, einvoice: { irn: 'x', ackNo: null, ackDate: null, signedQr: null } }, { ...CTX, einvoice: true }), []);
    assert.deepEqual(complianceWarnings(b2c, { ...CTX, einvoice: true }), [], 'B2C invoices are not e-invoiced');
    k.t.close();
  });

  it('never warns for documents the company does not issue, cancelled / optional vouchers, or unregistered companies', () => {
    const k = addressed(setupKit());
    const d = { ...goodInvoice(k), number: null, placeOfSupply: null };
    assert.equal(complianceWarnings(d, CTX).length, 2);
    assert.deepEqual(complianceWarnings(d, { ...CTX, issuedByCompany: false }), []);
    assert.deepEqual(complianceWarnings(d, { ...CTX, companyGst: 'unregistered' }), []);
    assert.deepEqual(complianceWarnings({ ...d, status: { ...d.status, cancelled: true } }, CTX), []);
    assert.deepEqual(complianceWarnings({ ...d, status: { ...d.status, optional: true } }, CTX), []);
    k.t.close();
  });
});

describe('compliance warnings on real vouchers (print.voucherData)', () => {
  it('walk-in buyer for ₹70,800 without an address → Rule 46(e) warning', () => {
    const k = setupKit();
    // 40 × 1,500.00 = 60,000.00 taxable (≥ 50,000) @18% → 70,800.00
    const id = save(k, { voucherTypeId: k.vt.sales, date: DATE, mode: 'item_invoice', partyLedgerId: k.L.walkin, items: [{ itemId: k.I.mixer, qty: 40, rate: 1500 }] }).id;
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.totals.grandTotal, 7080000);
    assert.equal(d.warnings.length, 1);
    assert.match(d.warnings[0], /unregistered buyer is for ₹50,000 or more.*Missing: address\./);
    k.t.close();
  });

  it('item without a GST rate on a regular dealer’s invoice is flagged', () => {
    const k = addressed(setupKit());
    const id = save(k, { voucherTypeId: k.vt.sales, date: DATE, mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.noRate, qty: 1, rate: 10 }] }).id;
    const d = buildPrintDataFor(k.t.ctx, id);
    assert.equal(d.kind, 'bill_of_supply');
    assert.equal(d.warnings.length, 1);
    assert.match(d.warnings[0], /Line 1 \(Unclassified Item\) is taxable but has no GST rate/);
    k.t.close();
  });

  it('e-invoicing on: a B2B invoice without an IRN is flagged; export under LUT is not a missing rate', () => {
    const k = addressed(setupKit({ features: { einvoice: true } }));
    const d = goodInvoice(k);
    assert.equal(d.warnings.length, 1);
    assert.match(d.warnings[0], /no IRN yet/);
    k.t.db.run("UPDATE ledgers SET address = '1 Main St, Austin' WHERE id = :id", { id: k.L.export });
    const exp = buildPrintDataFor(
      k.t.ctx,
      save(k, { voucherTypeId: k.vt.sales, date: DATE, mode: 'item_invoice', partyLedgerId: k.L.export, items: [{ itemId: k.I.mixer, qty: 1, rate: 150 }] }).id,
    );
    assert.equal(exp.kind, 'export_invoice');
    assert.deepEqual(exp.warnings.map((w) => /no IRN yet/.test(w)), [true], 'only the IRN warning');
    k.t.close();
  });

  it('a purchase voucher (supplier’s document) gets no compliance warnings', () => {
    const k = setupKit();
    const id = save(k, { voucherTypeId: k.vt.purchase, date: DATE, mode: 'item_invoice', partyLedgerId: k.L.supplier, referenceNo: 'S-1', items: [{ itemId: k.I.rice, qty: 10, rate: 40 }] }).id;
    assert.deepEqual(buildPrintDataFor(k.t.ctx, id).warnings, []);
    k.t.close();
  });
});
