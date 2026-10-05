/**
 * Voucher lifecycle: alter, cancel, delete, optional ↔ regular, post-dated, period lock, permissions,
 * optimistic concurrency, duplicate, audit trail and bank-reconciliation links.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherDetail, VoucherInput } from '../../../shared/types/vouchers.ts';
import { verifyAuditChain } from '../../lib/audit.ts';
import { setPeriodLock } from '../company/service.ts';
import { pendingBills } from './bills.ts';
import { getVoucher } from './queries.ts';
import { vouchersRoutes } from './routes.ts';
import { cancelVoucher, deleteVoucher, duplicateVoucher, previewVoucher, saveVoucher, setVoucherOptional } from './service.ts';
import { bills, entryMap, header, purchaseInput, salesInput, save, setupKit, stockOf, throwsApp, throwsField } from './testkit.ts';

const audits = (k: ReturnType<typeof setupKit>, id: number) =>
  k.t.db.all<{ action: string; before_json: string | null; after_json: string | null; entity_label: string }>(
    `SELECT action, before_json, after_json, entity_label FROM audit_log WHERE entity_type = 'voucher' AND entity_id = :id ORDER BY id`,
    { id },
  );

describe('alter', () => {
  it('keeps the number, rewrites child rows and audits before/after', () => {
    const k = setupKit();
    const first = save(k, salesInput(k));
    assert.equal(stockOf(k, k.I.mixer), 45);
    const detail = getVoucher(k.t.db, first.id);
    // Alter: mixer 3 × ₹200 + rice 2 × ₹100 → 600 + 108 (CGST/SGST 54 each) + 200 + 10 (5 each) = ₹918.00.
    const input: VoucherInput = {
      ...detail.input,
      items: [
        { itemId: k.I.mixer, qty: 3, rate: 200 },
        { itemId: k.I.rice, qty: 2, rate: 100 },
      ],
      narration: 'Corrected quantities',
    };
    k.t.clock.advance(60_000);
    const altered = save(k, input);
    assert.equal(altered.id, first.id);
    assert.equal(altered.number, '1');
    assert.deepEqual(entryMap(k, first.id), { 'Acme Traders': 91800, Sales: -80000, 'Output CGST': -5900, 'Output SGST/UTGST': -5900 });
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM inventory_entries WHERE voucher_id = :id', { id: first.id }), 2);
    assert.equal(stockOf(k, k.I.mixer), 47);
    assert.equal(stockOf(k, k.I.rice), 98);
    assert.deepEqual(bills(k, first.id).map((b) => [b.bill_name, b.amount]), [['1', 91800]]);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM voucher_counters WHERE last_number > 1'), 0, 'alter does not consume a number');

    const log = audits(k, first.id);
    assert.deepEqual(log.map((a) => a.action), ['create', 'alter']);
    const before = JSON.parse(log[1].before_json ?? '{}') as { amount: number; entries: Array<[number, number]> };
    const after = JSON.parse(log[1].after_json ?? '{}') as { amount: number; narration: string };
    assert.equal(before.amount, 118000);
    assert.deepEqual(before.entries[0], [k.L.acme, 118000]);
    assert.equal(after.amount, 91800);
    assert.equal(after.narration, 'Corrected quantities');
    assert.match(log[1].entity_label, /^Sales 1 dated 15-Apr-2026$/);
    assert.equal(verifyAuditChain(k.t.db).ok, true);
    k.t.close();
  });

  it('negative-stock check excludes the voucher being altered', () => {
    const k = setupKit({});
    k.t.db.run(`UPDATE settings SET value = json_set(value, '$.guards.negativeStock', 'block') WHERE key = 'config'`);
    // 50 in stock: selling 50 is fine; altering that sale to 50 again must not count the old 50 twice.
    const res = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 50, rate: 200 }] }));
    const again = save(k, { ...getVoucher(k.t.db, res.id).input, narration: 'same qty' });
    assert.equal(again.id, res.id);
    throwsApp(() => save(k, { ...getVoucher(k.t.db, res.id).input, items: [{ itemId: k.I.mixer, qty: 51, rate: 200 }] }), 'BUSINESS_RULE', /Mixer Grinder in Main Location will go negative/);
    k.t.close();
  });

  it('the voucher type cannot change; cancelled vouchers cannot be altered', () => {
    const k = setupKit();
    const res = save(k, salesInput(k));
    throwsField(() => save(k, { ...salesInput(k), id: res.id, voucherTypeId: k.vt.credit_note }), 'voucherTypeId', /cannot be changed/);
    cancelVoucher(k.t.ctx, res.id, 'Entered twice');
    throwsApp(() => save(k, { ...salesInput(k), id: res.id }), 'BUSINESS_RULE', /cancelled voucher cannot be altered/);
    k.t.close();
  });

  it('optimistic concurrency: a stale expectedUpdatedAt is a CONFLICT', () => {
    const k = setupKit();
    const res = save(k, salesInput(k));
    const opened: VoucherDetail = getVoucher(k.t.db, res.id);
    k.t.clock.advance(1000);
    const ok = save(k, { ...opened.input, narration: 'first edit' });
    assert.notEqual(ok.updatedAt, opened.updatedAt);
    k.t.clock.advance(1000);
    throwsApp(() => save(k, { ...opened.input, narration: 'stale edit' }), 'CONFLICT', /changed by someone else/);
    assert.equal(header(k, res.id).narration, 'first edit');
    k.t.close();
  });

  it('bank reconciliation dates and statement matches survive an alter of the narration', () => {
    const k = setupKit();
    const rec = save(k, { voucherTypeId: k.vt.receipt, date: k.t.today, mode: 'ledger', ledgers: [{ ledgerId: k.L.bank, amount: 50000 }, { ledgerId: k.L.acme, amount: -50000 }] });
    const bankEntry = k.t.db.value<number>('SELECT id FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :b', { id: rec.id, b: k.L.bank }) as number;
    k.t.db.run('UPDATE ledger_entries SET bank_date = :d WHERE id = :id', { d: '2026-04-16', id: bankEntry });
    const batch = k.t.db.run(`INSERT INTO import_batches (kind, imported_at) VALUES ('bank_statement', :ts)`, { ts: k.t.clock.now().toISOString() }).lastInsertRowid;
    const line = k.t.db.run(
      `INSERT INTO bank_statement_lines (batch_id, ledger_id, txn_date, amount, status, matched_entry_id) VALUES (:b, :l, :d, 50000, 'matched', :e)`,
      { b: batch, l: k.L.bank, d: '2026-04-16', e: bankEntry },
    ).lastInsertRowid;
    save(k, { ...getVoucher(k.t.db, rec.id).input, narration: 'Cheque cleared' });
    const fresh = k.t.db.get<{ id: number; bank_date: string | null }>('SELECT id, bank_date FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :b', { id: rec.id, b: k.L.bank });
    assert.equal(fresh?.bank_date, '2026-04-16');
    assert.equal(k.t.db.value('SELECT matched_entry_id FROM bank_statement_lines WHERE id = :id', { id: line }), fresh?.id);
    // Changing the amount breaks the match: the statement line goes back to unmatched.
    const input = getVoucher(k.t.db, rec.id).input;
    save(k, { ...input, ledgers: [{ ledgerId: k.L.bank, amount: 40000 }, { ledgerId: k.L.acme, amount: -40000 }] });
    assert.deepEqual(k.t.db.get('SELECT status, matched_entry_id FROM bank_statement_lines WHERE id = :id', { id: line }), { status: 'unmatched', matched_entry_id: null });
    k.t.close();
  });
});

describe('alter edge cases', () => {
  it('altering a settled invoice does not raise a false duplicate-bill warning', () => {
    const k = setupKit();
    const inv = save(k, salesInput(k));
    save(k, {
      voucherTypeId: k.vt.receipt,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.bank, amount: 50000 },
        { ledgerId: k.L.acme, amount: -50000, billAllocations: [{ refType: 'against', billName: '1', amount: 50000 }] },
      ],
    });
    // Strict save (no acknowledgement): must not ask for confirmation.
    const res = saveVoucher(k.t.ctx, { ...getVoucher(k.t.db, inv.id).input, narration: 'edited' });
    assert.deepEqual(res.warnings, []);
    assert.deepEqual(pendingBills(k.t.db, k.L.acme, k.t.today, k.t.today).map((b) => [b.billName, b.amount]), [['1', 68000]]);
    k.t.close();
  });

  it('moving a voucher into a period where its number is taken is a CONFLICT', () => {
    const k = setupKit();
    const a = save(k, salesInput(k, { date: '2026-04-15' })); // '1' in 2026-27
    save(k, salesInput(k, { date: '2027-04-05' })); // '1' in 2027-28
    throwsApp(() => save(k, { ...getVoucher(k.t.db, a.id).input, date: '2027-04-06' }), 'CONFLICT', /already used in the period of the new date/);
    // Within the same period the number simply stays.
    assert.equal(save(k, { ...getVoucher(k.t.db, a.id).input, date: '2026-05-01' }).number, '1');
    k.t.close();
  });

  it('preview flags a locked period as blocking', () => {
    const k = setupKit();
    setPeriodLock(k.t.ctx, '2026-04-10');
    const p = previewVoucher(k.t.ctx, salesInput(k, { date: '2026-04-09' }));
    assert.deepEqual(p.warnings.map((w) => [w.code, w.blocking]), [['period_locked', true]]);
    k.t.close();
  });
});

describe('cancel & delete', () => {
  it('cancel keeps the header and number, removes postings and stores the pre-cancel snapshot', () => {
    const k = setupKit();
    const res = save(k, salesInput(k));
    const out = cancelVoucher(k.t.ctx, res.id, 'Wrong party');
    assert.equal(out.number, '1');
    const h = header(k, res.id);
    assert.deepEqual(
      [h.is_cancelled, h.affects_books, h.affects_stock, h.total_amount, h.taxable_amount, h.tax_amount, h.number],
      [1, 0, 0, 0, 0, 0, '1'],
    );
    for (const table of ['ledger_entries', 'inventory_entries', 'gst_lines', 'bill_allocations']) {
      assert.equal(k.t.db.value(`SELECT COUNT(*) FROM ${table} WHERE voucher_id = :id`, { id: res.id }), 0, table);
    }
    assert.equal(stockOf(k, k.I.mixer), 50);
    const meta = JSON.parse(String(h.meta)) as { cancelled: { reason: string; snapshot: { amount: number } } };
    assert.equal(meta.cancelled.reason, 'Wrong party');
    assert.equal(meta.cancelled.snapshot.amount, 118000);
    const d = getVoucher(k.t.db, res.id);
    assert.equal(d.isCancelled, true);
    assert.equal(d.cancellation?.reason, 'Wrong party');
    assert.equal(d.input.items?.[0].qty, 5, 'the entered voucher is still viewable');
    assert.deepEqual(audits(k, res.id).map((a) => a.action), ['create', 'cancel']);
    throwsApp(() => cancelVoucher(k.t.ctx, res.id, 'again'), 'BUSINESS_RULE', /already cancelled/);
    assert.equal(save(k, salesInput(k)).number, '2', 'the cancelled number is not reused');
    k.t.close();
  });

  it('delete removes the voucher and its rows and is audited', () => {
    const k = setupKit();
    const res = save(k, salesInput(k));
    deleteVoucher(k.t.ctx, res.id, 'Duplicate entry');
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM vouchers WHERE id = :id', { id: res.id }), 0);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM ledger_entries WHERE voucher_id = :id', { id: res.id }), 0);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM inventory_entries WHERE voucher_id = :id', { id: res.id }), 0);
    const log = audits(k, res.id);
    assert.deepEqual(log.map((a) => a.action), ['create', 'delete']);
    assert.equal((JSON.parse(log[1].before_json ?? '{}') as { reason: string }).reason, 'Duplicate entry');
    assert.equal(stockOf(k, k.I.mixer), 50);
    throwsApp(() => deleteVoucher(k.t.ctx, res.id), 'NOT_FOUND');
    k.t.close();
  });

  it('an invoice whose bill is settled cannot be deleted or cancelled', () => {
    const k = setupKit();
    const inv = save(k, salesInput(k));
    save(k, {
      voucherTypeId: k.vt.receipt,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.bank, amount: 118000 },
        { ledgerId: k.L.acme, amount: -118000, billAllocations: [{ refType: 'against', billName: '1', amount: 118000 }] },
      ],
    });
    throwsApp(() => deleteVoucher(k.t.ctx, inv.id), 'BUSINESS_RULE', /settled by Receipt 1/);
    throwsApp(() => cancelVoucher(k.t.ctx, inv.id, 'x'), 'BUSINESS_RULE', /settled by Receipt 1/);
    k.t.close();
  });
});

describe('optional & post-dated', () => {
  it('optional vouchers do not affect books or stock until made regular', () => {
    const k = setupKit();
    const res = save(k, salesInput(k, { isOptional: true }));
    const h = header(k, res.id);
    assert.deepEqual([h.is_optional, h.affects_books, h.affects_stock], [1, 0, 0]);
    assert.equal(k.t.db.value('SELECT MAX(affects_books) FROM ledger_entries WHERE voucher_id = :id', { id: res.id }), 0);
    assert.equal(k.t.db.value('SELECT MAX(affects_books) FROM gst_lines WHERE voucher_id = :id', { id: res.id }), 0);
    assert.equal(stockOf(k, k.I.mixer), 50);
    assert.deepEqual(pendingBills(k.t.db, k.L.acme, k.t.today, k.t.today), []);

    const reg = setVoucherOptional(k.t.ctx, res.id, false);
    assert.equal(reg.number, '1');
    const h2 = header(k, res.id);
    assert.deepEqual([h2.is_optional, h2.affects_books, h2.affects_stock], [0, 1, 1]);
    assert.equal(stockOf(k, k.I.mixer), 45);
    assert.deepEqual(pendingBills(k.t.db, k.L.acme, k.t.today, k.t.today).map((b) => [b.billName, b.amount]), [['1', 118000]]);
    k.t.close();
  });

  it('voucher types marked optional by default create optional vouchers', () => {
    const k = setupKit();
    k.t.db.run('UPDATE voucher_types SET optional_by_default = 1 WHERE id = :id', { id: k.vt.journal });
    const res = save(k, { voucherTypeId: k.vt.journal, date: k.t.today, mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 100 }, { ledgerId: k.L.capital, amount: -100 }] });
    assert.equal(header(k, res.id).is_optional, 1);
    k.t.close();
  });
});

describe('period lock', () => {
  it('rejects create, alter (old or new date), cancel and delete on or before the lock date', () => {
    const k = setupKit();
    const early = save(k, salesInput(k, { date: '2026-04-05' }));
    const late = save(k, salesInput(k, { date: '2026-04-14' }));
    setPeriodLock(k.t.ctx, '2026-04-10');
    throwsApp(() => save(k, salesInput(k, { date: '2026-04-10' })), 'LOCKED', /Books are locked up to 10-Apr-2026/);
    throwsApp(() => save(k, { ...getVoucher(k.t.db, early.id).input, date: '2026-04-12' }), 'LOCKED');
    throwsApp(() => save(k, { ...getVoucher(k.t.db, late.id).input, date: '2026-04-09' }), 'LOCKED');
    throwsApp(() => deleteVoucher(k.t.ctx, early.id), 'LOCKED');
    throwsApp(() => cancelVoucher(k.t.ctx, early.id, 'x'), 'LOCKED');
    // After the lock date everything still works.
    save(k, { ...getVoucher(k.t.db, late.id).input, narration: 'ok' });
    assert.equal(save(k, salesInput(k, { date: '2026-04-11' })).number, '3');
    k.t.close();
  });
});

describe('permissions', () => {
  it('Data Entry can create today but cannot backdate, alter, cancel or delete', async () => {
    const k = setupKit();
    const dataEntry = k.t.sessionAs({ role: 'Data Entry' });
    const today = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k), acknowledgeWarnings: true }, { session: dataEntry });
    assert.equal(today.ok, true);
    const id = (today as { ok: true; data: { id: number } }).data.id;

    const back = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k, { date: '2026-04-14' }), acknowledgeWarnings: true }, { session: dataEntry });
    assert.equal(back.ok ? 'ok' : back.error.code, 'FORBIDDEN');
    assert.match(back.ok ? '' : back.error.message, /before today \(15-Apr-2026\)/);

    const alter = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k), id, acknowledgeWarnings: true }, { session: dataEntry });
    assert.equal(alter.ok ? 'ok' : alter.error.code, 'FORBIDDEN');
    const del = await k.t.call(vouchersRoutes, 'vouchers.delete', { id }, { session: dataEntry });
    assert.equal(del.ok ? 'ok' : del.error.code, 'FORBIDDEN');
    const cancel = await k.t.call(vouchersRoutes, 'vouchers.cancel', { id, reason: 'x' }, { session: dataEntry });
    assert.equal(cancel.ok ? 'ok' : cancel.error.code, 'FORBIDDEN');

    const accountant = k.t.sessionAs({ role: 'Accountant' });
    const acc = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k, { date: '2026-04-14' }), acknowledgeWarnings: true }, { session: accountant });
    assert.equal(acc.ok, true);
    const auditor = k.t.sessionAs({ role: 'Auditor' });
    const view = await k.t.call(vouchersRoutes, 'vouchers.get', { id }, { session: auditor });
    assert.equal(view.ok, true);
    const auditorSave = await k.t.call(vouchersRoutes, 'vouchers.save', salesInput(k), { session: auditor });
    assert.equal(auditorSave.ok ? 'ok' : auditorSave.error.code, 'FORBIDDEN');
    const auditorAlter = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k), id, acknowledgeWarnings: true }, { session: auditor });
    assert.equal(auditorAlter.ok ? 'ok' : auditorAlter.error.code, 'FORBIDDEN');
    k.t.close();
  });

  it('a custom role that may alter but not create can alter (and still cannot create)', async () => {
    const k = setupKit();
    const res = save(k, salesInput(k));
    // Before the fix the route itself demanded vouchers.create, so this role could not alter at all.
    const editor = k.t.sessionAs({ permissions: ['vouchers.view', 'vouchers.alter'] });
    const alter = await k.t.call(vouchersRoutes, 'vouchers.save', { ...getVoucher(k.t.db, res.id).input, narration: 'fixed', acknowledgeWarnings: true }, { session: editor });
    assert.equal(alter.ok, true, alter.ok ? '' : alter.error.message);
    assert.equal(header(k, res.id).narration, 'fixed');
    const create = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k), acknowledgeWarnings: true }, { session: editor });
    assert.equal(create.ok ? 'ok' : create.error.code, 'FORBIDDEN');
    const viewer = k.t.sessionAs({ permissions: ['vouchers.view'] });
    const none = await k.t.call(vouchersRoutes, 'vouchers.save', { ...getVoucher(k.t.db, res.id).input, acknowledgeWarnings: true }, { session: viewer });
    assert.equal(none.ok ? 'ok' : none.error.code, 'FORBIDDEN');
    k.t.close();
  });

  it('route input validation rejects malformed vouchers', async () => {
    const k = setupKit();
    const r = await k.t.call(vouchersRoutes, 'vouchers.save', { voucherTypeId: k.vt.sales, date: '2026-02-30', mode: 'item_invoice' });
    assert.equal(r.ok ? 'ok' : r.error.code, 'VALIDATION');
    const r2 = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k), items: [{ itemId: k.I.mixer, qty: -1, rate: 10 }] });
    assert.equal(r2.ok ? 'ok' : r2.error.code, 'VALIDATION');
    k.t.close();
  });
});

describe('duplicate', () => {
  it('returns the voucher as new input dated today without number, bills or supplier reference', () => {
    const k = setupKit();
    const res = save(k, purchaseInput(k, { date: '2026-04-10', narration: 'Monthly stock' }));
    const dup = duplicateVoucher(k.t.ctx, res.id);
    assert.equal(dup.id, undefined);
    assert.equal(dup.number, undefined);
    assert.equal(dup.date, k.t.today);
    assert.equal(dup.referenceNo, undefined);
    assert.equal(dup.narration, 'Monthly stock');
    const cn = save(k, { voucherTypeId: k.vt.debit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.supplier, originalInvoiceNo: 'SUP-101', items: [{ itemId: k.I.rice, qty: 1, rate: 80 }] });
    assert.equal(duplicateVoucher(k.t.ctx, cn.id).originalInvoiceNo, undefined, 'a copy must not settle the same bill again');
    assert.deepEqual(dup.items, [{ itemId: k.I.rice, qty: 20, rate: 80 }]);
    const again = saveVoucher(k.t.ctx, { ...dup, referenceNo: 'SUP-102', acknowledgeWarnings: true });
    assert.equal(again.number, '2');
    k.t.close();
  });
});
