/**
 * e-Invoice (IRP schema 1.1): payload mapping, validation, bulk JSON, IRP response import, IRN cancel.
 * Company: Test Traders Pvt Ltd, 12 MG Road, PIN 400001, Maharashtra (27). Amounts in paise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { writeXlsx } from '../../lib/xlsx.ts';
import { makeGstin, testPan, type TestCompany } from '../../testing/fixtures.ts';
import { loadCompany, loadDocs } from './docs.ts';
import { buildEinvoice, einvoiceJson, importIrpResponse, jwtData, markIrnCancelled, pendingEinvoices } from './einvoice.ts';
import { insertDoc, setupParties } from './testkit.ts';

const IRN_A = 'a'.repeat(60) + '1234';
const IRN_B = 'b'.repeat(64);

/** E-1: intra-state B2B to Acme — laptop 2 × ₹300 less 10% (taxable 540.00) + installation ₹100 (SAC), 18%, rounded to 755.00. */
function setupE1(today = '2026-04-20') {
  const { t, P } = setupParties({ today });
  const laptop = t.addStockItem({ name: 'Laptop', unit: 'Nos', gstRate: 18, hsnSac: '84713010' });
  const id = insertDoc(t, {
    type: 'sales',
    number: 'E-1',
    date: '2026-04-15',
    party: P.acme,
    nature: 'b2b',
    pos: '27',
    roundOff: -20, // 755.20 → 755.00
    lines: [
      { itemId: laptop, hsn: '84713010', desc: 'Laptop', uqc: 'NOS', qty: 2, rate: 18, taxable: 54000, cgst: 4860, sgst: 4860 },
      { hsn: '998713', desc: 'Installation', kind: 'services', qty: null, rate: 18, taxable: 10000, cgst: 900, sgst: 900 },
    ],
  });
  t.db.run(
    `INSERT INTO inventory_entries (voucher_id, line_no, item_id, qty, rate, discount_pct, amount, date, affects_stock)
     VALUES (:v, 1, :i, -2, 300, 10, 54000, '2026-04-15', 1)`,
    { v: id, i: laptop },
  );
  return { t, P, id };
}

const build = (t: TestCompany, id: number) => {
  const company = loadCompany(t.db);
  const d = loadDocs(t.db, company, { from: '', to: '', today: t.today, ids: [id], anyDate: true })[0];
  const inv = t.db.all<{ item_id: number; qty: number; billed_qty: number | null; rate: number; amount: number }>(
    'SELECT item_id, qty, billed_qty, rate, amount FROM inventory_entries WHERE voucher_id = :id',
    { id },
  );
  return buildEinvoice(d, company, inv, t.today);
};

