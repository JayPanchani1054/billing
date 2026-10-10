/**
 * 2.0 renumbering vs documents that cite the number (V2 review, owner decision): a credit / debit note
 * cites its original invoice by number (original_invoice_no → GSTR-1 CDNR), an invoice or note fulfils an
 * order by its number (inventory_entries.order_ref), an invoice bills a delivery / receipt note by its
 * number (tracking_ref). Renumbering such a voucher would leave those citing a number that no longer
 * exists, so it is refused (BUSINESS_RULE) with a message naming them — in vouchers.renumber, in the
 * numberOverride path of an alteration, and live in vouchers.numberCheck. Without references the
 * renumber goes through as before.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { allPlanProblems, recordSql } from '../../testing/sqlPlans.ts';
import { vouchersRoutes } from './routes.ts';
import { storedInput, loadVoucherRow } from './service.ts';
import { header, purchaseInput, salesInput, save, setupKit, type Kit } from './testkit.ts';

const updatedAt = (k: Kit, id: number): string => String(header(k, id).updated_at);

const renumber = (k: Kit, id: number, number: string) =>
  k.t.call(vouchersRoutes, 'vouchers.renumber', { id, number, expectedUpdatedAt: updatedAt(k, id), acknowledgeWarnings: true });

const check = (k: Kit, id: number, number: string) =>
  k.t.callOk<{ ok: boolean; taken: boolean; problems: string[] }>(vouchersRoutes, 'vouchers.numberCheck', {
    voucherTypeId: Number(header(k, id).voucher_type_id),
    date: String(header(k, id).date),
    number,
    excludeId: id,
  });

/** The numberOverride path of an alteration: the saved voucher as entered, plus the new number. */
const alterWithOverride = (k: Kit, id: number, number: string) => {
  const row = loadVoucherRow(k.t.db, id);
  assert.ok(row);
  const input: VoucherInput = { ...storedInput(k.t.db, row), id, expectedUpdatedAt: updatedAt(k, id), acknowledgeWarnings: true, numberOverride: { number } };
  return k.t.call(vouchersRoutes, 'vouchers.save', input);
};

const refused = (r: { ok: boolean; error?: { code: string; message: string } }, re: RegExp): void => {
  assert.equal(r.ok ? 'ok' : r.error?.code, 'BUSINESS_RULE');
  assert.match(r.ok ? '' : (r.error?.message ?? ''), re);
};

