/**
 * POS services: setup (F11), settings, tender modes, scan lookup, customers, held bills, return
 * context, exchange credits, day-end summary / register and the print block.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestCompany } from '../../testing/fixtures.ts';
import { AppError } from '../../lib/errors.ts';
import { saveFeatures } from '../company/service.ts';
import { buildPrintDataFor } from '../print/data.ts';
import { savePriceLevel, savePriceList } from '../inventory/prices.ts';
import { cancelVoucher } from '../vouchers/service.ts';
import { discardHeldBill, holdBill, listHeldBills, recallHeldBill } from './held.ts';
import { createCustomer, findCustomers, lookupItem } from './lookup.ts';
import { posRegister, posSummary } from './reports.ts';
import { openExchangeCredits, returnContext, voucherPos } from './returns.ts';
import { posRoutes } from './routes.ts';
import { deleteTenderMode, getPosSettings, listTenderModes, posContext, savePosSettings, saveTenderMode } from './store.ts';
import { bill, line, posKit, saveBill, tender } from './testkit.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return `${e.code}: ${e.message}`;
    throw e;
  }
  return 'ok';
}

describe('setup (F11 › POS invoicing)', () => {
  it('turning POS on creates the POS Sales / POS Return types, Cash and exchange tenders, once', () => {
    const t = createTestCompany({ today: '2026-04-15' });
    assert.equal(t.db.value(`SELECT COUNT(*) FROM pos_tender_modes`), 0);
    saveFeatures(t.ctx, { pos: true });
    const types = t.db.all<{ name: string; base_type: string; numbering_prefix: string; config: string }>(`SELECT name, base_type, numbering_prefix, config FROM voucher_types WHERE name LIKE 'POS%' ORDER BY name`);
    assert.deepEqual(
      types.map((x) => [x.name, x.base_type, x.numbering_prefix]),
      [
        ['POS Return', 'credit_note', 'PR/'],
        ['POS Sales', 'sales', 'POS/'],
      ],
    );
    assert.equal(JSON.parse(types[1].config).posInvoice, true);
    assert.deepEqual(listTenderModes(t.db).map((m) => [m.name, m.kind]), [
      ['Cash', 'cash'],
      ['Exchange credit', 'exchange'],
    ]);
    assert.equal(t.db.value(`SELECT g.reserved_code FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.reserved_code = 'POS_EXCHANGE'`), 'CURRENT_LIABILITIES');
    // Off and on again: nothing duplicated.
    saveFeatures(t.ctx, { pos: false });
    saveFeatures(t.ctx, { pos: true });
    assert.equal(t.db.value(`SELECT COUNT(*) FROM voucher_types WHERE name LIKE 'POS%'`), 2);
    assert.equal(t.db.value(`SELECT COUNT(*) FROM pos_tender_modes`), 2);
    // Inventory off switches POS off (it bills stock items).
    assert.equal(saveFeatures(t.ctx, { inventory: false }).pos, false);
    // Audited.
    assert.ok((t.db.value<number>(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'voucher_type'`) ?? 0) >= 2);
  });

  it('posContext resolves the defaults and permissions', () => {
    const k = posKit();
    const c = posContext(k.t.ctx);
    assert.equal(c.enabled, true);
    assert.equal(c.saleVoucherTypeId, k.saleType);
    assert.equal(c.returnVoucherTypeId, k.returnType);
    assert.equal(c.walkIn?.id, k.L.cash);
    assert.deepEqual(c.tenderModes.map((m) => m.kind), ['cash', 'upi', 'card', 'exchange']);
    assert.equal(c.companyStateCode, '27');
    assert.equal(c.can.bill, true);
  });
});

describe('settings and tender modes', () => {
  it('settings are checked and audited', () => {
    const k = posKit();
    assert.match(code(() => savePosSettings(k.t.ctx, { walkInLedgerId: k.L.bank })), /VALIDATION: .*not a Cash-in-Hand ledger/);
    assert.match(code(() => savePosSettings(k.t.ctx, { saleVoucherTypeId: k.t.ids.voucherTypes.sales })), /VALIDATION: Choose a Sales voucher type used as POS invoice/);
    assert.match(code(() => savePosSettings(k.t.ctx, { returnVoucherTypeId: k.saleType })), /VALIDATION: Choose a Credit Note/);
    const s = savePosSettings(k.t.ctx, { printAfterSave: false, askCustomerFirst: true });
    assert.equal(s.printAfterSave, false);
    assert.equal(getPosSettings(k.t.db).askCustomerFirst, true);
    assert.equal(k.t.db.value(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'pos_settings'`), 1);
  });

  it('a tender posts to a suitable ledger; a used mode keeps its ledger and cannot be deleted', () => {
    const k = posKit();
    assert.match(code(() => saveTenderMode(k.t.ctx, { name: 'Wallet', kind: 'wallet', ledgerId: k.L.sales })), /VALIDATION: 'Sales' cannot receive POS payments/);
    assert.match(code(() => saveTenderMode(k.t.ctx, { name: 'Cash 2', kind: 'cash', ledgerId: k.L.bank })), /not a Cash-in-Hand ledger/);
    assert.match(code(() => saveTenderMode(k.t.ctx, { name: 'Udhar', kind: 'other', ledgerId: k.L.customer })), /cannot receive POS payments/);
    assert.match(code(() => saveTenderMode(k.t.ctx, { name: 'upi', kind: 'card', ledgerId: k.L.bank })), /already exists/);
    assert.match(code(() => saveTenderMode(k.t.ctx, { name: 'X', kind: 'exchange', ledgerId: k.L.bank })), /Exchange credit is a system mode/);
    saveBill(k, bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.card, 11_800)] }));
    assert.match(code(() => saveTenderMode(k.t.ctx, { id: k.M.card, name: 'Card', kind: 'card', ledgerId: k.L.bank })), /used on 1 bill/);
    assert.match(code(() => deleteTenderMode(k.t.ctx, k.M.card)), /BUSINESS_RULE: 'Card' is used on 1 bill/);
    assert.equal(saveTenderMode(k.t.ctx, { id: k.M.card, name: 'Card (old)', kind: 'card', ledgerId: k.L.cardClearing, isActive: false }).isActive, false);
    assert.match(code(() => deleteTenderMode(k.t.ctx, k.M.exchange)), /system mode/);
    assert.equal(deleteTenderMode(k.t.ctx, k.M.upi).id, k.M.upi);
  });
});

describe('scan lookup', () => {
  it('matches barcode, part number, alias and exact name, with MRP, price and stock', () => {
    const k = posKit();
    const date = k.t.today;
    const byBarcode = lookupItem(k.t.db, { code: ' 8901234567890 ', date }, date).item;
    assert.equal(byBarcode?.itemId, k.I.soap);
    assert.equal(byBarcode?.matchedBy, 'barcode');
    assert.equal(byBarcode?.mrp, 5_900);
    assert.equal(byBarcode?.sellingRate, 42.37);
    assert.equal(byBarcode?.stock, 100);
    assert.equal(lookupItem(k.t.db, { code: 'sp-01', date }, date).item?.matchedBy, 'part_no');
    assert.equal(lookupItem(k.t.db, { code: 'CHAWAL', date }, date).item?.itemId, k.I.rice);
    assert.equal(lookupItem(k.t.db, { code: 'ball pen', date }, date).item?.matchedBy, 'name');
    assert.deepEqual(lookupItem(k.t.db, { code: 'nothing-like-this', date }, date), { item: null, candidates: [] });
  });

  it('several items on one code are offered to choose; inactive items are skipped', () => {
    const k = posKit();
    const a = k.t.addStockItem({ name: 'Pen Blue', partNo: 'PN' });
    const b = k.t.addStockItem({ name: 'Pen Red', partNo: 'PN' });
    const res = lookupItem(k.t.db, { code: 'PN', date: k.t.today }, k.t.today);
    assert.equal(res.item, null);
    assert.deepEqual(res.candidates.map((c) => c.itemId).sort(), [a, b].sort());
    k.t.db.run('UPDATE stock_items SET is_active = 0 WHERE id = :id', { id: b });
    assert.equal(lookupItem(k.t.db, { code: 'PN', date: k.t.today }, k.t.today).item?.itemId, a);
  });

  it('price-level slabs come with the item when the counter has a price level', () => {
    const k = posKit({ features: { priceLevels: true } });
    const level = savePriceLevel(k.t.ctx, { name: 'Retail' });
    savePriceList(k.t.ctx, {
      priceLevelId: level.id,
      applicableFrom: '2026-04-01',
      rows: [
        { itemId: k.I.soap, qtyFrom: 0, qtyTo: 6, rate: 45 },
        { itemId: k.I.soap, qtyFrom: 6, qtyTo: null, rate: 40 },
      ],
    });
    const item = lookupItem(k.t.db, { code: '8901234567890', date: k.t.today, priceLevelId: level.id }, k.t.today).item;
    assert.deepEqual(item?.slabs.map((s) => [s.qtyFrom, s.qtyTo, s.rate]), [
      [0, 6, 45],
      [6, null, 40],
    ]);
  });
});

describe('customers by mobile', () => {
  it('finds by any way of writing the number; creates name + mobile + state; refuses a duplicate mobile', () => {
    const k = posKit();
    assert.deepEqual(findCustomers(k.t.db, '+91 98765-43210').map((c) => c.ledgerId), [k.L.customer]);
    assert.deepEqual(findCustomers(k.t.db, '12345'), []);
    const c = createCustomer(k.t.ctx, { name: '  Sita  Devi ', mobile: '09123456789', stateCode: '29' });
    assert.equal(c.name, 'Sita Devi');
    assert.equal(c.mobile, '9123456789');
    assert.equal(c.stateCode, '29');
    assert.equal(c.groupName, 'Sundry Debtors');
    assert.equal(k.t.db.value('SELECT gst_registration_type FROM ledgers WHERE id = :id', { id: c.ledgerId }), 'consumer');
    assert.match(code(() => createCustomer(k.t.ctx, { name: 'Other', mobile: '9123456789' })), /CONFLICT: Sita Devi already has mobile/);
    // Same name, other mobile → the mobile tells them apart.
    assert.equal(createCustomer(k.t.ctx, { name: 'Sita Devi', mobile: '9000000001' }).name, 'Sita Devi (9000000001)');
    assert.match(code(() => createCustomer(k.t.ctx, { name: 'X', mobile: '12345' })), /VALIDATION: Mobile number must be 10 digits/);
    assert.ok((k.t.db.value<number>(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'ledger' AND action = 'create'`) ?? 0) >= 2);
  });
});

describe('held bills', () => {
  it('hold, list, recall (removed), discard — audited; references checked', () => {
    const k = posKit();
    const draft = { voucherTypeId: k.saleType, lines: [{ itemId: k.I.soap, qty: 2, rate: 42.37 }], customerName: 'Ramesh' };
    const h = holdBill(k.t.ctx, { total: 10_000, draft });
    assert.equal(h.label, 'Ramesh · 1 item');
    const h2 = holdBill(k.t.ctx, { total: 500, label: 'Blue shirt lady', draft: { ...draft, customerName: undefined } });
    assert.deepEqual(listHeldBills(k.t.db).map((x) => x.id), [h.id, h2.id]);
    const back = recallHeldBill(k.t.ctx, h.id);
    assert.deepEqual(back.draft.lines, draft.lines);
    assert.deepEqual(listHeldBills(k.t.db).map((x) => x.id), [h2.id]);
    discardHeldBill(k.t.ctx, h2.id);
    assert.equal(listHeldBills(k.t.db).length, 0);
    assert.match(code(() => holdBill(k.t.ctx, { total: 0, draft: { ...draft, lines: [] } })), /nothing to hold/);
    assert.match(code(() => holdBill(k.t.ctx, { total: 0, draft: { ...draft, voucherTypeId: k.t.ids.voucherTypes.sales } })), /POS voucher type/);
    assert.match(code(() => holdBill(k.t.ctx, { total: 0, draft: { ...draft, lines: [{ itemId: 9_999, qty: 1, rate: 1 }] } })), /no longer exists/);
    assert.equal(k.t.db.value(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'pos_held_bill'`), 4);
  });
});

describe('return context and exchange credits', () => {
  it('lists the bill lines with what is still returnable; finds the bill by number', () => {
    const k = posKit();
    const b = saveBill(k, bill(k, [line(k.I.soap, 3, 100), line(k.I.rice, 2, 50)], { tenders: [tender(k.M.cash, 45_900)] }));
    // soap 3 × 118 = 354.00; rice 105.00 → 459.00
    saveBill(k, {
      voucherTypeId: k.returnType,
      date: k.t.today,
      mode: 'item_invoice',
      partyLedgerId: k.L.cash,
      items: [line(k.I.soap, 1, 100)],
      posBill: { tenders: [tender(k.M.exchange, 11_800)], returnOfId: b.id },
    });
    const c = returnContext(k.t.db, k.t.today, { number: b.number ?? '', date: k.t.today });
    assert.equal(c.billId, b.id);
    assert.equal(c.walkIn, true);
    assert.equal(c.returnVoucherTypeId, k.returnType);
    assert.deepEqual(c.lines.map((l) => [l.name, l.sold, l.returned, l.returnable]), [
      ['Bath Soap 100g', 3, 1, 2],
      ['Sona Masoori Rice', 2, 0, 2],
    ]);
    assert.deepEqual(c.tenders.map((t) => [t.name, t.amount]), [['Cash', 45_900]]);
    const open = openExchangeCredits(k.t.db, k.t.today);
    assert.deepEqual(open.map((o) => [o.issued, o.used, o.available]), [[11_800, 0, 11_800]]);
    assert.match(code(() => returnContext(k.t.db, k.t.today, { number: 'NOPE', date: k.t.today })), /No POS bill numbered NOPE/);
  });
});

describe('day-end summary and register', () => {
  it('adds up bills, returns, tenders, users, counters, change, credit and exchange', () => {
    const k = posKit();
    // Bill 1: walk-in 22,300 — UPI 10,000 + cash 12,300 (tendered 15,000 → change 2,700), counter A.
    saveBill(k, bill(k, [line(k.I.soap, 1, 100), line(k.I.rice, 2, 50)], { tenders: [tender(k.M.upi, 10_000), tender(k.M.cash, 12_300)], cashTendered: 15_000, counter: 'A' }));
    // Bill 2: customer 23,600 — card 10,000, 13,600 on account, counter B.
    const b2 = saveBill(k, bill(k, [line(k.I.soap, 2, 100)], { tenders: [tender(k.M.card, 10_000)], counter: 'B' }, { partyLedgerId: k.L.customer }));
    // Return of 1 soap from bill 2 (11,800) credited to the customer's account.
    saveBill(k, { voucherTypeId: k.returnType, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.customer, items: [line(k.I.soap, 1, 100)], posBill: { tenders: [], returnOfId: b2.id, counter: 'B' } });
    // Bill 3: walk-in, cancelled — never counts.
    const b3 = saveBill(k, bill(k, [line(k.I.pen, 1, 10)], { tenders: [tender(k.M.cash, 1_200)] }));
    cancelVoucher(k.t.ctx, b3.id, 'mistake');

    const s = posSummary(k.t.db, k.t.today, { from: k.t.today, to: k.t.today });
    assert.equal(s.bills, 2);
    assert.equal(s.sales, 45_900); // 22,300 + 23,600
    assert.equal(s.taxable, 40_000); // 20,000 + 20,000
    assert.equal(s.tax, 5_900); // 2,300 + 3,600
    assert.equal(s.returns, 1);
    assert.equal(s.returnValue, 11_800);
    assert.equal(s.net, 34_100);
    assert.equal(s.creditSales, 13_600);
    assert.equal(s.creditReturns, 11_800);
    assert.equal(s.netCash, 12_300);
    assert.equal(s.changeGiven, 2_700);
    assert.deepEqual(Object.fromEntries(s.byTender.map((t) => [t.name, [t.received, t.refunded, t.net]])), {
      UPI: [10_000, 0, 10_000],
      Cash: [12_300, 0, 12_300],
      Card: [10_000, 0, 10_000],
    });
    assert.deepEqual(s.byCounter.map((c) => [c.counter, c.bills, c.sales, c.returnValue]), [
      ['A', 1, 22_300, 0],
      ['B', 1, 23_600, 11_800],
    ]);
    assert.equal(s.byUser.length, 1);
    assert.equal(s.byUser[0].net, 34_100);
    // MRP saving: soap MRP ₹59 × 3 sold = 17,700 vs charged 3 × 11,800 = 35,400 → no saving (price above MRP).
    assert.equal(s.mrpSavings, 0);

    const reg = posRegister(k.t.db, k.t.today, { from: k.t.today, to: k.t.today });
    assert.equal(reg.total, 3);
    assert.deepEqual(reg.rows.map((r) => [r.kind, r.billValue, r.counter]), [
      ['sale', 22_300, 'A'],
      ['sale', 23_600, 'B'],
      ['return', 11_800, 'B'],
    ]);
    assert.match(reg.rows[0].tenders, /^UPI 100\.00 · Cash 123\.00$/);
    assert.equal(reg.rows[2].returnOf?.id, b2.id);
    assert.deepEqual(reg.sums, { billValue: 34_100, paid: 20_000 + 12_300, credit: 13_600 - 11_800 });
    assert.equal(posRegister(k.t.db, k.t.today, { from: k.t.today, to: k.t.today, kind: 'return' }).total, 1);
    assert.equal(posRegister(k.t.db, k.t.today, { from: k.t.today, to: k.t.today, counter: 'A' }).total, 1);
    assert.equal(posSummary(k.t.db, k.t.today, { from: k.t.today, to: k.t.today, voucherTypeIds: [k.saleType] }).returns, 1);
    // Drill-down filters (review): a tender row opens the bills paid by that mode; a cashier row the
    // bills of that user — null = entered without a login (this company has no security).
    assert.deepEqual(posRegister(k.t.db, k.t.today, { from: k.t.today, to: k.t.today, modeId: k.M.card }).rows.map((r) => r.billValue), [23_600]);
    assert.equal(posRegister(k.t.db, k.t.today, { from: k.t.today, to: k.t.today, modeId: k.M.upi }).total, 1);
    assert.equal(posRegister(k.t.db, k.t.today, { from: k.t.today, to: k.t.today, userId: null }).total, 3);
    assert.equal(posRegister(k.t.db, k.t.today, { from: k.t.today, to: k.t.today, userId: 999 }).total, 0);
  });

  it('MRP saving counts what the customer saved against MRP', () => {
    const k = posKit();
    // 2 soaps at ₹42.37 = 8,474 taxable; CGST = SGST = 9 % of 8,474 = 762.66 → 763 each → 10,000 charged;
    // MRP 2 × 5,900 = 11,800 → saved 1,800.
    saveBill(k, bill(k, [line(k.I.soap, 2, 42.37)], { tenders: [tender(k.M.cash, 10_000)] }));
    assert.equal(posSummary(k.t.db, k.t.today, { from: k.t.today, to: k.t.today }).mrpSavings, 1_800);
  });
});

describe('print block', () => {
  it('a POS bill prints its tenders, cash tendered and change; a paid bill shows no "Scan to pay" QR', () => {
    const k = posKit();
    k.t.db.run(`UPDATE settings SET value = json_set(value, '$.invoice.showUpiQr', json('true'), '$.invoice.upiId', 'shop@okhdfc') WHERE key = 'config'`);
    const paid = saveBill(k, bill(k, [line(k.I.soap, 2, 42.37)], { tenders: [tender(k.M.upi, 5_000, { reference: '889' }), tender(k.M.cash, 5_000)], cashTendered: 5_000 }));
    const d = buildPrintDataFor(k.t.ctx, paid.id);
    assert.deepEqual(d.pos?.tenders, [
      { label: 'UPI (Ref 889)', amount: 5_000 },
      { label: 'Cash', amount: 5_000 },
    ]);
    assert.equal(d.pos?.change, 0);
    assert.equal(d.upi, null);
    assert.equal(d.defaultTemplate, 'compact');
    assert.equal(d.mrpSummary?.savings, 1_800); // same figures as the summary test
    // Part on credit: the QR asks for the balance only.
    const credit = saveBill(k, bill(k, [line(k.I.soap, 2, 42.37)], { tenders: [tender(k.M.cash, 4_000)] }, { partyLedgerId: k.L.customer }));
    const d2 = buildPrintDataFor(k.t.ctx, credit.id);
    assert.equal(d2.pos?.credit, 6_000);
    assert.equal(d2.upi?.amount, 6_000);
    assert.match(d2.upi?.uri ?? '', /am=60\.00/);
  });
});

describe('routes', () => {
  it('permissions: settings need company.manage; a Data Entry user may bill, hold and look up', async () => {
    const k = posKit();
    const dataEntry = k.t.sessionAs({ role: 'Data Entry' });
    const denied = await k.t.call(posRoutes, 'pos.settings.save', { printAfterSave: false }, { session: dataEntry });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN');
    const look = await k.t.call(posRoutes, 'pos.item.lookup', { code: 'SP-01', date: k.t.today }, { session: dataEntry });
    assert.equal(look.ok, true);
    const held = await k.t.call(posRoutes, 'pos.held.save', { total: 100, draft: { voucherTypeId: k.saleType, lines: [{ itemId: k.I.pen, qty: 1, rate: 10 }] } }, { session: dataEntry });
    assert.equal(held.ok, true);
    const auditor = k.t.sessionAs({ role: 'Auditor' });
    const hold2 = await k.t.call(posRoutes, 'pos.held.save', { total: 100, draft: { voucherTypeId: k.saleType, lines: [{ itemId: k.I.pen, qty: 1, rate: 10 }] } }, { session: auditor });
    assert.equal(hold2.ok, false);
    const sum = await k.t.call(posRoutes, 'pos.summary', { from: k.t.today, to: k.t.today }, { session: auditor });
    assert.equal(sum.ok, true);
  });

  it('pos.item.get and pos.voucher', async () => {
    const k = posKit();
    const item = await k.t.callOk<{ itemId: number; mrp: number | null }>(posRoutes, 'pos.item.get', { itemId: k.I.soap, date: k.t.today });
    assert.deepEqual([item.itemId, item.mrp], [k.I.soap, 5_900]);
    const r = saveBill(k, bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.upi, 11_800, { reference: 'R1' })], counter: 'Till 2' }));
    const v = voucherPos(k.t.db, r.id);
    assert.equal(v?.kind, 'sale');
    assert.equal(v?.counter, 'Till 2');
    assert.deepEqual(v?.tenders.map((t) => [t.name, t.amount, t.reference]), [['UPI', 11_800, 'R1']]);
    assert.equal(await k.t.callOk(posRoutes, 'pos.voucher', { id: 999_999 }), null);
    // Feature off: routes refuse, the context says so.
    saveFeatures(k.t.ctx, { pos: false });
    const off = await k.t.call(posRoutes, 'pos.item.lookup', { code: 'SP-01', date: k.t.today });
    assert.equal(off.ok, false);
    assert.equal((await k.t.callOk<{ enabled: boolean }>(posRoutes, 'pos.context', {})).enabled, false);
  });
});