/** A JWT whose payload carries `data` like the IRP signed QR code (signature not checked). */
function qrJwt(data: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ data: JSON.stringify(data), iss: 'NIC' })}.c2ln`;
}

describe('e-invoice payload', () => {
  it('maps an intra-state B2B invoice (unit price and discount from the stock line, round-off, SAC line)', () => {
    const { t, id } = setupE1();
    const b = build(t, id);
    assert.deepEqual(b.errors, []);
    assert.deepEqual(b.warnings, []);
    const p = b.payload;
    assert.deepEqual(p.TranDtls, { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' });
    assert.deepEqual(p.DocDtls, { Typ: 'INV', No: 'E-1', Dt: '15/04/2026' });
    assert.deepEqual(p.SellerDtls, { Gstin: makeGstin('27'), LglNm: 'Test Traders Pvt Ltd', Addr1: '12 MG Road', Loc: 'Maharashtra', Pin: 400001, Stcd: '27' });
    assert.deepEqual(p.BuyerDtls, {
      Gstin: makeGstin('27', testPan(1)),
      LglNm: 'Acme Industries',
      Pos: '27',
      Addr1: 'Plot 5, MIDC',
      Addr2: 'Andheri East',
      Loc: 'Mumbai',
      Pin: 400093,
      Stcd: '27',
    });
    assert.deepEqual(p.ItemList, [
      // 2 × 300.00 = 600.00 − 10% = 540.00; CGST = SGST = 9% = 48.60; item value 637.20
      { SlNo: '1', PrdDesc: 'Laptop', IsServc: 'N', HsnCd: '84713010', Qty: 2, Unit: 'NOS', UnitPrice: 300, TotAmt: 600, Discount: 60, AssAmt: 540, GstRt: 18, IgstAmt: 0, CgstAmt: 48.6, SgstAmt: 48.6, CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, TotItemVal: 637.2 },
      { SlNo: '2', PrdDesc: 'Installation', IsServc: 'Y', HsnCd: '998713', UnitPrice: 100, TotAmt: 100, Discount: 0, AssAmt: 100, GstRt: 18, IgstAmt: 0, CgstAmt: 9, SgstAmt: 9, CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, TotItemVal: 118 },
    ]);
    // 640.00 + 57.60 + 57.60 − 0.20 = 755.00
    assert.deepEqual(p.ValDtls, { AssVal: 640, CgstVal: 57.6, SgstVal: 57.6, IgstVal: 0, CesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: -0.2, TotInvVal: 755 });
    t.close();
  });

  it('maps exports (URP / 96 / 999999, shipping bill), SEZ without payment and credit notes', () => {
    const { t, P } = setupParties({ today: '2026-04-20' });
    const exp = insertDoc(t, {
      type: 'sales',
      number: 'X-1',
      date: '2026-04-15',
      party: P.global,
      nature: 'export_wpay',
      pos: '96',
      exportDetails: { shippingBillNo: '1234567', shippingBillDate: '2026-04-16', portCode: 'innsa1', withPayment: true, currency: 'usd' },
      lines: [{ hsn: '8471', desc: 'Laptop', uqc: 'NOS', qty: 10, rate: 18, taxable: 500000, igst: 90000 }],
    });
    const e = build(t, exp);
    assert.deepEqual(e.errors, []);
    assert.equal((e.payload.TranDtls as Record<string, unknown>).SupTyp, 'EXPWP');
    assert.deepEqual(e.payload.BuyerDtls, { Gstin: 'URP', LglNm: 'Global Imports LLC', Pos: '96', Addr1: '500 Fifth Avenue', Loc: 'New York', Pin: 999999, Stcd: '96' });
    assert.deepEqual(e.payload.ExpDtls, { ShipBNo: '1234567', ShipBDt: '16/04/2026', Port: 'INNSA1', RefClm: 'Y', ForCur: 'USD' });

    const sez = insertDoc(t, { type: 'sales', number: 'Z-1', date: '2026-04-15', party: P.sez, nature: 'sez_lut', pos: '24', lines: [{ hsn: '8471', desc: 'Laptop', uqc: 'NOS', qty: 4, rate: 18, taxable: 400000 }] });
    const z = build(t, sez);
    assert.deepEqual(z.errors, []);
    assert.equal((z.payload.TranDtls as Record<string, unknown>).SupTyp, 'SEZWOP');
    assert.equal((z.payload.ValDtls as Record<string, unknown>).TotInvVal, 4000);

    const cn = insertDoc(t, { type: 'credit_note', number: 'CN-9', date: '2026-04-18', party: P.bharat, nature: 'b2b', pos: '29', origNo: 'S-2', origDate: '2026-04-03', lines: [{ hsn: '7208', desc: 'Steel', uqc: 'KGS', qty: 5, rate: 18, taxable: 50000, igst: 9000 }] });
    const c = build(t, cn);
    assert.deepEqual(c.errors, []);
    assert.deepEqual(c.payload.DocDtls, { Typ: 'CRN', No: 'CN-9', Dt: '18/04/2026' });
    assert.deepEqual(c.payload.RefDtls, { PrecDocDtls: [{ InvNo: 'S-2', InvDt: '03/04/2026' }] });
    t.close();
  });

  it('explains every rule the IRP would reject', () => {
    const { t, P } = setupParties({ today: '2026-04-20' });
    t.db.run("UPDATE company SET pincode = NULL WHERE id = 1");
    const noPin = t.addLedger({ name: 'No Pin Co', group: 'SUNDRY_DEBTORS', gstin: makeGstin('27', testPan(20)), address: 'Somewhere' });
    const id = insertDoc(t, {
      type: 'sales',
      number: '0INV/1',
      date: '2026-04-25',
      party: noPin,
      nature: 'b2b',
      pos: '27',
      roundOff: 12000,
      lines: [
        { hsn: null, desc: 'Widget', rate: 18, taxable: 10000, igst: 1800 },
        { hsn: '9983', desc: 'Service as goods', kind: 'goods', rate: 18, taxable: 10000, cgst: 900, sgst: 900 },
        { hsn: '8471', desc: 'Discount', rate: 18, taxable: -500, cgst: -45, sgst: -45 },
      ],
    });
    const errors = build(t, id).errors.join('\n');
    for (const re of [
      /Invoice number "0INV\/1" is not accepted/,
      /in the future/,
      /company PIN code is missing/,
      /PIN code of "No Pin Co"/,
      /Line 1: IGST is charged on an intra-state supply/,
      /Line 3 has a negative value/,
      /HSN 9983 is a service \(SAC\) code but the line is goods/,
      /Line 1: HSN\/SAC missing/,
      /Round-off ₹ 120\.00 is outside/,
    ]) {
      assert.match(errors, re);
    }
    assert.equal(P.acme > 0, true);
    t.close();
  });

  it('warns when the invoice is older than 30 days and flags voucher totals that disagree with the GST lines', () => {
    const { t, id } = setupE1('2026-06-01');
    t.db.run('UPDATE vouchers SET tax_amount = 99999 WHERE id = :id', { id });
    const b = build(t, id);
    assert.match(b.warnings.join(' '), /more than 30 days old/);
    assert.match(b.errors.join(' '), /tax total .* differs from its GST lines/);
    t.close();
  });
});

describe('e-invoice workflow', () => {
  it('pending list: B2B/export/SEZ/deemed without IRN, not cancelled/optional; readiness per voucher', () => {
    const { t, P, id } = setupE1();
    insertDoc(t, { type: 'sales', number: 'B2C-1', date: '2026-04-15', party: P.cash, nature: 'b2cs', pos: '27', lines: [{ hsn: '8471', rate: 18, taxable: 1000, cgst: 90, sgst: 90 }] });
    insertDoc(t, { type: 'sales', number: 'DONE-1', date: '2026-04-15', party: P.acme, nature: 'b2b', pos: '27', irn: IRN_A, irnStatus: 'generated', lines: [{ hsn: '8471', rate: 18, taxable: 1000, cgst: 90, sgst: 90 }] });
    insertDoc(t, { type: 'sales', number: 'CXL-1', date: '2026-04-15', party: P.acme, nature: 'b2b', pos: '27', cancelled: true, lines: [] });
    const buyer = t.addLedger({ name: 'Pinless Buyer', group: 'SUNDRY_DEBTORS', gstin: makeGstin('29', testPan(21)), address: '1 Main Road, Mysuru' });
    const nopin = insertDoc(t, { type: 'sales', number: 'NP-1', date: '2026-04-16', party: buyer, nature: 'b2b', pos: '29', irnStatus: 'pending', lines: [{ hsn: '8471', rate: 18, taxable: 1000, igst: 180 }] });
    const r = pendingEinvoices(t.db, loadCompany(t.db), '2026-04-01', '2026-04-30', t.today);
    assert.equal(r.enabled, false);
    assert.deepEqual(r.rows.map((x) => [x.voucherId, x.number, x.supplyType, x.docType, x.ready]), [
      [id, 'E-1', 'B2B', 'INV', true],
      [nopin, 'NP-1', 'B2B', 'INV', false],
    ]);
    assert.deepEqual(r.rows[1].errors, ['The PIN code of "Pinless Buyer" is missing or not 6 digits — enter it in the party ledger or on the voucher.']);
    t.close();
  });

  it('bulk JSON contains only valid vouchers, logs the export and lists the rejected ones', () => {
    const { t, P, id } = setupE1();
    const buyer = t.addLedger({ name: 'Pinless Buyer', group: 'SUNDRY_DEBTORS', gstin: makeGstin('29', testPan(21)), address: '1 Main Road, Mysuru' });
    const bad = insertDoc(t, { type: 'sales', number: 'NP-1', date: '2026-04-16', party: buyer, nature: 'b2b', pos: '29', lines: [{ hsn: '8471', rate: 18, taxable: 1000, igst: 180 }] });
    const b2c = insertDoc(t, { type: 'sales', number: 'B2C-1', date: '2026-04-15', party: P.cash, nature: 'b2cs', pos: '27', lines: [{ hsn: '8471', rate: 18, taxable: 1000, cgst: 90, sgst: 90 }] });
    const f = einvoiceJson(t.ctx, loadCompany(t.db), [id, bad, b2c, 9999]);
    const arr = JSON.parse(f.json) as Array<Record<string, unknown>>;
    assert.equal(f.documents, 1);
    assert.equal(arr.length, 1);
    assert.equal(arr[0].Version, '1.1');
    assert.match(f.fileName, /^EINV_27AAPFU0939F1ZV_20260420_1\.json$/);
    assert.deepEqual(f.rejected.map((r) => r.voucherId).sort((a, b) => a - b), [bad, b2c, 9999].sort((a, b) => a - b));
    const ev = t.db.all<{ voucher_id: number; kind: string; action: string }>('SELECT voucher_id, kind, action FROM gst_doc_events');
    assert.deepEqual(ev, [{ voucher_id: id, kind: 'einvoice', action: 'exported' }]);
    assert.equal(t.db.value("SELECT COUNT(*) FROM audit_log WHERE action = 'export' AND entity_type = 'einvoice'"), 1);
    assert.throws(() => einvoiceJson(t.ctx, loadCompany(t.db), [bad]), (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE');
    t.close();
  });

  it('imports the IRP JSON response (doc no./date from the signed QR code) and updates the voucher', () => {
    const { t, P, id } = setupE1();
    const response = [
      {
        AckNo: 112010036563310,
        AckDt: '2026-04-15 11:05:00',
        Irn: IRN_A,
        SignedInvoice: 'x.y.z',
        SignedQRCode: qrJwt({ SellerGstin: makeGstin('27'), BuyerGstin: makeGstin('27', testPan(1)), DocNo: 'E-1', DocTyp: 'INV', DocDt: '15/04/2026', TotInvVal: 755, Irn: IRN_A }),
        Status: 'ACT',
        EwbNo: 391001234567,
        EwbDt: '2026-04-15 11:05:00',
        EwbValidTill: '2026-04-16 23:59:00',
      },
      { DocDtls: { No: 'E-404', Dt: '15/04/2026', Typ: 'INV' }, ErrorDetails: [{ ErrorCode: '2150', ErrorMessage: 'Duplicate IRN' }] },
      { Irn: IRN_B, DocNo: 'NOPE-1', DocDt: '15/04/2026', AckNo: 1 },
    ];
    assert.equal(jwtData(String(response[0].SignedQRCode))?.DocNo, 'E-1');
    const r = importIrpResponse(t.ctx, 'irp-response.json', new TextEncoder().encode(JSON.stringify(response)));
    assert.equal(r.records, 3);
    assert.deepEqual(r.updated, [{ voucherId: id, number: 'E-1', irn: IRN_A, ackNo: '112010036563310', ewayBillNo: '391001234567' }]);
    assert.deepEqual(r.failed, [{ docNo: 'E-404', docDate: '2026-04-15', message: '2150 Duplicate IRN' }]);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /No sales voucher NOPE-1/);
    const v = t.db.get<Record<string, unknown>>('SELECT irn, irn_ack_no, irn_ack_date, irn_status, irn_signed_qr, eway_bill_no, eway_bill_date, eway_valid_upto FROM vouchers WHERE id = :id', { id });
    assert.deepEqual(v, {
      irn: IRN_A,
      irn_ack_no: '112010036563310',
      irn_ack_date: '2026-04-15 11:05:00',
      irn_status: 'generated',
      irn_signed_qr: response[0].SignedQRCode,
      eway_bill_no: '391001234567',
      eway_bill_date: '2026-04-15 11:05:00',
      eway_valid_upto: '2026-04-16 23:59:00',
    });
    const audit = t.db.get<{ action: string; entity_type: string; entity_id: number }>("SELECT action, entity_type, entity_id FROM audit_log WHERE entity_type = 'voucher' ORDER BY id DESC LIMIT 1");
    assert.deepEqual(audit, { action: 'alter', entity_type: 'voucher', entity_id: id });
    assert.deepEqual(
      t.db.all<{ kind: string; action: string; ref_no: string }>('SELECT kind, action, ref_no FROM gst_doc_events ORDER BY id'),
      [
        { kind: 'einvoice', action: 'generated', ref_no: IRN_A },
        { kind: 'ewaybill', action: 'generated', ref_no: '391001234567' },
      ],
    );
    // Importing again changes nothing; a different IRN for the same voucher is refused.
    const again = importIrpResponse(t.ctx, 'irp-response.json', new TextEncoder().encode(JSON.stringify(response.slice(0, 1))));
    assert.deepEqual(again.unchanged, [{ voucherId: id, number: 'E-1' }]);
    const other = importIrpResponse(t.ctx, 'x.json', new TextEncoder().encode(JSON.stringify({ Irn: IRN_B, DocNo: 'E-1', DocDt: '15/04/2026' })));
    assert.match(other.skipped[0].reason, /already has a different IRN/);
    assert.equal(P.acme > 0, true);
    t.close();
  });

  it('imports the IRP Excel response matched by doc no. + date; warns for a voucher cancelled in the books', () => {
    const { t, P, id } = setupE1();
    const cxl = insertDoc(t, { type: 'sales', number: 'E-2', date: '2026-04-16', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '8471', rate: 18, taxable: 1000, cgst: 90, sgst: 90 }] });
    t.db.run('UPDATE vouchers SET is_cancelled = 1, affects_books = 0 WHERE id = :id', { id: cxl });
    const header = ['Sl. No', 'Doc Type', 'Doc No', 'Doc Date', 'IRN', 'Ack No', 'Ack Date', 'Status', 'Signed QR Code', 'EWB No', 'EWB Date', 'EWB Valid Till'];
    const xlsx = writeXlsx({
      sheets: [
        {
          name: 'IRN Details',
          rows: [
            header,
            [1, 'INV', 'E-1', '15/04/2026', IRN_A, '112010036563310', '15/04/2026 11:05:00 AM', 'ACT', 'qr-text', null, null, null],
            [2, 'INV', 'E-2', '16/04/2026', IRN_B, '112010036563311', '16/04/2026 01:15:00 PM', 'ACT', 'qr-text-2', null, null, null],
          ],
        },
      ],
    });
    const r = importIrpResponse(t.ctx, 'response.xlsx', xlsx);
    assert.deepEqual(r.updated.map((u) => [u.voucherId, u.irn, u.ackNo]), [[id, IRN_A, '112010036563310'], [cxl, IRN_B, '112010036563311']]);
    assert.equal(t.db.value('SELECT irn_ack_date FROM vouchers WHERE id = :id', { id: cxl }), '2026-04-16 13:15:00');
    assert.match(r.warnings[0], /E-2 is cancelled in the books/);
    assert.throws(
      () => importIrpResponse(t.ctx, 'other.xlsx', writeXlsx({ sheets: [{ name: 'S', rows: [['Doc No', 'Amount']] }] })),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION' && /no column named "IRN"/.test(e.message),
    );
    t.close();
  });

  it('marks an IRN cancelled with a reason (audited), only once', () => {
    const { t, id } = setupE1();
    assert.throws(() => markIrnCancelled(t.ctx, id, 'Data entry mistake'), (e: unknown) => e instanceof AppError && /no IRN/.test(e.message));
    t.db.run("UPDATE vouchers SET irn = :irn, irn_status = 'generated' WHERE id = :id", { id, irn: IRN_A });
    const r = markIrnCancelled(t.ctx, id, 'Data entry mistake');
    assert.equal(r.irnStatus, 'cancelled');
    assert.equal(t.db.value('SELECT irn_status FROM vouchers WHERE id = :id', { id }), 'cancelled');
    const ev = t.db.get<{ action: string; detail: string }>("SELECT action, detail FROM gst_doc_events WHERE kind = 'einvoice'");
    assert.deepEqual([ev?.action, JSON.parse(ev?.detail ?? '{}')], ['cancelled', { reason: 'Data entry mistake' }]);
    assert.equal(t.db.value("SELECT COUNT(*) FROM audit_log WHERE action = 'cancel' AND entity_type = 'einvoice'"), 1);
    assert.throws(() => markIrnCancelled(t.ctx, id, 'again'), (e: unknown) => e instanceof AppError && /already marked cancelled/.test(e.message));
    t.close();
  });
});
