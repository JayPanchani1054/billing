/**
 * Sales / Purchase Bills Pending, "Invoice now" drafts, and order pre-close.
 *
 * Delivery Note 1 (acme, 5-Apr): Mixer 10 @ ₹150, Rice 20 @ ₹50. Sales 1 (10-Apr) bills Mixer 4.
 * Pending on 15-Apr: Mixer 6 × ₹150 = ₹900.00, Rice 20 × ₹50 = ₹1,000.00 → ₹1,900.00.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pendingOrders } from '../stock/orders.ts';
import { trackingRefs } from '../vouchers/queries.ts';
import { save, setupKit, throwsApp, throwsField, type Kit } from '../vouchers/testkit.ts';
import { billsPending } from './billsPending.ts';
import './hook.ts';
import { orderClosures, precloseOrder, reopenOrder } from './orders.ts';
import { draftVoucher, voucherLinks } from './quotations.ts';

function notesKit(): { k: Kit; dn: number } {
  const k = setupKit({ today: '2026-04-15', features: { orderProcessing: true, trackingNumbers: true } });
  const dn = save(k, {
    voucherTypeId: k.vt.delivery_note,
    date: '2026-04-05',
    mode: 'item_invoice',
    partyLedgerId: k.L.acme,
    items: [
      { itemId: k.I.mixer, qty: 10, rate: 150 },
      { itemId: k.I.rice, qty: 20, rate: 50 },
    ],
  });
  save(k, { voucherTypeId: k.vt.sales, date: '2026-04-10', mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 4, rate: 150, trackingRef: '1' }] });
  return { k, dn: dn.id };
}

describe('sales / purchase bills pending', () => {
  it('lists unbilled note lines with quantities, value and age; a past date ignores later invoices', () => {
    const { k, dn } = notesKit();
    const r = billsPending(k.t.db, { kind: 'sales', asOf: '2026-04-15' });
    assert.deepEqual(r.rows.map((x) => [x.itemName, x.qty, x.billedQty, x.pendingQty, x.pendingValue, x.ageDays, x.invoiceBaseType]), [
      ['Mixer Grinder', 10, 4, 6, 90000, 10, 'sales'],
      ['Rice Bag', 20, 0, 20, 100000, 10, 'sales'],
    ]);
    assert.deepEqual(r.totals, { notes: 1, parties: 1, pendingValue: 190000, olderThan7Days: 1 });
    assert.equal(r.rows[0].noteId, dn);
    const before = billsPending(k.t.db, { kind: 'sales', asOf: '2026-04-09' });
    assert.equal(before.rows[0].pendingQty, 10, 'the invoice of 10-Apr does not count on 9-Apr');
    assert.equal(billsPending(k.t.db, { kind: 'sales', asOf: '2026-04-04' }).rows.length, 0, 'the note itself is later');
    assert.equal(billsPending(k.t.db, { kind: 'purchase', asOf: '2026-04-15' }).rows.length, 0);
    assert.equal(billsPending(k.t.db, { kind: 'sales', asOf: '2026-04-15', itemId: k.I.rice }).rows.length, 1);
    k.t.close();
  });

  it('"Invoice now" drafts the pending quantities tracked against the note; billing in full clears it', () => {
    const { k, dn } = notesKit();
    const d = draftVoucher(k.t.ctx, { sourceId: dn, targetBaseType: 'sales' });
    assert.equal(d.voucherTypeId, k.vt.sales);
    assert.deepEqual(d.items?.map((i) => [i.itemId, i.qty, i.rate, i.trackingRef]), [
      [k.I.mixer, 6, 150, '1'],
      [k.I.rice, 20, 50, '1'],
    ]);
    assert.equal(d.convertedFromId, undefined, 'a note is linked by its tracking reference, not a conversion link');
    throwsField(() => draftVoucher(k.t.ctx, { sourceId: dn, targetBaseType: 'credit_note' }), 'targetBaseType');
    save(k, d);
    assert.equal(billsPending(k.t.db, { kind: 'sales', asOf: '2026-04-15' }).rows.length, 0);
    throwsApp(() => draftVoucher(k.t.ctx, { sourceId: dn, targetBaseType: 'sales' }), 'BUSINESS_RULE', /billed in full/);
    k.t.close();
  });

  it('purchase side: receipt notes and rejections out', () => {
    const k = setupKit({ today: '2026-04-15', features: { trackingNumbers: true, rejectionNotes: true } });
    save(k, { voucherTypeId: k.vt.receipt_note, date: '2026-04-02', mode: 'item_invoice', partyLedgerId: k.L.supplier, items: [{ itemId: k.I.rice, qty: 30, rate: 40 }] });
    save(k, { voucherTypeId: k.vt.rejection_out, date: '2026-04-03', mode: 'item_invoice', partyLedgerId: k.L.supplier, items: [{ itemId: k.I.rice, qty: 2, rate: 40 }] });
    const r = billsPending(k.t.db, { kind: 'purchase', asOf: '2026-04-15' });
    assert.deepEqual(r.rows.map((x) => [x.noteBaseType, x.invoiceBaseType, x.pendingQty, x.pendingValue]), [
      ['receipt_note', 'purchase', 30, 120000],
      ['rejection_out', 'debit_note', 2, 8000],
    ]);
    k.t.close();
  });
});

describe('order pre-close', () => {
  function orderKit(): { k: Kit; so: number } {
    const k = setupKit({ today: '2026-04-15', features: { orderProcessing: true } });
    const so = save(k, {
      voucherTypeId: k.vt.sales_order,
      date: '2026-04-02',
      mode: 'item_invoice',
      partyLedgerId: k.L.acme,
      items: [
        { itemId: k.I.mixer, qty: 10, rate: 150 },
        { itemId: k.I.rice, qty: 5, rate: 50 },
      ],
    });
    save(k, { voucherTypeId: k.vt.sales, date: '2026-04-08', mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 4, rate: 150, orderRef: '1' }] });
    return { k, so: so.id };
  }

  it('closes the balance with a reason: pending orders, the order picker and links reflect it; reopen restores it', () => {
    const { k, so } = orderKit();
    const pend = () => pendingOrders(k.t.db, { kind: 'sales', asOf: '2026-04-15' }).rows.map((r) => [r.itemName, r.pendingQty, r.closedQty ?? 0]);
    assert.deepEqual(pend(), [['Mixer Grinder', 6, 0], ['Rice Bag', 5, 0]]);
    // Close 2 of the 6 mixers on 12-Apr.
    precloseOrder(k.t.ctx, { orderId: so, date: '2026-04-12', reason: 'Customer reduced the order', items: [{ itemId: k.I.mixer, qty: 2 }] });
    assert.deepEqual(pend(), [['Mixer Grinder', 4, 2], ['Rice Bag', 5, 0]]);
    assert.equal(pendingOrders(k.t.db, { kind: 'sales', asOf: '2026-04-11' }).rows[0].pendingQty, 6, 'not yet closed on 11-Apr');
    throwsField(() => precloseOrder(k.t.ctx, { orderId: so, reason: 'x', items: [{ itemId: k.I.mixer }] }), 'items[0].itemId', /already pre-closed/);
    throwsField(() => precloseOrder(k.t.ctx, { orderId: so, reason: 'x', items: [{ itemId: k.I.rice, qty: 6 }] }), 'items[0].qty', /Only 5 Nos/);
    // Close the rest of the order (every item's remaining balance).
    precloseOrder(k.t.ctx, { orderId: so, reason: 'Short-closed: item discontinued' });
    assert.deepEqual(pend(), [['Mixer Grinder', 4, 2]], 'rice closed in full leaves the report');
    const picker = trackingRefs(k.t.db, k.L.acme, 'sales_order');
    assert.deepEqual(picker[0].lines.map((l) => [l.itemName, l.pendingQty]), [['Mixer Grinder', 4], ['Rice Bag', 0]]);
    assert.deepEqual(orderClosures(k.t.db, so).map((c) => [c.itemName, c.closedQty]), [['Mixer Grinder', 2], ['Rice Bag', 5]]);
    assert.equal(voucherLinks(k.t.ctx, so).closures.length, 2);
    const audit = k.t.db.all<{ after_json: string }>(`SELECT after_json FROM audit_log WHERE entity_id = :id AND action = 'alter' ORDER BY id`, { id: so });
    assert.match(audit[0].after_json, /Customer reduced the order/);

    reopenOrder(k.t.ctx, { orderId: so, itemId: k.I.rice });
    assert.deepEqual(pend(), [['Mixer Grinder', 4, 2], ['Rice Bag', 5, 0]]);
    reopenOrder(k.t.ctx, { orderId: so });
    assert.deepEqual(pend(), [['Mixer Grinder', 6, 0], ['Rice Bag', 5, 0]]);
    throwsApp(() => reopenOrder(k.t.ctx, { orderId: so }), 'BUSINESS_RULE', /no pre-closed balance/);
    k.t.close();
  });

  it('refuses non-orders, dates before the order, a locked period and missing permission', () => {
    const { k, so } = orderKit();
    const inv = k.t.db.value<number>(`SELECT id FROM vouchers WHERE base_type = 'sales'`) as number;
    throwsApp(() => precloseOrder(k.t.ctx, { orderId: inv, reason: 'x' }), 'BUSINESS_RULE', /Only sales orders and purchase orders/);
    throwsField(() => precloseOrder(k.t.ctx, { orderId: so, date: '2026-04-01', reason: 'x' }), 'date');
    throwsField(() => precloseOrder(k.t.ctx, { orderId: so, reason: '  ' }), 'reason');
    k.t.db.run(`UPDATE settings SET value = json_set(value, '$.lockedUpTo', '2026-04-10') WHERE key = 'config'`);
    throwsApp(() => precloseOrder(k.t.ctx, { orderId: so, date: '2026-04-09', reason: 'x' }), 'LOCKED');
    throwsApp(() => precloseOrder(k.t.ctxAs({ role: 'Data Entry' }), { orderId: so, reason: 'x' }), 'FORBIDDEN');
    k.t.close();
  });
});

