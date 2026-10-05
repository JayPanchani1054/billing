/**
 * Regression tests: GST direction of credit/debit notes, and the date-aware B2CL threshold.
 * Company: Maharashtra (27). Amounts in paise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { partyContext } from './queries.ts';
import { previewVoucher } from './service.ts';
import { entryMap, gstLines, header, salesInput, save, setupKit, stockOf, throwsField, type Kit } from './testkit.ts';

const note = (k: Kit, base: 'credit_note' | 'debit_note', over: Partial<VoucherInput>): VoucherInput => ({
  voucherTypeId: k.vt[base],
  date: k.t.today,
  mode: 'item_invoice',
  ...over,
});

describe('debit note to a customer (supplementary invoice / upward price revision)', () => {
  it('accounting mode: Output tax is credited and the note is an outward B2B document', () => {
    const k = setupKit();
    // Price revision ₹2,000.00 on consultancy @18%: CGST 9% = 180.00, SGST 180.00 → ₹2,360.00.
    // Before the fix the engine treated every Debit Note as inward: Input CGST/SGST were credited
    // (an ITC reversal) and the note was classified inward_b2b, so GSTR-1 never showed it.
    const res = save(k, note(k, 'debit_note', { mode: 'accounting_invoice', partyLedgerId: k.L.acme, ledgers: [{ ledgerId: k.L.consult, amount: 200000 }] }));
    assert.deepEqual(entryMap(k, res.id), {
      'Acme Traders': 236000,
      'Consultancy Income': -200000,
      'Output CGST': -18000,
      'Output SGST/UTGST': -18000,
    });
    const h = header(k, res.id);
    assert.equal(h.gst_nature, 'b2b');
    assert.equal(h.total_amount, 236000);
    const g = gstLines(k, res.id);
    assert.deepEqual([g[0].cgst, g[0].sgst, g[0].itc_eligibility], [18000, 18000, null], 'outward: no ITC eligibility');
    k.t.close();
  });

  it('item mode: Sales ledger by default (not the type’s Purchase default), stock goes out', () => {
    const k = setupKit();
    // Mixer 2 × ₹50 = ₹100.00 @18%: CGST 9.00 + SGST 9.00 → ₹118.00.
    const res = save(k, note(k, 'debit_note', { partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 2, rate: 50 }] }));
    assert.deepEqual(entryMap(k, res.id), { 'Acme Traders': 11800, Sales: -10000, 'Output CGST': -900, 'Output SGST/UTGST': -900 });
    const roles = k.t.db.all<{ role: string }>('SELECT role FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no', { id: res.id });
    assert.deepEqual(roles.map((r) => r.role), ['party', 'sales', 'tax', 'tax']);
    assert.equal(stockOf(k, k.I.mixer), 48);
    assert.equal(header(k, res.id).gst_nature, 'b2b');
    k.t.close();
  });

  it('e-invoice: an outward debit note is pending an IRN; a purchase return is not', () => {
    const k = setupKit({ features: { einvoice: true } });
    const out = save(k, note(k, 'debit_note', { mode: 'accounting_invoice', partyLedgerId: k.L.acme, ledgers: [{ ledgerId: k.L.consult, amount: 10000 }] }));
    const ret = save(k, note(k, 'debit_note', { partyLedgerId: k.L.supplier, items: [{ itemId: k.I.rice, qty: 1, rate: 50 }] }));
    assert.equal(header(k, out.id).irn_status, 'pending');
    assert.equal(header(k, ret.id).irn_status, null);
    k.t.close();
  });

  it('a debit note to a supplier is still a purchase return (Input tax reversed)', () => {
    const k = setupKit();
    // Rice 2 × ₹100 = ₹200.00 @5%: CGST 5.00 + SGST 5.00 → ₹210.00.
    const res = save(k, note(k, 'debit_note', { partyLedgerId: k.L.supplier, items: [{ itemId: k.I.rice, qty: 2, rate: 100 }] }));
    assert.deepEqual(entryMap(k, res.id), { 'Supreme Suppliers': 21000, Purchase: -20000, 'Input CGST': -500, 'Input SGST/UTGST': -500 });
    assert.equal(header(k, res.id).gst_nature, 'inward_b2b');
    assert.equal(gstLines(k, res.id)[0].itc_eligibility, 'inputs');
    k.t.close();
  });

  it('partyContext tells the entry screen which direction a note takes', () => {
    const k = setupKit();
    assert.equal(partyContext(k.t.ctx, k.L.acme, k.t.today).gstDirection, 'outward');
    assert.equal(partyContext(k.t.ctx, k.L.supplier, k.t.today).gstDirection, 'inward');
    assert.equal(partyContext(k.t.ctx, k.L.cash, k.t.today).gstDirection, null);
    k.t.close();
  });
});

describe('credit note with a supplier', () => {
  it('is refused with directions instead of posting Output tax against a supplier', () => {
    const k = setupKit();
    // Before the fix: Dr Purchase-side lines, Dr Output CGST/SGST and a b2b credit note "issued" to the
    // supplier's GSTIN (GSTR-1 CDNR) — a document we never issued.
    throwsField(
      () => save(k, note(k, 'credit_note', { partyLedgerId: k.L.supplier, items: [{ itemId: k.I.mixer, qty: 1, rate: 100 }] })),
      'partyLedgerId',
      /Supreme Suppliers is a supplier.*Debit Note.*Purchase/,
    );
    // Ledger mode (no GST computation) is still allowed: lines post as entered.
    const res = save(k, {
      voucherTypeId: k.vt.credit_note,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [{ ledgerId: k.L.purchase, amount: 5000 }, { ledgerId: k.L.supplier, amount: -5000 }],
    });
    assert.deepEqual(entryMap(k, res.id), { Purchase: 5000, 'Supreme Suppliers': -5000 });
    k.t.close();
  });
});

describe('B2CL threshold follows the invoice date unless F12 overrides it', () => {
  it('₹2,50,000 before 1-Aug-2024, ₹1,00,000 from then on; an explicit F12 value always wins', () => {
    const k = setupKit({ today: '2024-06-15' });
    const mysore = k.t.addLedger({ name: 'Mysore Buyer', group: 'SUNDRY_DEBTORS', stateCode: '29' });
    const sale = (date: string, rate: number): VoucherInput => salesInput(k, { date, partyLedgerId: mysore, items: [{ itemId: k.I.mixer, qty: 1, rate }] });
    // ₹1,50,000 + IGST 18% ₹27,000 = ₹1,77,000: above ₹1,00,000 but not above ₹2,50,000.
    // Before the fix the F12 default (₹1,00,000) was applied to every date → b2cl.
    assert.equal(previewVoucher(k.t.ctx, sale('2024-06-15', 150000)).gstNature, 'b2cs');
    // ₹2,50,000 + ₹45,000 = ₹2,95,000 > ₹2,50,000 → b2cl.
    assert.equal(previewVoucher(k.t.ctx, sale('2024-06-15', 250000)).gstNature, 'b2cl');
    // From 1-Aug-2024 the same ₹1,77,000 invoice is B2CL.
    assert.equal(previewVoucher(k.t.ctx, sale('2024-08-01', 150000)).gstNature, 'b2cl');
    const saved = save(k, sale('2024-07-31', 150000));
    assert.equal(header(k, saved.id).gst_nature, 'b2cs');

    // Explicit threshold ₹50,000: ₹50,000 + ₹9,000 = ₹59,000 > ₹50,000 → b2cl even in June 2024.
    k.t.db.run(`UPDATE settings SET value = json_set(value, '$.gst.b2clThresholdPaise', 5000000) WHERE key = 'config'`);
    assert.equal(previewVoucher(k.t.ctx, sale('2024-06-15', 50000)).gstNature, 'b2cl');
    // ₹40,000 + ₹7,200 = ₹47,200 ≤ ₹50,000 → b2cs.
    assert.equal(previewVoucher(k.t.ctx, sale('2024-06-15', 40000)).gstNature, 'b2cs');
    k.t.close();
  });
});
