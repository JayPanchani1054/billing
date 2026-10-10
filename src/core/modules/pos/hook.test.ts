/**
 * POS posting through the vouchers hook: split tender, change, credit to a customer, returns with
 * refund / exchange credit, and the rules that keep the books right.
 *
 * Figures (Maharashtra company, intra-state → CGST + SGST):
 *   soap 1 × ₹100.00 @ 18 % → taxable 10,000 p, CGST 900, SGST 900 → 11,800 p
 *   rice 2 Kg × ₹50.00 @ 5 % → taxable 10,000 p, CGST 250, SGST 250 → 10,500 p
 *   bill = 11,800 + 10,500 = 22,300 p (₹223.00, no round-off)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pendingBills } from '../vouchers/bills.ts';
import { cancelVoucher, deleteVoucher, duplicateVoucher, previewVoucher, saveVoucher } from '../vouchers/service.ts';
import { saveFeatures } from '../company/service.ts';
import { AppError } from '../../lib/errors.ts';
import { bill, entries, entrySum, line, posKit, saveBill, tender, trialSum, type PosKit } from './testkit.ts';

function rejects(fn: () => unknown, code: string, re: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof AppError, String(e));
    assert.equal(e.code, code, e.message);
    const details = e.details as { warnings?: Array<{ message: string }> } | Array<{ message: string }> | undefined;
    const texts = [e.message, ...(Array.isArray(details) ? details.map((d) => d.message) : (details?.warnings ?? []).map((w) => w.message))].join(' | ');
    assert.match(texts, re);
    return true;
  });
}

const basket = (k: PosKit) => [line(k.I.soap, 1, 100), line(k.I.rice, 2, 50)];

describe('POS bill: split tender in one voucher', () => {
  it('walk-in bill paid by UPI + cash: Dr each tender ledger, Cr sales / GST, cash change worked out', () => {
    const k = posKit();
    const r = saveBill(k, bill(k, basket(k), { tenders: [tender(k.M.upi, 10_000, { reference: 'UPI4521' }), tender(k.M.cash, 12_300)], cashTendered: 15_000 }));
    const e = entries(k, r.id);
    // 22,300 = UPI 10,000 + cash 12,300; Sales 20,000; CGST 900 + 250; SGST 900 + 250.
    assert.deepEqual(e, { Sales: -20_000, 'Output CGST': -1_150, 'Output SGST/UTGST': -1_150, 'HDFC Current A/c': 10_000, Cash: 12_300 });
    assert.equal(entrySum(k, r.id), 0);
    assert.equal(r.totals.grandTotal, 22_300);
    const pb = k.t.db.get<Record<string, number | string | null>>('SELECT * FROM pos_bills WHERE voucher_id = :id', { id: r.id });
    assert.equal(pb?.kind, 'sale');
    assert.equal(pb?.bill_value, 22_300);
    assert.equal(pb?.paid, 22_300);
    assert.equal(pb?.credit, 0);
    assert.equal(pb?.cash_tendered, 15_000);
    assert.equal(pb?.change_due, 2_700); // 15,000 tendered − 12,300 cash on the bill
    const upi = k.t.db.get<{ instrument_type: string | null; instrument_no: string | null; role: string }>(
      'SELECT instrument_type, instrument_no, role FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :l',
      { id: r.id, l: k.L.bank },
    );
    assert.deepEqual(upi, { instrument_type: 'upi', instrument_no: 'UPI4521', role: 'cash_bank' });
    // Stock went out: soap 100 − 1, rice 200 − 2.
    const qty = (item: number) => k.t.db.value<number>('SELECT SUM(qty) FROM inventory_entries WHERE item_id = :i', { i: item });
    assert.equal(qty(k.I.soap), -1);
    assert.equal(qty(k.I.rice), -2);
    // GST lines as for any B2C sale; place of supply the company's state.
    const v = k.t.db.get<{ gst_nature: string; place_of_supply: string; party_ledger_id: number }>('SELECT gst_nature, place_of_supply, party_ledger_id FROM vouchers WHERE id = :id', { id: r.id });
    assert.deepEqual(v, { gst_nature: 'b2cs', place_of_supply: '27', party_ledger_id: k.L.cash });
    assert.equal(trialSum(k), 0);
  });

  it('card to a clearing ledger (current asset) posts role other, no bank instrument', () => {
    const k = posKit();
    const r = saveBill(k, bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.card, 11_800, { reference: '1234' })] }));
    assert.deepEqual(entries(k, r.id), { Sales: -10_000, 'Output CGST': -900, 'Output SGST/UTGST': -900, 'Card Settlements Receivable': 11_800 });
    const row = k.t.db.get<{ role: string; instrument_type: string | null }>('SELECT role, instrument_type FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :l', { id: r.id, l: k.L.cardClearing });
    assert.deepEqual(row, { role: 'other', instrument_type: null });
  });

  it('customer pays part, the rest stays on account with a bill-wise reference named after the bill', () => {
    const k = posKit();
    const r = saveBill(k, bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.upi, 5_000)] }, { partyLedgerId: k.L.customer }));
    // 11,800 − 5,000 UPI = 6,800 on the customer's account.
    assert.deepEqual(entries(k, r.id), { 'Ramesh Kumar': 6_800, Sales: -10_000, 'Output CGST': -900, 'Output SGST/UTGST': -900, 'HDFC Current A/c': 5_000 });
    const pending = pendingBills(k.t.db, k.L.customer, k.t.today, k.t.today);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].billName, r.number);
    assert.equal(Math.abs(pending[0].amount), 6_800);
    assert.equal(k.t.db.value('SELECT credit FROM pos_bills WHERE voucher_id = :id', { id: r.id }), 6_800);
  });

  it('a fully paid customer bill leaves nothing on the account (no party entry, no pending bill)', () => {
    const k = posKit();
    const r = saveBill(k, bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.cash, 11_800)] }, { partyLedgerId: k.L.customer }));
    assert.deepEqual(entries(k, r.id), { Sales: -10_000, 'Output CGST': -900, 'Output SGST/UTGST': -900, Cash: 11_800 });
    assert.equal(pendingBills(k.t.db, k.L.customer, k.t.today, k.t.today).length, 0);
    // The buyer stays on the invoice (header snapshot) for the print and the registers.
    assert.equal(k.t.db.value('SELECT party_name FROM vouchers WHERE id = :id', { id: r.id }), 'Ramesh Kumar');
  });

  it('preview shows the tenders, credit and change without writing', () => {
    const k = posKit();
    const p = previewVoucher(k.t.ctx, bill(k, basket(k), { tenders: [tender(k.M.cash, 22_300)], cashTendered: 50_000 }));
    assert.equal(p.posBill?.paid, 22_300);
    assert.equal(p.posBill?.change, 27_700);
    assert.equal(p.posBill?.credit, 0);
    assert.equal(p.warnings.filter((w) => w.blocking).length, 0);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM pos_bills'), 0);
  });
});

describe('POS bill: rules', () => {
  it('a walk-in bill must be paid in full', () => {
    const k = posKit();
    rejects(() => saveBill(k, bill(k, basket(k), { tenders: [tender(k.M.cash, 20_000)] })), 'BUSINESS_RULE', /₹ 23\.00 of the bill is not paid/);
  });

  it('tenders may not exceed the bill (change comes from cash tendered)', () => {
    const k = posKit();
    rejects(() => saveBill(k, bill(k, basket(k), { tenders: [tender(k.M.cash, 25_000)] })), 'BUSINESS_RULE', /more than the bill .* by ₹ 27\.00/);
  });

  it('cash tendered must cover the cash on the bill, and needs a cash tender', () => {
    const k = posKit();
    rejects(() => saveBill(k, bill(k, basket(k), { tenders: [tender(k.M.cash, 22_300)], cashTendered: 20_000 })), 'BUSINESS_RULE', /Cash tendered .* is less than/);
    rejects(() => saveBill(k, bill(k, basket(k), { tenders: [tender(k.M.upi, 22_300)], cashTendered: 30_000 })), 'BUSINESS_RULE', /no cash tender/);
  });

  it('statutory reminders: an unnamed walk-in bill of ₹50,000+ (Rule 46(e)) and ₹2 lakh+ in cash (s.269ST)', () => {
    const k = posKit();
    // 500 soaps × ₹100 = ₹50,000 taxable → Rule 46(e) reminder; paid by UPI (no cash warning).
    const big = bill(k, [line(k.I.soap, 500, 100)], { tenders: [tender(k.M.upi, 5_900_000)] });
    k.t.db.run('UPDATE stock_openings SET qty = 5000 WHERE item_id = :i', { i: k.I.soap });
    rejects(() => saveVoucher(k.t.ctx, big), 'BUSINESS_RULE', /CGST Rule 46\(e\)/);
    // Named on the bill: no reminder.
    assert.equal(saveBill(k, { ...big, party: { name: 'Mohan Lal', address: 'Shop 4, Main Road, Pune', stateCode: '27' } }).totals.grandTotal, 5_900_000);
    // ₹2,36,000 in cash on one bill (2,000 × ₹100 + 18 %) → s.269ST reminder.
    const cash = bill(k, [line(k.I.soap, 2_000, 100)], { tenders: [tender(k.M.cash, 23_600_000)] }, { partyLedgerId: k.L.customer });
    rejects(() => saveVoucher(k.t.ctx, cash), 'BUSINESS_RULE', /s\.269ST/);
    // Review: an unregistered customer with no address on record needs the address of delivery too.
    rejects(() => saveVoucher(k.t.ctx, cash), 'BUSINESS_RULE', /Ramesh Kumar has no address/);
    assert.ok(saveBill(k, cash).id > 0); // confirmed
    k.t.db.run(`UPDATE ledgers SET address = 'Flat 2, MG Road, Pune' WHERE id = :id`, { id: k.L.customer });
    const p = previewVoucher(k.t.ctx, bill(k, [line(k.I.soap, 500, 100)], { tenders: [tender(k.M.upi, 5_900_000)] }, { partyLedgerId: k.L.customer }));
    assert.equal(p.warnings.some((w) => /Rule 46\(e\)/.test(w.message)), false);
  });

  it('only POS voucher types take tenders on a sale', () => {
    const k = posKit();
    rejects(() => saveBill(k, bill(k, basket(k), { tenders: [tender(k.M.cash, 22_300)] }, { voucherTypeId: k.t.ids.voucherTypes.sales })), 'BUSINESS_RULE', /not a POS voucher type/);
  });

  it('an inactive or unknown tender mode is refused', () => {
    const k = posKit();
    k.t.db.run('UPDATE pos_tender_modes SET is_active = 0 WHERE id = :id', { id: k.M.card });
    rejects(() => saveBill(k, bill(k, basket(k), { tenders: [tender(k.M.card, 22_300)] })), 'BUSINESS_RULE', /inactive/);
    rejects(() => saveBill(k, bill(k, basket(k), { tenders: [tender(9_999, 22_300)] })), 'BUSINESS_RULE', /no longer exists/);
  });

  it('POS invoicing off: a posBill is a field error', () => {
    const k = posKit();
    saveFeatures(k.t.ctx, { pos: false });
    rejects(() => saveBill(k, bill(k, basket(k), { tenders: [tender(k.M.cash, 22_300)] })), 'VALIDATION', /POS invoicing is turned off/);
  });

  it('a saved POS bill keeps its tenders when altered elsewhere (re-checked); on the counter it alters normally', () => {
    const k = posKit();
    const r = saveBill(k, bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.upi, 11_800, { reference: 'U1' })], counter: 'Till 2' }));
    const { posBill: _drop, ...plain } = bill(k, [line(k.I.soap, 1, 100)], { tenders: [] });
    // Regression: an alteration without the POS block used to be refused (paid bill) or to drop the
    // bill's POS rows (credit bill) — and the counter's own alteration preview (sent without the block)
    // threw, so an altered bill never showed its total. Now the stored tenders come back, checked again.
    const pv = previewVoucher(k.t.ctx, { ...plain, id: r.id });
    assert.equal(pv.totals.grandTotal, 11_800);
    assert.equal(pv.posBill?.paid, 11_800);
    saveVoucher(k.t.ctx, { ...plain, id: r.id, narration: 'typo fixed', acknowledgeWarnings: true });
    assert.deepEqual(entries(k, r.id), { Sales: -10_000, 'Output CGST': -900, 'Output SGST/UTGST': -900, 'HDFC Current A/c': 11_800 });
    assert.deepEqual(k.t.db.get('SELECT paid, counter FROM pos_bills WHERE voucher_id = :id', { id: r.id }), { paid: 11_800, counter: 'Till 2' });
    assert.equal(k.t.db.value('SELECT reference FROM pos_payments WHERE voucher_id = :id', { id: r.id }), 'U1');
    // Changing the goods there leaves the walk-in bill part unpaid: refused with the counter's message.
    rejects(() => saveVoucher(k.t.ctx, { ...plain, items: [line(k.I.soap, 2, 100)], id: r.id, acknowledgeWarnings: true }), 'BUSINESS_RULE', /not paid/);
    // Altered with its tenders (2 soaps now, half UPI half cash): rows rebuilt.
    const r2 = saveBill(k, { ...bill(k, [line(k.I.soap, 2, 100)], { tenders: [tender(k.M.upi, 11_800), tender(k.M.cash, 11_800)] }), id: r.id });
    assert.equal(r2.id, r.id);
    assert.deepEqual(entries(k, r.id), { Sales: -20_000, 'Output CGST': -1_800, 'Output SGST/UTGST': -1_800, 'HDFC Current A/c': 11_800, Cash: 11_800 });
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM pos_payments WHERE voucher_id = :id', { id: r.id }), 2);
  });

  it('duplicating a POS bill gives a bill without tenders', () => {
    const k = posKit();
    const r = saveBill(k, bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.cash, 11_800)] }));
    assert.equal(duplicateVoucher(k.t.ctx, r.id).posBill, undefined);
  });

  it('an optional POS bill keeps its rows out of the books', () => {
    const k = posKit();
    const r = saveBill(k, bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.cash, 11_800)] }, { isOptional: true }));
    assert.equal(k.t.db.value('SELECT affects_books FROM pos_bills WHERE voucher_id = :id', { id: r.id }), 0);
    assert.equal(k.t.db.value('SELECT affects_books FROM pos_payments WHERE voucher_id = :id', { id: r.id }), 0);
  });
});

describe('POS returns and exchange', () => {
  /** A walk-in bill of 2 soaps (23,600 p) paid in cash. */
  function sold(k: PosKit) {
    return saveBill(k, bill(k, [line(k.I.soap, 2, 100)], { tenders: [tender(k.M.cash, 23_600)] }));
  }
  const ret = (k: PosKit, billId: number, qty: number, tenders: ReturnType<typeof tender>[], extra = {}) => ({
    voucherTypeId: k.returnType,
    date: k.t.today,
    mode: 'item_invoice' as const,
    partyLedgerId: k.L.cash,
    originalInvoiceNo: k.t.db.value<string>('SELECT number FROM vouchers WHERE id = :id', { id: billId }) ?? undefined,
    originalInvoiceDate: k.t.today,
    noteReason: 'Sales return',
    items: [line(k.I.soap, qty, 100)],
    posBill: { tenders, returnOfId: billId },
    ...extra,
  });

  it('a cash refund: Dr sales / output GST, Cr cash; the goods come back', () => {
    const k = posKit();
    const b = sold(k);
    const r = saveBill(k, ret(k, b.id, 1, [tender(k.M.cash, 11_800)]));
    assert.deepEqual(entries(k, r.id), { Sales: 10_000, 'Output CGST': 900, 'Output SGST/UTGST': 900, Cash: -11_800 });
    assert.equal(k.t.db.value('SELECT return_of_id FROM pos_bills WHERE voucher_id = :id', { id: r.id }), b.id);
    assert.equal(k.t.db.value('SELECT SUM(qty) FROM inventory_entries WHERE item_id = :i', { i: k.I.soap }), -1); // −2 sold, +1 back
    assert.equal(trialSum(k), 0);
  });

  it('no more than was sold can come back, across returns', () => {
    const k = posKit();
    const b = sold(k);
    saveBill(k, ret(k, b.id, 1, [tender(k.M.cash, 11_800)]));
    rejects(() => saveBill(k, ret(k, b.id, 2, [tender(k.M.cash, 23_600)])), 'BUSINESS_RULE', /Only 1 of 'Bath Soap 100g' can still be returned/);
    rejects(() => saveBill(k, { ...ret(k, b.id, 1, [tender(k.M.cash, 5_250)]), items: [line(k.I.rice, 1, 50)] }), 'BUSINESS_RULE', /'Sona Masoori Rice' is not on/);
  });

  it('a walk-in return must be refunded in full', () => {
    const k = posKit();
    const b = sold(k);
    rejects(() => saveBill(k, ret(k, b.id, 1, [tender(k.M.cash, 10_000)])), 'BUSINESS_RULE', /not refunded/);
  });

  it('exchange: the return issues exchange credit, a later bill uses it; the clearing ledger nets to zero', () => {
    const k = posKit();
    const b = sold(k);
    const r = saveBill(k, ret(k, b.id, 1, [tender(k.M.exchange, 11_800)]));
    assert.deepEqual(entries(k, r.id), { Sales: 10_000, 'Output CGST': 900, 'Output SGST/UTGST': 900, 'POS Exchange Credit': -11_800 });
    // New bill: rice 4 Kg × ₹50 @ 5 % = 20,000 + 500 + 500 = 21,000; exchange 11,800 + cash 9,200.
    const tooMuch = () => saveBill(k, bill(k, [line(k.I.rice, 4, 50)], { tenders: [tender(k.M.exchange, 12_000, { exchangeVoucherId: r.id }), tender(k.M.cash, 9_000)] }));
    rejects(tooMuch, 'BUSINESS_RULE', /has ₹ 118\.00 of exchange credit left/);
    const n = saveBill(k, bill(k, [line(k.I.rice, 4, 50)], { tenders: [tender(k.M.exchange, 11_800, { exchangeVoucherId: r.id }), tender(k.M.cash, 9_200)] }));
    assert.deepEqual(entries(k, n.id), { Sales: -20_000, 'Output CGST': -500, 'Output SGST/UTGST': -500, 'POS Exchange Credit': 11_800, Cash: 9_200 });
    assert.equal(k.t.db.value('SELECT SUM(amount) FROM ledger_entries WHERE ledger_id = :l AND affects_books = 1', { l: k.L.exchange }), 0);
    // Used up: another bill cannot take it again.
    rejects(
      () => saveBill(k, bill(k, [line(k.I.pen, 1, 10)], { tenders: [tender(k.M.exchange, 1_180, { exchangeVoucherId: r.id })] })),
      'BUSINESS_RULE',
      /has ₹ 0\.00 of exchange credit left/,
    );
    // The return cannot go while its credit is used; the bill with returns cannot go either.
    rejects(() => deleteVoucher(k.t.ctx, r.id), 'BUSINESS_RULE', /exchange credit of this return was used/);
    rejects(() => cancelVoucher(k.t.ctx, b.id, 'test'), 'BUSINESS_RULE', /were returned on/);
    // Cancel the exchange bill → the return may be cancelled → then the original bill.
    cancelVoucher(k.t.ctx, n.id, 'customer changed mind');
    cancelVoucher(k.t.ctx, r.id, 'undo return');
    cancelVoucher(k.t.ctx, b.id, 'undo bill');
    assert.equal(trialSum(k), 0);
  });

  it('a return to a customer may be credited to the account (against the bill)', () => {
    const k = posKit();
    const b = saveBill(k, bill(k, [line(k.I.soap, 2, 100)], { tenders: [tender(k.M.cash, 10_000)] }, { partyLedgerId: k.L.customer }));
    // 23,600 − 10,000 cash = 13,600 on account (bill named after the POS number).
    const r = saveBill(k, { ...ret(k, b.id, 1, []), partyLedgerId: k.L.customer });
    // Credit note 11,800 entirely credited to the customer, set against the pending bill.
    assert.deepEqual(entries(k, r.id), { 'Ramesh Kumar': -11_800, Sales: 10_000, 'Output CGST': 900, 'Output SGST/UTGST': 900 });
    const pending = pendingBills(k.t.db, k.L.customer, k.t.today, k.t.today);
    assert.equal(pending.length, 1);
    assert.equal(Math.abs(pending[0].amount), 1_800); // 13,600 − 11,800
  });

  it('a return is made to the customer of the bill, not later than the bill', () => {
    const k = posKit();
    const b = sold(k);
    rejects(() => saveBill(k, { ...ret(k, b.id, 1, []), partyLedgerId: k.L.customer }), 'BUSINESS_RULE', /billed to another party/);
  });
});