describe('renumbering refuses when other vouchers cite the number (V2 review)', () => {
  it('a sales invoice cited by a credit note: renumber, alter override and number check all refuse, naming the note', async () => {
    const k = setupKit();
    const inv = save(k, salesInput(k));
    const cn = save(k, {
      voucherTypeId: k.vt.credit_note,
      date: k.t.today,
      mode: 'item_invoice',
      partyLedgerId: k.L.acme,
      originalInvoiceNo: String(inv.number),
      originalInvoiceDate: k.t.today,
      items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }],
    });
    const msg = new RegExp(`Credit Note ${cn.number} refers to this number — change that reference first`);
    refused(await renumber(k, inv.id, 'SHOP/77'), msg);
    refused(await alterWithOverride(k, inv.id, 'SHOP/77'), msg);
    assert.equal(header(k, inv.id).number, inv.number);
    const c = await check(k, inv.id, 'SHOP/77');
    assert.equal(c.ok, false);
    assert.ok(c.problems.some((p) => msg.test(p)), JSON.stringify(c.problems));
    // The current number itself is not a problem.
    assert.deepEqual((await check(k, inv.id, String(inv.number))).problems, []);
    k.t.close();
  });

  it('a purchase invoice cited by a debit note is refused too; two citing vouchers are both named', async () => {
    const k = setupKit();
    const pur = save(k, purchaseInput(k));
    const dn = save(k, {
      voucherTypeId: k.vt.debit_note,
      date: k.t.today,
      mode: 'item_invoice',
      partyLedgerId: k.L.supplier,
      referenceNo: 'DN-SUP-1',
      originalInvoiceNo: String(pur.number),
      items: [{ itemId: k.I.rice, qty: 2, rate: 80 }],
    });
    refused(await renumber(k, pur.id, 'P-900'), new RegExp(`Debit Note ${dn.number} refers to this number`));
    const dn2 = save(k, {
      voucherTypeId: k.vt.debit_note,
      date: k.t.today,
      mode: 'item_invoice',
      partyLedgerId: k.L.supplier,
      referenceNo: 'DN-SUP-2',
      originalInvoiceNo: String(pur.number),
      items: [{ itemId: k.I.rice, qty: 1, rate: 80 }],
    });
    refused(await renumber(k, pur.id, 'P-900'), new RegExp(`Debit Note ${dn.number} and Debit Note ${dn2.number} refer to this number — change those references first`));
    k.t.close();
  });

  it('an invoiced sales order and a received purchase order are refused (the order would show pending again)', async () => {
    const k = setupKit();
    const so = save(k, { voucherTypeId: k.vt.sales_order, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }] });
    const inv = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 5, rate: 200, orderRef: String(so.number) }] }));
    const msg = new RegExp(`Sales ${inv.number} refers to this number`);
    refused(await renumber(k, so.id, 'SO-77'), msg);
    refused(await alterWithOverride(k, so.id, 'SO-77'), msg);
    assert.ok((await check(k, so.id, 'SO-77')).problems.some((p) => msg.test(p)));
    assert.equal(header(k, so.id).number, so.number);

    const po = save(k, { voucherTypeId: k.vt.purchase_order, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.supplier, items: [{ itemId: k.I.rice, qty: 20, rate: 80 }] });
    const pur = save(k, purchaseInput(k, { items: [{ itemId: k.I.rice, qty: 20, rate: 80, orderRef: String(po.number) }] }));
    refused(await renumber(k, po.id, 'PO-77'), new RegExp(`Purchase ${pur.number} refers to this number`));
    k.t.close();
  });

  it('a billed delivery note is reported by the number check as well', async () => {
    const k = setupKit();
    const dln = save(k, { voucherTypeId: k.vt.delivery_note, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }] });
    const inv = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 5, rate: 200, trackingRef: String(dln.number) }] }));
    const msg = new RegExp(`Sales ${inv.number} refers to this number`);
    refused(await renumber(k, dln.id, 'DN-77'), msg);
    assert.ok((await check(k, dln.id, 'DN-77')).problems.some((p) => msg.test(p)));
    k.t.close();
  });

  it('without references (other party, other date, cancelled note) the renumber goes through', async () => {
    const k = setupKit();
    const inv = save(k, salesInput(k));
    // Same number, but another customer's note, or a note citing another invoice date, or a cancelled note.
    save(k, { voucherTypeId: k.vt.credit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.walkin, originalInvoiceNo: String(inv.number), items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] });
    save(k, { voucherTypeId: k.vt.credit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, originalInvoiceNo: String(inv.number), originalInvoiceDate: '2026-04-01', items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] });
    const gone = save(k, { voucherTypeId: k.vt.credit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, originalInvoiceNo: String(inv.number), items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] });
    await k.t.callOk(vouchersRoutes, 'vouchers.cancel', { id: gone.id, reason: 'Wrong', expectedUpdatedAt: updatedAt(k, gone.id) });
    const c = await check(k, inv.id, 'SHOP/77');
    assert.deepEqual([c.ok, c.problems], [true, []]);
    const r = await renumber(k, inv.id, 'SHOP/77');
    assert.equal(r.ok ? 'ok' : `${r.error.code} ${r.error.message}`, 'ok');
    assert.equal(header(k, inv.id).number, 'SHOP/77');
    // An order nobody fulfilled yet, too.
    const so = save(k, { voucherTypeId: k.vt.sales_order, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }] });
    const r2 = await alterWithOverride(k, so.id, 'SO-77');
    assert.equal(r2.ok ? 'ok' : `${r2.error.code} ${r2.error.message}`, 'ok');
    assert.equal(header(k, so.id).number, 'SO-77');
    k.t.close();
  });

  it('the citation lookups of numberCheck go through indexes (no scan of the books)', async () => {
    const k = setupKit();
    const inv = save(k, salesInput(k));
    const so = save(k, { voucherTypeId: k.vt.sales_order, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }] });
    const dln = save(k, { voucherTypeId: k.vt.delivery_note, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }] });
    const rec = recordSql(k.t.db);
    rec.start();
    for (const id of [inv.id, so.id, dln.id]) await check(k, id, 'X-1');
    const statements = rec.stop();
    assert.ok(statements.some((st) => /original_invoice_no/.test(st.sql)) && statements.some((st) => /order_ref/.test(st.sql)) && statements.some((st) => /tracking_ref/.test(st.sql)));
    assert.deepEqual(allPlanProblems(k.t.db, statements, 'numberCheck citations'), []);
    k.t.close();
  });
});
