/**
 * e-Way bill: pending list (Rule 138 threshold), bulk JSON, validation and recording the EWB number.
 * Company: Test Traders Pvt Ltd, 12 MG Road, PIN 400001, Maharashtra (27). Amounts in paise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../../lib/errors.ts';
import { makeGstin, testPan } from '../../testing/fixtures.ts';
import { loadCompany, loadDocs } from './docs.ts';
import { buildEwayBill, consignmentValue, ewayJson, pendingEwayBills, updateEwayBill } from './ewaybill.ts';
import { insertDoc, setupParties } from './testkit.ts';

const TRANSPORTER = makeGstin('27', testPan(30));

function setup() {
  const { t, P } = setupParties({ today: '2026-04-20' });
  const steel = (taxable: number, cgst: number) => ({ hsn: '72081000', desc: 'HR Steel Coil', uqc: 'KGS', qty: 100, rate: 18, taxable, cgst, sgst: cgst });
  const dispatch = { vehicleNo: 'MH 12 AB 1234', transporterId: TRANSPORTER, transporterName: 'Speedy Logistics', mode: 'road', distanceKm: 25, lrNo: 'LR-55', lrDate: '2026-04-15' };
  // W-1: ₹60,000 steel + 18% (C/S 5,400 each) + installation ₹1,000 + 18%: consignment 70,800.00; invoice 71,980.00; ship to Pune.
  const w1 = insertDoc(t, {
    type: 'sales',
    number: 'W-1',
    date: '2026-04-15',
    party: P.acme,
    nature: 'b2b',
    pos: '27',
    dispatch,
    consignee: { name: 'Acme Pune Warehouse', address: 'Warehouse 3, Chakan MIDC\nPune', stateCode: '27', pincode: '411001' },
    lines: [steel(6000000, 540000), { hsn: '998713', desc: 'Installation', kind: 'services', rate: 18, taxable: 100000, cgst: 9000, sgst: 9000 }],
  });
  // W-2: consignment exactly ₹50,000.00 (42,372.88 + 3,813.56 × 2) — not above the threshold.
  const w2 = insertDoc(t, { type: 'sales', number: 'W-2', date: '2026-04-15', party: P.acme, nature: 'b2b', pos: '27', dispatch, lines: [steel(4237288, 381356)] });
  // W-3: services only; W-4: already has an e-way bill.
  insertDoc(t, { type: 'sales', number: 'W-3', date: '2026-04-15', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '998713', kind: 'services', rate: 18, taxable: 9000000, cgst: 810000, sgst: 810000 }] });
  insertDoc(t, { type: 'sales', number: 'W-4', date: '2026-04-15', party: P.acme, nature: 'b2b', pos: '27', ewayBillNo: '391000000001', dispatch, lines: [steel(9000000, 810000)] });
  // W-5: sales return from Bharat (29) — inward movement.
  const w5 = insertDoc(t, {
    type: 'credit_note',
    number: 'W-5',
    date: '2026-04-16',
    party: P.bharat,
    nature: 'b2b',
    pos: '29',
    origNo: 'S-2',
    dispatch: { ...dispatch, distanceKm: 980 },
    lines: [{ hsn: '72081000', desc: 'HR Steel Coil', uqc: 'KGS', qty: 100, rate: 18, taxable: 6000000, igst: 1080000 }],
  });
  return { t, P, w1, w2, w5 };
}

const bill = (t: ReturnType<typeof setup>['t'], id: number) => {
  const company = loadCompany(t.db);
  const d = loadDocs(t.db, company, { from: '', to: '', today: t.today, ids: [id], anyDate: true })[0];
  return { d, b: buildEwayBill(d, company, t.today) };
};

describe('e-way bill', () => {
  it('pending: goods consignments above ₹50,000 without an e-way bill', () => {
    const { t, w1, w2, w5 } = setup();
    const r = pendingEwayBills(t.db, loadCompany(t.db), '2026-04-01', '2026-04-30', t.today);
    assert.equal(r.thresholdPaise, 5000000);
    assert.deepEqual(r.rows.map((x) => [x.voucherId, x.number, x.consignmentValue, x.invoiceValue, x.ready]), [
      [w1, 'W-1', 7080000, 7198000, true],
      [w5, 'W-5', 7080000, 7080000, true],
    ]);
    assert.equal(consignmentValue(bill(t, w2).d), 5000000, 'exactly at the threshold → not required (Rule 138: exceeding)');
    assert.deepEqual(r.cancelRequired, []);
    t.db.run("UPDATE vouchers SET is_cancelled = 1, affects_books = 0, eway_bill_date = '2026-04-15' WHERE number = 'W-4'");
    const after = pendingEwayBills(t.db, loadCompany(t.db), '2026-04-01', '2026-04-30', t.today);
    assert.deepEqual(after.cancelRequired.map((x) => [x.number, x.refNo, x.refDate]), [['W-4', '391000000001', '2026-04-15']]);
    t.close();
  });

  it('builds the bill-to / ship-to bill with transport details', () => {
    const { t, w1 } = setup();
    const { b } = bill(t, w1);
    assert.deepEqual(b.errors, []);
    assert.deepEqual(b.bill, {
      userGstin: makeGstin('27'),
      supplyType: 'O',
      subSupplyType: 1,
      subSupplyDesc: '',
      docType: 'INV',
      docNo: 'W-1',
      docDate: '15/04/2026',
      fromGstin: makeGstin('27'),
      fromTrdName: 'Test Traders Pvt Ltd',
      fromAddr1: '12 MG Road',
      fromAddr2: '',
      fromPlace: 'Maharashtra',
      fromPincode: 400001,
      fromStateCode: 27,
      actFromStateCode: 27,
      toGstin: makeGstin('27', testPan(1)),
      toTrdName: 'Acme Industries',
      toAddr1: 'Warehouse 3, Chakan MIDC',
      toAddr2: '',
      toPlace: 'Pune',
      toPincode: 411001,
      toStateCode: 27,
      actToStateCode: 27,
      transactionType: 2,
      totalValue: 60000,
      cgstValue: 5400,
      sgstValue: 5400,
      igstValue: 0,
      cessValue: 0,
      cessNonAdvolValue: 0,
      otherValue: 1180, // installation 1,000 + 180 tax (services are not e-way bill items)
      totInvValue: 71980,
      transporterId: TRANSPORTER,
      transporterName: 'Speedy Logistics',
      transDocNo: 'LR-55',
      transMode: '1',
      transDistance: '25',
      transDocDate: '15/04/2026',
      vehicleNo: 'MH12AB1234',
      vehicleType: 'R',
      itemList: [
        { itemNo: 1, productName: 'HR Steel Coil', productDesc: 'HR Steel Coil', hsnCode: 72081000, quantity: 100, qtyUnit: 'KGS', taxableAmount: 60000, sgstRate: 9, cgstRate: 9, igstRate: 0, cessRate: 0, cessNonAdvol: 0 },
      ],
    });
    t.close();
  });

  it('a sales return moves goods inward: from the customer to us, CNT, sub-type 7', () => {
    const { t, w5 } = setup();
    const { b } = bill(t, w5);
    assert.deepEqual(b.errors, []);
    const x = b.bill;
    assert.deepEqual([x.supplyType, x.subSupplyType, x.docType, x.fromGstin, x.fromStateCode, x.toGstin, x.toStateCode, x.igstValue], ['I', 7, 'CNT', makeGstin('29', testPan(2)), 29, makeGstin('27'), 27, 10800]);
    assert.deepEqual((x.itemList as Array<Record<string, unknown>>)[0].igstRate, 18);
    t.close();
  });

  it('exports: to URP / 96, ship-to is the port; validation explains what is missing', () => {
    const { t, P } = setupParties({ today: '2026-04-20' });
    const exp = insertDoc(t, {
      type: 'sales',
      number: 'X-1',
      date: '2026-04-15',
      party: P.global,
      nature: 'export_lut',
      pos: '96',
      consignee: { name: 'JNPT', address: 'Nhava Sheva Port\nUran', stateCode: '27', pincode: '400707' },
      dispatch: { vehicleNo: 'MH46X9999', distanceKm: 60 },
      lines: [{ hsn: '8471', desc: 'Laptop', uqc: 'NOS', qty: 10, rate: 18, taxable: 6000000 }],
    });
    const e = bill(t, exp).b;
    assert.deepEqual(e.errors, []);
    assert.deepEqual([e.bill.subSupplyType, e.bill.toGstin, e.bill.toStateCode, e.bill.actToStateCode, e.bill.toPincode, e.bill.toPlace], [3, 'URP', 96, 27, 400707, 'Uran']);
    const broken = insertDoc(t, {
      type: 'sales',
      number: 'BAD NUMBER 1',
      date: '2026-04-15',
      party: P.global,
      nature: 'export_lut',
      pos: '96',
      dispatch: { transporterId: 'ABC', vehicleNo: 'XYZ' },
      lines: [{ hsn: '9983', desc: 'Consulting', kind: 'goods', rate: 18, taxable: 6000000 }],
    });
    const err = bill(t, broken).b;
    const text = err.errors.join('\n');
    for (const re of [/Document number "BAD NUMBER 1"/, /port \/ ICD/, /approximate distance/, /Transporter ID "ABC"/, /HSN 9983 is a service code/]) assert.match(text, re);
    assert.match(err.warnings.join(' '), /Vehicle number "XYZ"/);
    t.close();
  });

  it('bulk JSON and recording the generated e-way bill (audited, unique, 12 digits)', () => {
    const { t, w1, w2, w5 } = setup();
    const f = ewayJson(t.ctx, loadCompany(t.db), [w1, w5]);
    const j = JSON.parse(f.json) as { version: string; billLists: Array<Record<string, unknown>> };
    assert.equal(j.version, '1.0.0621');
    assert.deepEqual(j.billLists.map((b) => b.docNo), ['W-1', 'W-5']);
    assert.equal(f.documents, 2);
    assert.match(f.fileName, /^EWB_27AAPFU0939F1ZV_20260420_2\.json$/);

    assert.throws(() => updateEwayBill(t.ctx, { voucherId: w1, ewayBillNo: '1234', date: '2026-04-15' }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION' && /12 digits/.test(e.message));
    assert.throws(() => updateEwayBill(t.ctx, { voucherId: w1, ewayBillNo: '391000000001', date: '2026-04-15' }), (e: unknown) => e instanceof AppError && /already recorded on Sales W-4/.test(e.message));
    assert.throws(() => updateEwayBill(t.ctx, { voucherId: w1, ewayBillNo: '391000000777', date: '2026-04-14' }), (e: unknown) => e instanceof AppError && /before the voucher date/.test(e.message));
    const r = updateEwayBill(t.ctx, { voucherId: w1, ewayBillNo: '3910 0000 0777', date: '2026-04-15', validUpto: '2026-04-16' });
    assert.deepEqual([r.ewayBillNo, r.ewayBillDate, r.ewayValidUpto], ['391000000777', '2026-04-15', '2026-04-16']);
    const pending = pendingEwayBills(t.db, loadCompany(t.db), '2026-04-01', '2026-04-30', t.today);
    assert.deepEqual(pending.rows.map((x) => x.voucherId), [w5]);
    assert.equal(t.db.value("SELECT COUNT(*) FROM audit_log WHERE entity_type = 'voucher' AND action = 'alter'"), 1);
    assert.throws(() => ewayJson(t.ctx, loadCompany(t.db), [w1]), (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE');
    assert.equal(w2 > 0, true);
    t.close();
  });
});