describe('POS review regressions: what was built on a bill stays true', () => {
  const soldTwo = (k: PosKit) => saveBill(k, bill(k, [line(k.I.soap, 2, 100)], { tenders: [tender(k.M.cash, 23_600)] }));
  const retInput = (k: PosKit, billId: number, items: ReturnType<typeof line>[], tenders: ReturnType<typeof tender>[], extra = {}) => ({
    voucherTypeId: k.returnType,
    date: k.t.today,
    mode: 'item_invoice' as const,
    partyLedgerId: k.L.cash,
    originalInvoiceNo: k.t.db.value<string>('SELECT number FROM vouchers WHERE id = :id', { id: billId }) ?? undefined,
    originalInvoiceDate: k.t.today,
    noteReason: 'Sales return',
    items,
    posBill: { tenders, returnOfId: billId },
    ...extra,
  });

  it('a bill with returns cannot sell less than came back, change customer, move after the return or become optional', () => {
    const k = posKit();
    const b = soldTwo(k);
    saveBill(k, retInput(k, b.id, [line(k.I.soap, 2, 100)], [tender(k.M.cash, 23_600)]));
    // Regression: the bill used to be altered down to 1 soap while 2 had been refunded.
    rejects(() => saveBill(k, { ...bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.cash, 11_800)] }), id: b.id }), 'BUSINESS_RULE', /came back on the returns of this bill/);
    rejects(
      () => saveBill(k, { ...bill(k, [line(k.I.soap, 2, 100)], { tenders: [tender(k.M.cash, 23_600)] }, { partyLedgerId: k.L.customer }), id: b.id }),
      'BUSINESS_RULE',
      /customer cannot change/,
    );
    rejects(() => saveBill(k, { ...bill(k, [line(k.I.soap, 2, 100)], { tenders: [tender(k.M.cash, 23_600)] }, { date: '2026-04-16' }), id: b.id }), 'BUSINESS_RULE', /cannot be dated after its return/);
    rejects(() => saveBill(k, { ...bill(k, [line(k.I.soap, 2, 100)], { tenders: [tender(k.M.cash, 23_600)] }, { isOptional: true }), id: b.id }), 'BUSINESS_RULE', /cannot become optional/);
    // The bill cannot be cheapened below what was refunded either (2 soaps at ₹50 = 11,800 < 23,600 refunded).
    rejects(() => saveBill(k, { ...bill(k, [line(k.I.soap, 2, 50)], { tenders: [tender(k.M.cash, 11_800)] }), id: b.id }), 'BUSINESS_RULE', /returns of this bill total ₹ 236\.00/);
    // Adding goods is fine (3 soaps: 35,400).
    saveBill(k, { ...bill(k, [line(k.I.soap, 3, 100)], { tenders: [tender(k.M.cash, 35_400)] }), id: b.id });
    assert.equal(trialSum(k), 0);
  });

  it('a return whose exchange credit was used cannot issue less, or be dated after its use', () => {
    const k = posKit();
    const b = soldTwo(k);
    const r = saveBill(k, retInput(k, b.id, [line(k.I.soap, 2, 100)], [tender(k.M.exchange, 23_600)]));
    saveBill(k, bill(k, [line(k.I.soap, 2, 100)], { tenders: [tender(k.M.exchange, 23_600, { exchangeVoucherId: r.id })] }));
    // Regression: the return used to be altered to 1 soap refunded in cash, leaving ₹236 of credit spent
    // that was never issued (POS Exchange Credit with a debit balance).
    rejects(() => saveBill(k, { ...retInput(k, b.id, [line(k.I.soap, 1, 100)], [tender(k.M.cash, 11_800)]), id: r.id }), 'BUSINESS_RULE', /cannot issue less/);
    rejects(
      () => saveBill(k, { ...retInput(k, b.id, [line(k.I.soap, 2, 100)], [tender(k.M.exchange, 23_600)], { date: '2026-04-16' }), id: r.id }),
      'BUSINESS_RULE',
      /cannot be dated after it/,
    );
    rejects(() => saveBill(k, { ...retInput(k, b.id, [line(k.I.soap, 2, 100)], [tender(k.M.exchange, 23_600)], { isOptional: true }), id: r.id }), 'BUSINESS_RULE', /cannot issue less/);
    assert.equal(k.t.db.value('SELECT SUM(amount) FROM ledger_entries WHERE ledger_id = :l AND affects_books = 1', { l: k.L.exchange }), 0);
  });

  it('a return never refunds more than the bill charged for the goods', () => {
    const k = posKit();
    // Pen ₹10 + 18 % = 11.80 → 12.00 after round-off.
    const b = saveBill(k, bill(k, [line(k.I.pen, 1, 10)], { tenders: [tender(k.M.cash, 1_200)] }));
    // Regression: a return at ₹1,000 a pen used to refund ₹1,180 in cash against a ₹12 bill.
    rejects(() => saveBill(k, retInput(k, b.id, [line(k.I.pen, 1, 1000)], [tender(k.M.cash, 118_000)])), 'BUSINESS_RULE', /charged ₹ 10\.00 for 1/);
    const ok = saveBill(k, retInput(k, b.id, [line(k.I.pen, 1, 10)], [tender(k.M.cash, 1_200)]));
    assert.equal(k.t.db.value('SELECT bill_value FROM pos_bills WHERE voucher_id = :id', { id: ok.id }), 1_200);
  });

  it('partial returns share the bill value, with a rupee of round-off slack per note', () => {
    const k = posKit();
    // 3 pens: 3,000 + 540 GST = 3,540 → 35.00 (rounded down 0.40).
    const b = saveBill(k, bill(k, [line(k.I.pen, 3, 10)], { tenders: [tender(k.M.cash, 3_500)] }));
    // Each return of one pen is 11.80 → 12.00: 12 + 12 + 12 = 36 > 35, within ₹1 of slack per note.
    for (let i = 0; i < 3; i++) saveBill(k, retInput(k, b.id, [line(k.I.pen, 1, 10)], [tender(k.M.cash, 1_200)]));
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM pos_bills WHERE return_of_id = :id', { id: b.id }), 3);
    assert.equal(trialSum(k), 0);
  });

  it('a return altered as a credit note elsewhere keeps its bill: returned quantities still count', () => {
    const k = posKit();
    const b = soldTwo(k);
    const r = saveBill(k, retInput(k, b.id, [line(k.I.soap, 1, 100)], [tender(k.M.cash, 11_800)]));
    const { posBill: _p, ...plain } = retInput(k, b.id, [line(k.I.soap, 1, 100)], []);
    saveVoucher(k.t.ctx, { ...plain, id: r.id, narration: 'note added', acknowledgeWarnings: true });
    assert.equal(k.t.db.value('SELECT return_of_id FROM pos_bills WHERE voucher_id = :id', { id: r.id }), b.id);
    // Only one soap is left to return.
    rejects(() => saveBill(k, retInput(k, b.id, [line(k.I.soap, 2, 100)], [tender(k.M.cash, 23_600)])), 'BUSINESS_RULE', /Only 1 of 'Bath Soap 100g'/);
  });

  it('post-dated returns and bills count at once: no second return of the same goods, no second use of a credit', () => {
    const k = posKit();
    const b = soldTwo(k);
    // A post-dated return (20-Apr) of both soaps: before its date it already counts.
    saveBill(k, retInput(k, b.id, [line(k.I.soap, 2, 100)], [tender(k.M.cash, 23_600)], { date: '2026-04-20', isPostDated: true }));
    rejects(() => saveBill(k, retInput(k, b.id, [line(k.I.soap, 1, 100)], [tender(k.M.cash, 11_800)])), 'BUSINESS_RULE', /Only 0 of 'Bath Soap 100g'/);
    // Exchange credit spent on a post-dated bill cannot be spent again today.
    const b2 = soldTwo(k);
    const r2 = saveBill(k, retInput(k, b2.id, [line(k.I.soap, 1, 100)], [tender(k.M.exchange, 11_800)]));
    saveBill(k, bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.exchange, 11_800, { exchangeVoucherId: r2.id })] }, { date: '2026-04-25', isPostDated: true }));
    rejects(
      () => saveBill(k, bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.exchange, 11_800, { exchangeVoucherId: r2.id })] })),
      'BUSINESS_RULE',
      /has ₹ 0\.00 of exchange credit left/,
    );
  });

  it('CGST s.34(2): a return after 30 November following the year of sale is flagged (confirm)', () => {
    const k = posKit({ today: '2027-12-05', booksFrom: '2026-04-01' });
    const b = saveBill(k, bill(k, [line(k.I.soap, 1, 100)], { tenders: [tender(k.M.cash, 11_800)] }, { date: '2026-04-15' }));
    const p = previewVoucher(k.t.ctx, retInput(k, b.id, [line(k.I.soap, 1, 100)], [tender(k.M.cash, 11_800)]));
    const w = p.warnings.find((x) => x.code === 'pos' && /34\(2\)/.test(x.message));
    assert.ok(w, JSON.stringify(p.warnings));
    assert.equal(w.blocking, false);
    assert.match(w.message, /30-Nov-2027|30 Nov 2027|30\/11\/2027/);
    // Within the limit: no reminder.
    const k2 = posKit({ today: '2027-11-30', booksFrom: '2026-04-01' });
    const b2 = saveBill(k2, bill(k2, [line(k2.I.soap, 1, 100)], { tenders: [tender(k2.M.cash, 11_800)] }, { date: '2026-04-15' }));
    const p2 = previewVoucher(k2.t.ctx, retInput(k2, b2.id, [line(k2.I.soap, 1, 100)], [tender(k2.M.cash, 11_800)]));
    assert.equal(p2.warnings.some((x) => /34\(2\)/.test(x.message)), false);
  });
});
