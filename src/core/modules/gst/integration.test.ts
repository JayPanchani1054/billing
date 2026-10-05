/**
 * Integration with the posting engine: vouchers saved through vouchers.save (saveVoucher) flow into
 * GSTR-1, GSTR-3B, the exceptions list, e-invoice and e-way bill exactly as the engine writes them.
 * Kit: src/core/modules/vouchers/testkit.ts (company in Maharashtra, 27, working date 15-Apr-2026).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cancelVoucher } from '../vouchers/service.ts';
import { save, salesInput, purchaseInput, setupKit, throwsApp, type Kit } from '../vouchers/testkit.ts';
import { vouchersRoutes } from '../vouchers/routes.ts';
import { loadCompany, loadDocs } from './docs.ts';
import { buildEinvoice, importIrpResponse, pendingEinvoices } from './einvoice.ts';
import { pendingEwayBills } from './ewaybill.ts';
import { computeGstr1, gstr1Summary } from './gstr1.ts';
import { computeGstr3b } from './gstr3b.ts';
import { resolvePeriod } from './period.ts';
import { exceptionsReport } from './reports.ts';

function postMonth(k: Kit): Record<string, number> {
  const ids: Record<string, number> = {};
  // 1: Acme (27) mixer 5 × 200 = 1,000.00 + C/S 90 each = 1,180.00
  ids.inv1 = save(k, salesInput(k)).id;
  // 2: Bangalore (29) rice 10 × 100 = 1,000.00 + IGST 5% 50.00
  ids.inv2 = save(k, salesInput(k, { partyLedgerId: k.L.blr, items: [{ itemId: k.I.rice, qty: 10, rate: 100 }] })).id;
  // 3: walk-in mixer 1 × 500 = 500.00 + C/S 45 each (B2CS)
  ids.inv3 = save(k, salesInput(k, { partyLedgerId: k.L.walkin, items: [{ itemId: k.I.mixer, qty: 1, rate: 500 }] })).id;
  // 4: export under LUT, mixer 2 × 1,000 = 2,000.00, no tax
  ids.inv4 = save(k, salesInput(k, { partyLedgerId: k.L.export, items: [{ itemId: k.I.mixer, qty: 2, rate: 1000 }], exportDetails: { shippingBillNo: 'SB-1001', shippingBillDate: '2026-04-15', portCode: 'INBOM4' } })).id;
  // Credit note against invoice 1: mixer 1 × 200 = 200.00 + C/S 18 each
  ids.cn1 = save(k, {
    voucherTypeId: k.vt.credit_note,
    date: k.t.today,
    mode: 'item_invoice',
    partyLedgerId: k.L.acme,
    originalInvoiceNo: '1',
    originalInvoiceDate: k.t.today,
    items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }],
  }).id;
  // Purchase SUP-101: rice 20 × 80 = 1,600.00 + C/S 40 each; GTA freight 10,000.00 @5% under RCM; return of 2 rice
  ids.p1 = save(k, purchaseInput(k, { referenceDate: '2026-04-14' })).id;
  ids.p2 = save(k, {
    voucherTypeId: k.vt.purchase,
    date: k.t.today,
    mode: 'accounting_invoice',
    partyLedgerId: k.L.gta,
    referenceNo: 'GTA-9',
    referenceDate: k.t.today,
    reverseCharge: true,
    ledgers: [{ ledgerId: k.L.gtaFreight, amount: 1000000 }],
  }).id;
  ids.dn1 = save(k, { voucherTypeId: k.vt.debit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.supplier, originalInvoiceNo: 'SUP-101', items: [{ itemId: k.I.rice, qty: 2, rate: 80 }] }).id;
  return ids;
}

describe('GST returns from vouchers posted by the engine', () => {
  it('GSTR-1 tables, GSTR-3B and exceptions agree with the posted invoices', () => {
    const k = setupKit();
    const ids = postMonth(k);
    const company = loadCompany(k.t.db);
    const period = resolvePeriod({ period: '042026' });
    const s = gstr1Summary(computeGstr1(k.t.db, company, period, k.t.today));
    const sec = (id: string) => s.sections.find((x) => x.id === id);
    // 4A: invoices 1 + 2 → taxable 2,000.00; IGST 50; CGST = SGST 90
    assert.deepEqual([sec('b2b')?.count, sec('b2b')?.taxable, sec('b2b')?.igst, sec('b2b')?.cgst], [2, 200000, 5000, 9000]);
    assert.deepEqual([sec('exp_wop')?.count, sec('exp_wop')?.taxable], [1, 200000]);
    assert.deepEqual(s.b2cs.map((r) => [r.pos, r.rate, r.supplyType, r.taxable, r.cgst]), [['27', 18, 'INTRA', 50000, 4500]]);
    assert.deepEqual([sec('cdnr')?.count, sec('cdnr')?.taxable, sec('cdnr')?.cgst], [1, -20000, -1800]);
    assert.deepEqual(s.docs.map((d) => [d.voucherTypeName, d.from, d.to, d.net]), [['Sales', '1', '4', 4], ['Credit Note', '1', '1', 1]]);
    assert.deepEqual(s.hsnB2b.map((r) => [r.hsn, r.uqc, r.qty, r.taxable]), [['1006', 'NOS', 10, 100000], ['8509', 'NOS', 4, 80000]]);
    assert.deepEqual(s.issues, []);

    const b = computeGstr3b(k.t.db, company, period, k.t.today);
    const sup = (key: string) => b.supplies.find((r) => r.key === key);
    // 3.1(a): 1,000 + 1,000 + 500 − 200 = 2,300.00; CGST 90 + 45 − 18 = 117.00
    assert.deepEqual([sup('osup_det')?.taxable, sup('osup_det')?.igst, sup('osup_det')?.cgst], [230000, 5000, 11700]);
    assert.deepEqual([sup('osup_zero')?.taxable, sup('osup_zero')?.igst], [200000, 0]);
    assert.deepEqual([sup('isup_rev')?.taxable, sup('isup_rev')?.cgst, sup('isup_rev')?.sgst], [1000000, 25000, 25000]);
    const itc = (ty: string) => b.itc.available.find((r) => r.ty === ty);
    assert.deepEqual([itc('ISRC')?.cgst, itc('OTH')?.cgst], [25000, 4000 - 400]);

    const ex = exceptionsReport(k.t.db, company, '2026-04-01', '2026-04-30', k.t.today);
    assert.deepEqual(ex.issues.map((i) => i.code), [], 'the engine writes RCM liability entries and supplier invoice numbers');

    // Cancel invoice 3: it leaves B2CS but stays in Table 13 as cancelled.
    cancelVoucher(k.t.ctx, ids.inv3, 'Entered twice');
    const after = gstr1Summary(computeGstr1(k.t.db, company, period, k.t.today));
    assert.deepEqual(after.b2cs, []);
    assert.deepEqual(after.docs[0], { docNum: 1, docTypeLabel: 'Invoices for outward supply', voucherTypeId: k.vt.sales, voucherTypeName: 'Sales', from: '1', to: '4', total: 4, cancelled: 1, missing: 0, net: 3 });
    k.t.close();
  });

  it('e-invoice: engine marks B2B pending; payload validates; IRP import makes the invoice unalterable', async () => {
    const k = setupKit({ features: { einvoice: true } });
    k.t.db.run("UPDATE ledgers SET address = 'Shop 4, Linking Road\nBandra West\nMumbai', pincode = '400050' WHERE id = :id", { id: k.L.acme });
    const inv = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 5, rate: 200, discountPct: 10 }] }));
    const company = loadCompany(k.t.db);
    const pending = pendingEinvoices(k.t.db, company, '2026-04-01', '2026-04-30', k.t.today);
    assert.deepEqual(pending.rows.map((r) => [r.voucherId, r.irnStatus, r.ready, r.errors]), [[inv.id, 'pending', true, []]]);
    const d = loadDocs(k.t.db, company, { from: '', to: '', today: k.t.today, ids: [inv.id], anyDate: true })[0];
    const invLines = k.t.db.all<{ item_id: number; qty: number; billed_qty: number | null; rate: number; amount: number }>('SELECT item_id, qty, billed_qty, rate, amount FROM inventory_entries WHERE voucher_id = :id', { id: inv.id });
    const p = buildEinvoice(d, company, invLines, k.t.today);
    assert.deepEqual(p.errors, []);
    // 5 × 200 = 1,000.00 less 10% = 900.00; C/S 81.00 each → 1,062.00
    assert.deepEqual((p.payload.ItemList as Array<Record<string, unknown>>)[0], {
      SlNo: '1', PrdDesc: 'Mixer Grinder', IsServc: 'N', HsnCd: '8509', Qty: 5, Unit: 'NOS', UnitPrice: 200, TotAmt: 1000, Discount: 100, AssAmt: 900, GstRt: 18,
      IgstAmt: 0, CgstAmt: 81, SgstAmt: 81, CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, TotItemVal: 1062,
    });
    assert.equal((p.payload.ValDtls as Record<string, unknown>).TotInvVal, 1062);
    const irn = 'c'.repeat(64);
    const r = importIrpResponse(k.t.ctx, 'resp.json', new TextEncoder().encode(JSON.stringify([{ Irn: irn, AckNo: 1, AckDt: '2026-04-15 10:00:00', DocNo: inv.number, DocDt: '15/04/2026' }])));
    assert.equal(r.updated.length, 1);
    assert.equal(pendingEinvoices(k.t.db, company, '2026-04-01', '2026-04-30', k.t.today).rows.length, 0);
    throwsApp(() => save(k, { ...salesInput(k), id: inv.id }), 'BUSINESS_RULE', /IRN/);
    const res = await k.t.call(vouchersRoutes, 'vouchers.get', { id: inv.id });
    assert.equal(res.ok && (res.data as { irn: { status: string } }).irn.status, 'generated');
    k.t.close();
  });

  it('e-way bill pending for a goods sale above ₹50,000 saved with dispatch details', () => {
    const k = setupKit({ features: { ewayBill: true } });
    k.t.db.run("UPDATE ledgers SET address = 'Shop 4, Linking Road\nMumbai', pincode = '400050' WHERE id = :id", { id: k.L.acme });
    // Mixer 45 × 2,000 = 90,000.00 + C/S 8,100 each = 1,06,200.00 consignment
    const inv = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 45, rate: 2000 }], dispatch: { vehicleNo: 'MH01AB1234', distanceKm: 12, mode: 'road' } }));
    const r = pendingEwayBills(k.t.db, loadCompany(k.t.db), '2026-04-01', '2026-04-30', k.t.today);
    assert.equal(r.enabled, true);
    assert.deepEqual(r.rows.map((x) => [x.voucherId, x.consignmentValue, x.ready, x.vehicleNo]), [[inv.id, 10620000, true, 'MH01AB1234']]);
    k.t.close();
  });
});
