/**
 * Voucher numbering: automatic series, yearly / monthly restart, prefix/suffix/width, manual numbering
 * with duplicate protection, automatic with manual override, and 'none'.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BindValue } from '../../db/db.ts';
import { formatVoucherNumber, loadVoucherType, parseVoucherSeq } from './numbering.ts';
import { vouchersRoutes } from './routes.ts';
import { nextVoucherNumber, previewVoucher } from './service.ts';
import { bills, header, purchaseInput, salesInput, save, setupKit, throwsApp, throwsField, type Kit } from './testkit.ts';

function configureSales(k: Kit, cols: Record<string, BindValue>): void {
  for (const [col, value] of Object.entries(cols)) {
    // Column names come from this test file only (fixed identifiers), values are bound.
    k.t.db.run(`UPDATE voucher_types SET ${col} = :v WHERE id = :id`, { v: value, id: k.vt.sales });
  }
}

const counters = (k: Kit): Array<[string, number]> =>
  k.t.db
    .all<{ period_key: string; last_number: number }>('SELECT period_key, last_number FROM voucher_counters WHERE voucher_type_id = :id ORDER BY period_key', { id: k.vt.sales })
    .map((r) => [r.period_key, r.last_number]);

describe('voucher numbering', () => {
  it('automatic numbering restarts every financial year', () => {
    const k = setupKit();
    const a = save(k, salesInput(k, { date: '2026-04-15' }));
    const b = save(k, salesInput(k, { date: '2027-03-31' }));
    const c = save(k, salesInput(k, { date: '2027-04-01' }));
    const d = save(k, salesInput(k, { date: '2027-04-02' }));
    assert.deepEqual([a.number, b.number, c.number, d.number], ['1', '2', '1', '2']);
    assert.deepEqual(counters(k), [['2026-27', 2], ['2027-28', 2]]);
    assert.equal(header(k, c.id).number_seq, 1);
    k.t.close();
  });

  it('monthly restart keys the counter by month', () => {
    const k = setupKit();
    // 2.0 (D27): a GST invoice series that restarts monthly carries the month, so numbers stay unique in the FY.
    configureSales(k, { numbering_restart: 'monthly', numbering_prefix: 'S-{MM}-' });
    const a = save(k, salesInput(k, { date: '2026-04-30' }));
    const b = save(k, salesInput(k, { date: '2026-05-01' }));
    assert.deepEqual([a.number, b.number], ['S-04-1', 'S-05-1']);
    assert.deepEqual(counters(k), [['2026-04', 1], ['2026-05', 1]]);
    k.t.close();
  });

  it('prefix, zero-padded width and suffix', () => {
    const k = setupKit();
    configureSales(k, { numbering_prefix: 'INV/', numbering_suffix: '/26-27', numbering_width: 4, numbering_start: 7 });
    const vt = loadVoucherType(k.t.db, k.vt.sales);
    assert.equal(formatVoucherNumber(vt, 7), 'INV/0007/26-27');
    assert.equal(parseVoucherSeq(vt, 'INV/0012/26-27'), 12);
    assert.equal(parseVoucherSeq(vt, 'X/0012/26-27'), null);
    assert.equal(nextVoucherNumber(k.t.ctx, k.vt.sales, k.t.today), 'INV/0007/26-27');
    const a = save(k, salesInput(k));
    assert.equal(a.number, 'INV/0007/26-27');
    assert.equal(header(k, a.id).number_seq, 7);
    assert.equal(nextVoucherNumber(k.t.ctx, k.vt.sales, k.t.today), 'INV/0008/26-27');
    k.t.close();
  });

  it('preview shows the next number without consuming it', () => {
    const k = setupKit();
    assert.equal(previewVoucher(k.t.ctx, salesInput(k)).number, '1');
    assert.equal(previewVoucher(k.t.ctx, salesInput(k)).number, '1');
    assert.equal(save(k, salesInput(k)).number, '1');
    assert.equal(previewVoucher(k.t.ctx, salesInput(k)).number, '2');
    k.t.close();
  });

  it('a failed save (rolled back by the route transaction) leaves no gap in the series', async () => {
    const k = setupKit();
    save(k, salesInput(k));
    // Make the write fail AFTER the number was allocated (gst_lines insert), through the real dispatcher.
    k.t.db.exec(`CREATE TEMP TRIGGER fail_gst BEFORE INSERT ON gst_lines BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;`);
    const r = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k), acknowledgeWarnings: true });
    assert.equal(r.ok, false);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM vouchers'), 1);
    k.t.db.exec('DROP TRIGGER fail_gst');
    assert.deepEqual(counters(k), [['2026-27', 1]]);
    assert.equal(save(k, salesInput(k)).number, '2');
    k.t.close();
  });

  it('manual numbering: number required and duplicates rejected within the period', () => {
    const k = setupKit();
    configureSales(k, { numbering_method: 'manual' });
    assert.equal(nextVoucherNumber(k.t.ctx, k.vt.sales, k.t.today), '');
    throwsField(() => save(k, salesInput(k)), 'number', /Enter the Sales number/);
    const a = save(k, salesInput(k, { number: 'A-100' }));
    assert.equal(a.number, 'A-100');
    throwsApp(() => save(k, salesInput(k, { number: 'A-100' })), 'CONFLICT', /already used/);
    // Same number in the next financial year is fine (yearly restart scope).
    assert.equal(save(k, salesInput(k, { number: 'A-100', date: '2027-04-05' })).number, 'A-100');
    // 2.0 (D27): a GST invoice number stays unique within the financial year even when prevent_duplicates is off.
    configureSales(k, { prevent_duplicates: 0 });
    throwsApp(() => save(k, salesInput(k, { number: 'A-100' })), 'CONFLICT', /already used in FY 2026-27/);
    // Other voucher types: duplicates allowed when prevent_duplicates is off (unchanged).
    k.t.db.run(`UPDATE voucher_types SET numbering_method = 'manual', prevent_duplicates = 0 WHERE id = :id`, { id: k.vt.purchase });
    const p1 = save(k, purchaseInput(k, { number: 'P-1' }));
    const p2 = save(k, purchaseInput(k, { number: 'P-1', referenceNo: 'SUP-102' }));
    assert.deepEqual([p1.number, p2.number], ['P-1', 'P-1']);
    k.t.close();
  });

  it('automatic with manual override: typed numbers do not consume the series; used numbers are skipped', () => {
    const k = setupKit();
    configureSales(k, { numbering_method: 'automatic_override' });
    const typed = save(k, salesInput(k, { number: '2' }));
    assert.equal(typed.number, '2');
    assert.equal(header(k, typed.id).number_seq, 2);
    assert.equal(save(k, salesInput(k)).number, '1');
    assert.equal(save(k, salesInput(k)).number, '3', '2 is taken, so the series skips it');
    // Typing the number the series would give anyway consumes it.
    assert.equal(save(k, salesInput(k, { number: '4' })).number, '4');
    assert.equal(save(k, salesInput(k)).number, '5');
    throwsApp(() => save(k, salesInput(k, { number: '5' })), 'CONFLICT', /already used/);
    k.t.close();
  });

  it("numbering 'none' leaves the number empty", () => {
    const k = setupKit();
    configureSales(k, { numbering_method: 'none' });
    const a = save(k, salesInput(k));
    assert.equal(a.number, null);
    // No number → the bill falls back to on account.
    assert.equal(k.t.db.value('SELECT ref_type FROM bill_allocations WHERE voucher_id = :id', { id: a.id }), 'on_account');
    k.t.close();
  });

  it('each voucher type has its own series', () => {
    const k = setupKit();
    assert.equal(save(k, salesInput(k)).number, '1');
    const cn = save(k, { voucherTypeId: k.vt.credit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] });
    assert.equal(cn.number, '1');
    assert.equal(save(k, salesInput(k)).number, '2');
    k.t.close();
  });
});

// ───────────────────────────── 2.0: number override, GST FY uniqueness (WP-04) ─────────────────────────────

const ACCOUNTANT_WITHOUT_RENUMBER = ['vouchers.view', 'vouchers.create', 'vouchers.alter', 'vouchers.backdate', 'masters.view'] as const;

describe('voucher number override (VoucherInput.numberOverride, vouchers.renumber)', () => {
  it('saves the typed number on an automatic series without touching the counter; continueSeries moves it up, never down', () => {
    const k = setupKit();
    configureSales(k, { numbering_prefix: 'INV/', numbering_width: 4 });
    assert.equal(save(k, salesInput(k)).number, 'INV/0001');
    const typed = save(k, salesInput(k, { numberOverride: { number: 'INV/0141', reason: 'Matching the paper bill book' } }));
    assert.equal(typed.number, 'INV/0141');
    assert.equal(header(k, typed.id).number_seq, 141);
    assert.deepEqual(counters(k), [['2026-27', 1]], 'the series is not consumed');
    assert.equal(save(k, salesInput(k)).number, 'INV/0002');
    // Continue the series from a typed number.
    const cont = save(k, salesInput(k, { numberOverride: { number: 'INV/0200', continueSeries: true } }));
    assert.equal(cont.number, 'INV/0200');
    assert.deepEqual(counters(k), [['2026-27', 200]]);
    assert.equal(save(k, salesInput(k)).number, 'INV/0201');
    // A lower number with continueSeries never lowers the counter.
    save(k, salesInput(k, { numberOverride: { number: 'INV/0150', continueSeries: true } }));
    assert.deepEqual(counters(k), [['2026-27', 201]]);
    // A number outside the format has no sequence: continueSeries is ignored.
    save(k, salesInput(k, { numberOverride: { number: 'A-100', continueSeries: true } }));
    assert.deepEqual(counters(k), [['2026-27', 201]]);
    k.t.close();
  });

  it('typing the number the series would give anyway consumes it', () => {
    const k = setupKit();
    const a = save(k, salesInput(k, { numberOverride: { number: '1' } }));
    assert.equal(a.number, '1');
    assert.deepEqual(counters(k), [['2026-27', 1]]);
    assert.equal(save(k, salesInput(k)).number, '2');
    k.t.close();
  });

  it('needs vouchers.renumber (FORBIDDEN otherwise, through the real route); numbering "none" is a VALIDATION error', async () => {
    const k = setupKit();
    const session = k.t.sessionAs({ permissions: [...ACCOUNTANT_WITHOUT_RENUMBER] });
    const r = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k), acknowledgeWarnings: true, numberOverride: { number: 'X-1' } }, { session });
    assert.equal(r.ok ? 'ok' : r.error.code, 'FORBIDDEN');
    assert.match(r.ok ? '' : r.error.message, /Change voucher numbers/);
    // The Accountant system role holds it.
    const acc = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k), acknowledgeWarnings: true, numberOverride: { number: 'X-1' } }, { session: k.t.sessionAs({ role: 'Accountant' }) });
    assert.equal(acc.ok ? (acc.data as { number: string }).number : acc.error.message, 'X-1');
    // A custom role without it cannot alter the number either.
    const id = (acc as { ok: true; data: { id: number } }).data.id;
    const alter = await k.t.call(vouchersRoutes, 'vouchers.save', { ...salesInput(k), id, acknowledgeWarnings: true, numberOverride: { number: 'X-2' } }, { session });
    assert.equal(alter.ok ? 'ok' : alter.error.code, 'FORBIDDEN');
    configureSales(k, { numbering_method: 'none' });
    throwsField(() => save(k, salesInput(k, { numberOverride: { number: 'X-3' } })), 'number', /not numbered/);
    k.t.close();
  });

  it('GST documents: 1–16 letters, digits, / and - (VALIDATION on path number); other vouchers 1–60 characters, no control characters', () => {
    const k = setupKit();
    throwsField(() => save(k, salesInput(k, { numberOverride: { number: 'INV/2026-27/00001' } })), 'number', /at most 16 characters; this one has 17/);
    throwsField(() => save(k, salesInput(k, { numberOverride: { number: 'INV 26#1' } })), 'number', /only letters, digits, '\/' and '-' \(not a space, '#'\)/);
    // A purchase is not a GST document of ours: spaces and longer numbers are fine, control characters are not.
    assert.equal(save(k, purchaseInput(k, { numberOverride: { number: 'Purchase book 2026 no. 17 (old series)' } })).number, 'Purchase book 2026 no. 17 (old series)');
    throwsField(() => save(k, purchaseInput(k, { referenceNo: 'SUP-9', numberOverride: { number: 'P\u00071' } })), 'number', /control characters/);
    throwsField(() => save(k, purchaseInput(k, { referenceNo: 'SUP-8', numberOverride: { number: 'x'.repeat(61) } })), 'number', /at most 60 characters/);
    k.t.close();
  });

  it('an override is unique within the financial year for GST invoices, whatever the restart says', () => {
    const k = setupKit({ today: '2027-03-31' });
    // Yearly (default): taken in the FY → CONFLICT; the same number next FY is fine.
    save(k, salesInput(k, { date: '2026-04-10', numberOverride: { number: 'B-1' } }));
    throwsApp(() => save(k, salesInput(k, { date: '2027-03-31', numberOverride: { number: 'B-1' } })), 'CONFLICT', /already used in FY 2026-27/);
    // Monthly with the month in the prefix: another month of the same FY still refuses the same typed number.
    configureSales(k, { numbering_restart: 'monthly', numbering_prefix: 'M-{MM}-' });
    save(k, salesInput(k, { date: '2026-05-10', numberOverride: { number: 'M-X1' } }));
    throwsApp(() => save(k, salesInput(k, { date: '2026-09-10', numberOverride: { number: 'M-X1' } })), 'CONFLICT', /FY 2026-27/);
    // Never restarts, duplicates allowed by the type: still unique within the FY, free in the next FY.
    configureSales(k, { numbering_restart: 'never', numbering_prefix: null, prevent_duplicates: 0 });
    save(k, salesInput(k, { date: '2026-06-01', numberOverride: { number: 'N-1' } }));
    throwsApp(() => save(k, salesInput(k, { date: '2026-07-01', numberOverride: { number: 'N-1' } })), 'CONFLICT', /FY 2026-27/);
    k.t.close();
  });

  it('a non-GST override is unique within its numbering period even when the type allows duplicates', () => {
    const k = setupKit();
    k.t.db.run('UPDATE voucher_types SET prevent_duplicates = 0 WHERE id = :id', { id: k.vt.purchase });
    save(k, purchaseInput(k, { numberOverride: { number: 'P-7' } }));
    throwsApp(() => save(k, purchaseInput(k, { referenceNo: 'SUP-202', numberOverride: { number: 'P-7' } })), 'CONFLICT', /already used in this period/);
    k.t.close();
  });

  it('alter: the override changes the number; the old number is free again; the edit log records numberChange / numberOverride', () => {
    const k = setupKit();
    const a = save(k, salesInput(k));
    const b = save(k, salesInput(k, { numberOverride: { number: 'S-77', reason: 'Paper book' } }));
    const created = k.t.db.get<{ after_json: string }>(`SELECT after_json FROM audit_log WHERE entity_type = 'voucher' AND entity_id = :id AND action = 'create'`, { id: b.id });
    assert.deepEqual(JSON.parse(created?.after_json ?? '{}').numberOverride, { to: 'S-77', next: '2', reason: 'Paper book' });
    const altered = save(k, salesInput(k, { id: a.id, numberOverride: { number: 'S-100', reason: 'Reprinted with the shop prefix' } }));
    assert.equal(altered.number, 'S-100');
    assert.equal(header(k, a.id).number, 'S-100');
    const log = k.t.db.get<{ after_json: string }>(`SELECT after_json FROM audit_log WHERE entity_type = 'voucher' AND entity_id = :id AND action = 'alter' ORDER BY id DESC LIMIT 1`, { id: a.id });
    const after = JSON.parse(log?.after_json ?? '{}');
    assert.deepEqual(after.numberChange, { from: '1', to: 'S-100', reason: 'Reprinted with the shop prefix' });
    assert.equal(after.number, 'S-100');
    // The override never reaches the stored input: a later plain alter keeps S-100 and logs no change.
    const meta = JSON.parse(String(header(k, a.id).meta));
    assert.equal(meta.input.numberOverride, undefined);
    save(k, salesInput(k, { id: a.id, narration: 'later' }));
    assert.equal(header(k, a.id).number, 'S-100');
    const last = k.t.db.get<{ after_json: string }>(`SELECT after_json FROM audit_log WHERE entity_type = 'voucher' AND entity_id = :id ORDER BY id DESC LIMIT 1`, { id: a.id });
    assert.equal(JSON.parse(last?.after_json ?? '{}').numberChange, undefined);
    // Its old number is free again for a typed number.
    assert.equal(save(k, salesInput(k, { numberOverride: { number: '1' } })).number, '1');
    // An override equal to the current number changes nothing and logs nothing about the number.
    save(k, salesInput(k, { id: b.id, numberOverride: { number: 'S-77' } }));
    const same = k.t.db.get<{ after_json: string }>(`SELECT after_json FROM audit_log WHERE entity_type = 'voucher' AND entity_id = :id ORDER BY id DESC LIMIT 1`, { id: b.id });
    assert.equal(JSON.parse(same?.after_json ?? '{}').numberChange, undefined);
    // An alter that keeps the number of another voucher of the FY is a CONFLICT.
    throwsApp(() => save(k, salesInput(k, { id: a.id, numberOverride: { number: 'S-77' } })), 'CONFLICT', /already used in FY 2026-27/);
    k.t.close();
  });

  it('preview shows the override number', () => {
    const k = setupKit();
    assert.equal(previewVoucher(k.t.ctx, salesInput(k, { numberOverride: { number: 'P-9' } })).number, 'P-9');
    k.t.close();
  });
});

describe('GST invoice numbers are unique within the financial year on every save path (D27)', () => {
  it('debit note to a customer is an outward document; a debit note to a supplier is not', () => {
    const k = setupKit();
    k.t.db.run(`UPDATE voucher_types SET numbering_method = 'manual', prevent_duplicates = 0 WHERE id = :id`, { id: k.vt.debit_note });
    const toCustomer = (number: string) => save(k, { voucherTypeId: k.vt.debit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, number, items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] });
    const toSupplier = (number: string) => save(k, { voucherTypeId: k.vt.debit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.supplier, number, items: [{ itemId: k.I.rice, qty: 1, rate: 80 }] });
    toCustomer('DN-1');
    throwsApp(() => toCustomer('DN-1'), 'CONFLICT', /FY 2026-27/);
    toSupplier('PR-1');
    assert.equal(toSupplier('PR-1').number, 'PR-1', 'a purchase return keeps the type rule (duplicates allowed)');
    k.t.close();
  });

  it('a monthly series without the month in the prefix (set before the scheme check) never repeats a number in the FY', () => {
    const k = setupKit();
    configureSales(k, { numbering_restart: 'monthly', numbering_prefix: 'S-' });
    const a = save(k, salesInput(k, { date: '2026-04-30' }));
    const b = save(k, salesInput(k, { date: '2026-05-01' }));
    assert.deepEqual([a.number, b.number], ['S-1', 'S-2'], 'S-1 is taken in the FY, so May skips it');
    // A company without GST keeps the plain monthly restart.
    const n = setupKit({ gst: false });
    configureSales(n, { numbering_restart: 'monthly', numbering_prefix: 'S-' });
    const c = save(n, salesInput(n, { date: '2026-04-30' }));
    const d = save(n, salesInput(n, { date: '2026-05-01' }));
    assert.deepEqual([c.number, d.number], ['S-1', 'S-1']);
    k.t.close();
    n.t.close();
  });

  it('moving an invoice into another financial year where its number is taken is a CONFLICT on the date', () => {
    const k = setupKit({ today: '2027-04-15', booksFrom: '2026-04-01' });
    configureSales(k, { prevent_duplicates: 0 });
    const old = save(k, salesInput(k, { date: '2026-04-15' }));
    save(k, salesInput(k, { date: '2027-04-15' }));
    assert.equal(old.number, '1');
    const err = throwsApp(() => save(k, salesInput(k, { id: old.id, date: '2027-04-16' })), 'CONFLICT', /already used in FY 2027-28/);
    assert.deepEqual((err.details as Array<{ path: string }>).map((d) => d.path), ['date']);
    // Within its own FY the move is fine.
    assert.equal(save(k, salesInput(k, { id: old.id, date: '2026-05-16' })).number, '1');
    k.t.close();
  });
});

describe('vouchers.renumber (change the number of a saved voucher)', () => {
  const rows = (k: Kit, id: number) => ({
    entries: k.t.db.all('SELECT ledger_id, amount, role, gst_duty_head FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no', { id }),
    gst: k.t.db.all('SELECT hsn_sac, rate, taxable_value, cgst, sgst, igst, cess FROM gst_lines WHERE voucher_id = :id ORDER BY line_no', { id }),
    stock: k.t.db.all('SELECT item_id, qty, amount FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no', { id }),
  });
  const updatedAt = (k: Kit, id: number): string => String(header(k, id).updated_at);

  it('changes only the number: ledger entries, stock and GST rows are identical', async () => {
    const k = setupKit();
    const a = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }, { itemId: k.I.rice, qty: 3, rate: 60 }] }));
    const before = rows(k, a.id);
    const r = await k.t.callOk<{ number: string }>(vouchersRoutes, 'vouchers.renumber', { id: a.id, number: 'SHOP/141', reason: 'Paper book', expectedUpdatedAt: updatedAt(k, a.id) });
    assert.equal(r.number, 'SHOP/141');
    assert.deepEqual(rows(k, a.id), before);
    assert.equal(header(k, a.id).number, 'SHOP/141');
    // The party bill follows the new number (nothing settles it).
    assert.deepEqual(bills(k, a.id).map((b) => b.bill_name), ['SHOP/141']);
    k.t.close();
  });

  it('keeps the bill name when a receipt already settles the invoice', async () => {
    const k = setupKit();
    const a = save(k, salesInput(k));
    const total = Math.abs(Number(k.t.db.value('SELECT amount FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :l', { id: a.id, l: k.L.acme })));
    save(k, {
      voucherTypeId: k.vt.receipt,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.acme, amount: -total, billAllocations: [{ refType: 'against', billName: '1', amount: total }] },
        { ledgerId: k.L.bank, amount: total },
      ],
    });
    const r = await k.t.callOk<{ number: string; warnings: Array<{ code: string; level: string; message: string }> }>(vouchersRoutes, 'vouchers.renumber', {
      id: a.id,
      number: 'A-100',
      expectedUpdatedAt: updatedAt(k, a.id),
    });
    assert.equal(r.number, 'A-100');
    assert.deepEqual(bills(k, a.id).map((b) => [b.ref_type, b.bill_name, b.amount]), [['new', '1', total]]);
    assert.ok(r.warnings.some((w) => w.code === 'numbering' && w.level === 'info' && /Bill 1 keeps its name/.test(w.message)), JSON.stringify(r.warnings));
    k.t.close();
  });

  it('refuses cancelled and e-invoiced vouchers, a stale expectedUpdatedAt, and vouchers without their entry details', async () => {
    const k = setupKit({ features: { einvoice: true } });
    const a = save(k, salesInput(k));
    const stale = await k.t.call(vouchersRoutes, 'vouchers.renumber', { id: a.id, number: 'X-1', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    assert.equal(stale.ok ? 'ok' : stale.error.code, 'CONFLICT');
    assert.match(stale.ok ? '' : stale.error.message, /changed by someone else/);
    k.t.db.run(`UPDATE vouchers SET irn_status = 'generated' WHERE id = :id`, { id: a.id });
    const irn = await k.t.call(vouchersRoutes, 'vouchers.renumber', { id: a.id, number: 'X-1', expectedUpdatedAt: updatedAt(k, a.id) });
    assert.match(irn.ok ? '' : irn.error.message, /IRN/);
    k.t.db.run(`UPDATE vouchers SET irn_status = 'pending' WHERE id = :id`, { id: a.id });
    await k.t.callOk(vouchersRoutes, 'vouchers.cancel', { id: a.id, reason: 'Wrong party' });
    const cancelled = await k.t.call(vouchersRoutes, 'vouchers.renumber', { id: a.id, number: 'X-1', expectedUpdatedAt: updatedAt(k, a.id) });
    assert.match(cancelled.ok ? '' : cancelled.error.message, /cancelled voucher cannot be altered/);
    const b = save(k, salesInput(k));
    k.t.db.run('UPDATE vouchers SET meta = NULL WHERE id = :id', { id: b.id });
    const legacy = await k.t.call(vouchersRoutes, 'vouchers.renumber', { id: b.id, number: 'X-2', expectedUpdatedAt: updatedAt(k, b.id) });
    assert.equal(legacy.ok ? 'ok' : legacy.error.code, 'BUSINESS_RULE');
    assert.match(legacy.ok ? '' : legacy.error.message, /Alter the voucher \(Alt\+A\) and change the number there/);
    // Without vouchers.renumber: FORBIDDEN (vouchers.alter alone is not enough).
    const c = save(k, salesInput(k));
    const session = k.t.sessionAs({ permissions: [...ACCOUNTANT_WITHOUT_RENUMBER] });
    const denied = await k.t.call(vouchersRoutes, 'vouchers.renumber', { id: c.id, number: 'X-3', expectedUpdatedAt: updatedAt(k, c.id) }, { session });
    assert.equal(denied.ok ? 'ok' : denied.error.code, 'FORBIDDEN');
    const noAlter = await k.t.call(vouchersRoutes, 'vouchers.renumber', { id: c.id, number: 'X-3', expectedUpdatedAt: updatedAt(k, c.id) }, { session: k.t.sessionAs({ permissions: ['vouchers.view'] }) });
    assert.equal(noAlter.ok ? 'ok' : noAlter.error.code, 'FORBIDDEN');
    k.t.close();
  });

  it('vouchers.numberCheck: format problems, taken in the FY (own number excluded), sequence and scope', async () => {
    const k = setupKit();
    configureSales(k, { numbering_prefix: 'INV/{FY}/', numbering_width: 4 });
    const a = save(k, salesInput(k));
    assert.equal(a.number, 'INV/26-27/0001');
    type R = { ok: boolean; taken: boolean; problems: string[]; seq: number | null; scopeLabel: string };
    const check = (number: string, excludeId?: number) =>
      k.t.callOk<R>(vouchersRoutes, 'vouchers.numberCheck', { voucherTypeId: k.vt.sales, date: k.t.today, number, ...(excludeId ? { excludeId } : {}) });
    assert.deepEqual(await check('INV/26-27/0141'), { ok: true, taken: false, problems: [], seq: 141, scopeLabel: 'FY 2026-27' });
    assert.deepEqual(await check('INV/26-27/0001'), { ok: false, taken: true, problems: [], seq: 1, scopeLabel: 'FY 2026-27' });
    assert.equal((await check('INV/26-27/0001', a.id)).ok, true);
    const bad = await check('INV 2026-27/00001');
    assert.equal(bad.ok, false);
    assert.equal(bad.problems.length, 2, JSON.stringify(bad.problems));
    // Non-GST type: its numbering period, any characters.
    const p = await k.t.callOk<R>(vouchersRoutes, 'vouchers.numberCheck', { voucherTypeId: k.vt.payment, date: k.t.today, number: 'Cash book p.12' });
    assert.deepEqual(p, { ok: true, taken: false, problems: [], seq: null, scopeLabel: 'FY 2026-27' });
    k.t.db.run(`UPDATE voucher_types SET numbering_restart = 'monthly' WHERE id = :id`, { id: k.vt.payment });
    assert.equal((await k.t.callOk<R>(vouchersRoutes, 'vouchers.numberCheck', { voucherTypeId: k.vt.payment, date: k.t.today, number: '1' })).scopeLabel, 'Apr 2026');
    k.t.close();
  });
});

// ───────────────────────────── WP-04 review: regressions ─────────────────────────────

describe('number override: review regressions', () => {
  it('an override repeating the voucher`s own number cannot carry it into a financial year where it is taken', () => {
    const k = setupKit({ today: '2027-04-15', booksFrom: '2026-04-01' });
    configureSales(k, { prevent_duplicates: 0 });
    const old = save(k, salesInput(k, { date: '2026-04-15' }));
    save(k, salesInput(k, { date: '2027-04-15' }));
    const err = throwsApp(() => save(k, salesInput(k, { id: old.id, date: '2027-04-16', numberOverride: { number: '1' } })), 'CONFLICT', /already used in FY 2027-28/);
    assert.deepEqual((err.details as Array<{ path: string }>).map((d) => d.path), ['date']);
    // Within its own FY: saved, number kept, nothing about the number in the edit log.
    assert.equal(save(k, salesInput(k, { id: old.id, date: '2026-05-16', numberOverride: { number: '1' } })).number, '1');
    k.t.close();
  });

  it('after a typed number changes, a later Alter sending the voucher as stored keeps the new number', async () => {
    const k = setupKit();
    configureSales(k, { numbering_method: 'manual' });
    const a = save(k, salesInput(k, { number: 'A-1' }));
    await k.t.callOk(vouchersRoutes, 'vouchers.renumber', { id: a.id, number: 'A-9', reason: 'Paper book', expectedUpdatedAt: String(header(k, a.id).updated_at) });
    // What the Alter screen loads (vouchers.get › input) and sends back unchanged.
    const detail = await k.t.callOk<{ input: Record<string, unknown> }>(vouchersRoutes, 'vouchers.get', { id: a.id });
    assert.equal(detail.input.number, 'A-9');
    await k.t.callOk(vouchersRoutes, 'vouchers.save', { ...detail.input, narration: 'later', acknowledgeWarnings: true });
    assert.equal(header(k, a.id).number, 'A-9');
    k.t.close();
  });

  it('previews (vouchers.nextNumber, preview) show what the save allocates for a legacy monthly GST series', () => {
    const k = setupKit();
    configureSales(k, { numbering_restart: 'monthly', numbering_prefix: 'S-' });
    save(k, salesInput(k, { date: '2026-04-30' }));
    assert.equal(nextVoucherNumber(k.t.ctx, k.vt.sales, '2026-05-01'), 'S-2');
    assert.equal(previewVoucher(k.t.ctx, salesInput(k, { date: '2026-05-01' })).number, 'S-2');
    assert.equal(save(k, salesInput(k, { date: '2026-05-01' })).number, 'S-2');
    k.t.close();
  });

  it('vouchers.numberCheck applies the save`s rule to a debit note: supplier (period), customer (FY), unknown party (both)', async () => {
    const k = setupKit({ today: '2027-04-15', booksFrom: '2026-04-01' });
    k.t.db.run(`UPDATE voucher_types SET numbering_method = 'manual', numbering_restart = 'never', prevent_duplicates = 0 WHERE id = :id`, { id: k.vt.debit_note });
    const dn = (number: string, partyLedgerId: number, itemId: number, date: string) =>
      save(k, { voucherTypeId: k.vt.debit_note, date, mode: 'item_invoice', partyLedgerId, number, items: [{ itemId, qty: 1, rate: 80 }] });
    dn('PR-1', k.L.supplier, k.I.rice, '2026-06-01');
    type R = { ok: boolean; taken: boolean; scopeLabel: string };
    const check = (extra: Record<string, unknown>) =>
      k.t.callOk<R>(vouchersRoutes, 'vouchers.numberCheck', { voucherTypeId: k.vt.debit_note, date: k.t.today, number: 'PR-1', ...extra });
    // To a supplier an override is unique in its period — all years for this series — as the save says.
    assert.deepEqual(await check({ partyLedgerId: k.L.supplier, mode: 'item_invoice' }), { ok: false, taken: true, problems: [], seq: null, scopeLabel: 'All years' });
    throwsApp(() => save(k, { voucherTypeId: k.vt.debit_note, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.supplier, number: 'X', items: [{ itemId: k.I.rice, qty: 1, rate: 80 }], numberOverride: { number: 'PR-1' } }), 'CONFLICT', /already used/);
    // To a customer: an outward document, unique within FY 2027-28 only — free.
    assert.deepEqual(await check({ partyLedgerId: k.L.acme, mode: 'item_invoice' }), { ok: true, taken: false, problems: [], seq: null, scopeLabel: 'FY 2027-28' });
    // Party unknown: the stricter answer.
    assert.equal((await check({})).taken, true);
    // The voucher being altered gives its own party.
    const cust = dn('DN-7', k.L.acme, k.I.mixer, k.t.today);
    assert.equal((await check({ excludeId: cust.id })).ok, true);
    k.t.close();
  });
});
