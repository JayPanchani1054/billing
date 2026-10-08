/**
 * Regression tests from the adversarial review of the posting engine: HSN under the ₹5 crore regime,
 * deductions in accounting invoices, invoice lines that are not part of an invoice's value, unit
 * decimals, inactive masters on alter, back-dated work (alter / cancel / delete), optimistic
 * concurrency on cancel / delete / optional, billed delivery notes, bank links on delete / cancel,
 * guard paths and duplicates of post-dated vouchers.
 * Company: Maharashtra (27), working date 15-Apr-2026, round off to the nearest rupee. Amounts in paise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput, VoucherPreview } from '../../../shared/types/vouchers.ts';
import { getVoucher } from './queries.ts';
import { vouchersRoutes } from './routes.ts';
import { cancelVoucher, deleteVoucher, duplicateVoucher, previewVoucher, saveVoucher, setVoucherOptional } from './service.ts';
import { entryMap, entrySum, gstLines, ruleDetails, salesInput, save, setupKit, stockOf, throwsApp, throwsField, type Kit } from './testkit.ts';

const setHsnDigits = (k: Kit, digits: number): void => {
  k.t.db.run(`UPDATE settings SET value = json_set(value, '$.gst.hsnDigits', :d) WHERE key = 'config'`, { d: digits });
};

describe('HSN under Notification 78/2020', () => {
  it('above ₹5 crore turnover (6 digits) HSN is material on B2C invoices too; up to ₹5 crore it is informational', () => {
    const k = setupKit();
    const plain = k.t.addStockItem({ name: 'Plain Item', gstRate: 18, openingQty: 10, openingRate: 10 });
    // Walk-in (B2C), Mixer HSN 8509 (4 digits) 5 × ₹200 and a line without HSN.
    const b2c = salesInput(k, { partyLedgerId: k.L.walkin, items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }, { itemId: plain, qty: 1, rate: 100 }] });
    assert.deepEqual(
      previewVoucher(k.t.ctx, b2c).warnings.map((w) => [w.code, w.level, w.path]),
      [['gst_missing_hsn', 'info', 'items[1]']],
      '4-digit regime: 8509 is enough, the missing HSN is only informational on B2C',
    );
    setHsnDigits(k, 6);
    const p = previewVoucher(k.t.ctx, b2c);
    assert.deepEqual(p.warnings.map((w) => [w.code, w.level, w.path, w.message]), [
      ['gst_missing_hsn', 'confirm', 'items[0]', 'Line 1 (Mixer Grinder): HSN/SAC 8509 has 4 digits; GST returns need at least 6 (F12 › GST › HSN digits).'],
      [
        'gst_missing_hsn',
        'confirm',
        'items[1]',
        'Line 2 (Plain Item): HSN/SAC code is required on every invoice when turnover is above ₹5 crore (F12 › GST › HSN digits: 6).',
      ],
    ]);
    // Before the fix both were 'info' and the invoice saved without a question.
    const err = throwsApp(() => saveVoucher(k.t.ctx, b2c), 'BUSINESS_RULE', /Please confirm 2 warnings/);
    assert.equal(ruleDetails(err).needsConfirmation, true);
    // Purchases are not checked (the supplier's invoice is what it is).
    const pur = previewVoucher(k.t.ctx, { voucherTypeId: k.vt.purchase, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.supplier, referenceNo: 'S-1', items: [{ itemId: plain, qty: 1, rate: 100 }] });
    assert.deepEqual(pur.warnings.filter((w) => w.code === 'gst_missing_hsn'), []);
    k.t.close();
  });
});

describe('accounting invoice deductions', () => {
  it('a negative non-GST expense line (discount) is applied after tax, not reported as a negative non-GST supply', () => {
    const k = setupKit();
    // Bangalore Retail (29) → inter-state: Consultancy ₹100.00 @18% IGST = ₹18.00; discount ₹5.00 after tax.
    // G = 100.00 + 18.00 − 5.00 = ₹113.00 (whole rupees, no round off).
    const input: VoucherInput = {
      voucherTypeId: k.vt.sales,
      date: k.t.today,
      mode: 'accounting_invoice',
      partyLedgerId: k.L.blr,
      ledgers: [{ ledgerId: k.L.consult, amount: 10000 }, { ledgerId: k.L.discount, amount: -500 }],
    };
    const p = previewVoucher(k.t.ctx, input);
    // Before the fix the discount became a non-GST line of −₹5.00 with two material warnings
    // ("Taxable value at 0% is negative", HSN required on the discount).
    assert.deepEqual(p.warnings, []);
    assert.equal(p.totals.grandTotal, 11300);
    const res = saveVoucher(k.t.ctx, input);
    assert.deepEqual(entryMap(k, res.id), { 'Bangalore Retail': 11300, 'Consultancy Income': -10000, 'Discount Allowed': 500, 'Output IGST': -1800 });
    assert.equal(entrySum(k, res.id), 0);
    assert.deepEqual(gstLines(k, res.id).map((g) => [g.ledger_id, g.taxable_value, g.igst]), [[k.L.consult, 10000, 1800]]);
    k.t.close();
  });
});

describe('invoice lines that are not part of the invoice value', () => {
  it('cash/bank and customer/supplier ledgers are refused as invoice lines and as the sales ledger', () => {
    const k = setupKit();
    // Before the fix a Cash line of ₹10.00 on a sale posted Cr Cash ₹10.00 and Dr Acme ₹10.00 more.
    throwsField(() => previewVoucher(k.t.ctx, salesInput(k, { ledgers: [{ ledgerId: k.L.cash, amount: 1000 }] })), 'ledgers[0].ledgerId', /Cash is a cash or bank ledger/);
    throwsField(() => previewVoucher(k.t.ctx, salesInput(k, { ledgers: [{ ledgerId: k.L.walkin, amount: 1000 }] })), 'ledgers[0].ledgerId', /Walk-in Customer is a customer\/supplier ledger/);
    throwsField(
      () => previewVoucher(k.t.ctx, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 1, rate: 10, ledgerId: k.L.bank }] })),
      'items[0].ledgerId',
      /HDFC Bank cannot be used as the sales ledger/,
    );
    k.t.close();
  });
});

describe('quantities follow the unit’s decimal places', () => {
  it('Nos takes whole numbers, Kg up to 3 decimals; the error points at the cell', () => {
    const k = setupKit();
    const sugar = k.t.addStockItem({ name: 'Sugar', unit: 'Kg', gstRate: 5, hsnSac: '1701', openingQty: 100, openingRate: 40 });
    throwsField(
      () => previewVoucher(k.t.ctx, salesInput(k, { items: [{ itemId: k.I.rice, qty: 1, rate: 50 }, { itemId: k.I.mixer, qty: 1.5, rate: 200 }] })),
      'items[1].qty',
      /Line 2 \(Mixer Grinder\): quantity 1\.5 is not valid — Nos allows whole numbers only/,
    );
    throwsField(() => previewVoucher(k.t.ctx, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 2, billedQty: 1.5, rate: 200 }] })), 'items[0].billedQty');
    throwsField(() => previewVoucher(k.t.ctx, salesInput(k, { items: [{ itemId: sugar, qty: 1.2555, rate: 40 }] })), 'items[0].qty', /Kg allows at most 3 decimal places/);
    throwsField(
      () => previewVoucher(k.t.ctx, { voucherTypeId: k.vt.physical_stock, date: k.t.today, mode: 'inventory', items: [{ itemId: k.I.mixer, qty: 49.5, rate: 0 }] }),
      'items[0].qty',
    );
    // 1.255 Kg × ₹40 = ₹50.20; CGST 2.5% = 1.255 → ₹1.26, SGST ₹1.26 → ₹52.72 → rounded ₹53.00 (round off ₹0.28 Cr).
    const ok = save(k, salesInput(k, { items: [{ itemId: sugar, qty: 1.255, rate: 40 }] }));
    assert.equal(k.t.db.value('SELECT qty FROM inventory_entries WHERE voucher_id = :id', { id: ok.id }), -1.255);
    assert.deepEqual(entryMap(k, ok.id), { 'Acme Traders': 5300, Sales: -5020, 'Output CGST': -126, 'Output SGST/UTGST': -126, 'Round Off': -28 });
    assert.equal(entrySum(k, ok.id), 0);
    k.t.close();
  });
});

describe('inactive masters on alter', () => {
  it('an alter keeps the inactive masters the voucher already uses but cannot add new ones', () => {
    const k = setupKit();
    const pay = save(k, { voucherTypeId: k.vt.payment, date: k.t.today, mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 5000 }, { ledgerId: k.L.bank, amount: -5000 }] });
    const sale = save(k, salesInput(k));
    k.t.db.run('UPDATE ledgers SET is_active = 0 WHERE id IN (:a, :b)', { a: k.L.rent, b: k.L.capital });
    k.t.db.run('UPDATE stock_items SET is_active = 0 WHERE id IN (:a, :b)', { a: k.I.mixer, b: k.I.rice });
    // Keeping them is fine.
    save(k, { ...getVoucher(k.t.db, pay.id).input, narration: 'kept' });
    save(k, { ...getVoucher(k.t.db, sale.id).input, narration: 'kept' });
    // Before the fix any inactive master could be added to an existing voucher.
    throwsField(
      () =>
        save(k, {
          ...getVoucher(k.t.db, pay.id).input,
          ledgers: [{ ledgerId: k.L.rent, amount: 3000 }, { ledgerId: k.L.capital, amount: 2000 }, { ledgerId: k.L.bank, amount: -5000 }],
        }),
      'ledgers[1].ledgerId',
      /Ledger Owner Capital is inactive/,
    );
    throwsField(
      () => save(k, { ...getVoucher(k.t.db, sale.id).input, items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }, { itemId: k.I.rice, qty: 1, rate: 50 }] }),
      'items[1].itemId',
      /Stock item Rice Bag is inactive/,
    );
    k.t.close();
  });
});

describe('back-dated work needs vouchers.backdate', () => {
  it('altering, cancelling or deleting a voucher dated before today is refused without it; preview says so on the date', async () => {
    const k = setupKit();
    const old = save(k, salesInput(k, { date: '2026-04-14' }));
    const fresh = save(k, salesInput(k));
    const editor = k.t.sessionAs({ permissions: ['vouchers.view', 'vouchers.create', 'vouchers.alter', 'vouchers.delete'] });

    // Before the fix moving yesterday's invoice to today was allowed (only the new date was checked).
    const moved = await k.t.call(vouchersRoutes, 'vouchers.save', { ...getVoucher(k.t.db, old.id).input, date: k.t.today, acknowledgeWarnings: true }, { session: editor });
    assert.equal(moved.ok ? 'ok' : moved.error.code, 'FORBIDDEN');
    assert.match(moved.ok ? '' : moved.error.message, /permission to alter vouchers dated before today \(15-Apr-2026\); this voucher is dated 14-Apr-2026/);
    const cancel = await k.t.call(vouchersRoutes, 'vouchers.cancel', { id: old.id, reason: 'x' }, { session: editor });
    assert.equal(cancel.ok ? 'ok' : cancel.error.code, 'FORBIDDEN');
    const del = await k.t.call(vouchersRoutes, 'vouchers.delete', { id: old.id }, { session: editor });
    assert.equal(del.ok ? 'ok' : del.error.code, 'FORBIDDEN');
    assert.equal(k.t.db.value('SELECT is_cancelled FROM vouchers WHERE id = :id', { id: old.id }), 0);

    const pv = (await k.t.callOk<VoucherPreview>(vouchersRoutes, 'vouchers.preview', { ...getVoucher(k.t.db, old.id).input, date: k.t.today }, { session: editor })).warnings[0];
    assert.deepEqual([pv?.code, pv?.level, pv?.blocking, pv?.path], ['backdate_not_allowed', 'block', true, 'date']);
    const own = await k.t.callOk<VoucherPreview>(vouchersRoutes, 'vouchers.preview', getVoucher(k.t.db, fresh.id).input, { session: editor });
    assert.equal(own.warnings.some((w) => w.code === 'backdate_not_allowed'), false);

    // Today's voucher: the same user may cancel it.
    const ok = await k.t.call(vouchersRoutes, 'vouchers.cancel', { id: fresh.id, reason: 'wrong party' }, { session: editor });
    assert.equal(ok.ok, true);
    k.t.close();
  });
});

describe('optimistic concurrency on cancel, delete and optional', () => {
  it('a stale expectedUpdatedAt is a CONFLICT and changes nothing', () => {
    const k = setupKit();
    const a = save(k, salesInput(k));
    const stale = '2000-01-01T00:00:00.000Z';
    throwsApp(() => cancelVoucher(k.t.ctx, a.id, 'dup', stale), 'CONFLICT', /changed by someone else/);
    throwsApp(() => deleteVoucher(k.t.ctx, a.id, undefined, stale), 'CONFLICT');
    throwsApp(() => setVoucherOptional(k.t.ctx, a.id, true, true, stale), 'CONFLICT');
    assert.deepEqual(k.t.db.get('SELECT is_cancelled, is_optional FROM vouchers WHERE id = :id', { id: a.id }), { is_cancelled: 0, is_optional: 0 });
    // The current stamp works.
    const res = cancelVoucher(k.t.ctx, a.id, 'dup', getVoucher(k.t.db, a.id).updatedAt);
    assert.equal(res.id, a.id);
    k.t.close();
  });
});

describe('billed delivery note quantities', () => {
  it('a billed note cannot be reduced below the quantity its invoices bill', () => {
    const k = setupKit();
    const dnInput: VoucherInput = { voucherTypeId: k.vt.delivery_note, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }] };
    const dn = save(k, dnInput);
    save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 3, rate: 200, trackingRef: '1' }] }));
    assert.equal(stockOf(k, k.I.mixer), 45); // 50 − 5 delivered; the invoice moves nothing
    // Before the fix the note could go down to 2: stock 48, although 3 were sold and billed.
    throwsApp(
      () => save(k, { ...getVoucher(k.t.db, dn.id).input, items: [{ itemId: k.I.mixer, qty: 2, rate: 200 }] }),
      'BUSINESS_RULE',
      /3 Nos of Mixer Grinder on this note has been billed \(first in Sales 1 dated 15-Apr-2026\); the note cannot be reduced to 2 Nos/,
    );
    assert.equal(stockOf(k, k.I.mixer), 45);
    save(k, { ...getVoucher(k.t.db, dn.id).input, items: [{ itemId: k.I.mixer, qty: 3, rate: 200 }] });
    assert.equal(stockOf(k, k.I.mixer), 47); // 50 − 3
    k.t.close();
  });
});

describe('bank statement matches on delete and cancel', () => {
  it('statement lines matched to a deleted or cancelled voucher go back to unmatched', () => {
    const k = setupKit();
    const batch = k.t.db.run(`INSERT INTO import_batches (kind, imported_at) VALUES ('bank_statement', :ts)`, { ts: k.t.clock.now().toISOString() }).lastInsertRowid;
    const receiptWithMatch = (amount: number): { id: number; line: number } => {
      const r = save(k, { voucherTypeId: k.vt.receipt, date: k.t.today, mode: 'ledger', ledgers: [{ ledgerId: k.L.bank, amount }, { ledgerId: k.L.acme, amount: -amount }] });
      const entry = k.t.db.value<number>('SELECT id FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :b', { id: r.id, b: k.L.bank });
      const line = k.t.db.run(
        `INSERT INTO bank_statement_lines (batch_id, ledger_id, txn_date, amount, status, matched_entry_id) VALUES (:b, :l, :d, :a, 'matched', :e)`,
        { b: batch, l: k.L.bank, d: k.t.today, a: amount, e: entry ?? null },
      ).lastInsertRowid;
      return { id: r.id, line };
    };
    const a = receiptWithMatch(10000);
    const b = receiptWithMatch(20000);
    cancelVoucher(k.t.ctx, a.id, 'bounced');
    deleteVoucher(k.t.ctx, b.id, 'entered twice');
    const status = (line: number) => k.t.db.get('SELECT status, matched_entry_id FROM bank_statement_lines WHERE id = :id', { id: line });
    assert.deepEqual(status(a.line), { status: 'unmatched', matched_entry_id: null });
    assert.deepEqual(status(b.line), { status: 'unmatched', matched_entry_id: null });
    k.t.close();
  });
});

describe('warning paths and duplicates', () => {
  it('negative cash points at the cash line', () => {
    const k = setupKit();
    // Cash has no opening balance: paying ₹50.00 rent in cash takes it to −₹50.00.
    const p = previewVoucher(k.t.ctx, { voucherTypeId: k.vt.payment, date: k.t.today, mode: 'ledger', ledgers: [{ ledgerId: k.L.rent, amount: 5000 }, { ledgerId: k.L.cash, amount: -5000 }] });
    assert.deepEqual(p.warnings.map((w) => [w.code, w.level, w.path]), [['negative_cash', 'confirm', 'ledgers[1].ledgerId']]);
    k.t.close();
  });

  it('a duplicate of a post-dated voucher is dated today and not post-dated', () => {
    const k = setupKit();
    const pdc = save(k, { voucherTypeId: k.vt.receipt, date: '2026-05-10', isPostDated: true, mode: 'ledger', ledgers: [{ ledgerId: k.L.bank, amount: 5000 }, { ledgerId: k.L.acme, amount: -5000 }] });
    const copy = duplicateVoucher(k.t.ctx, pdc.id);
    assert.equal(copy.date, k.t.today);
    assert.equal(copy.isPostDated, undefined);
    k.t.close();
  });
});

describe('GST engine warnings point at the input line', () => {
  it('item and ledger lines get items[i] / ledgers[i]; a ledger line is named by its ledger', () => {
    const k = setupKit();
    // Item mode: Rice at a 0% override (engine line 1), then the consultancy ledger line (engine line 2) at 12%.
    const p = previewVoucher(k.t.ctx, salesInput(k, {
      items: [{ itemId: k.I.rice, qty: 1, rate: 80, gstRateOverride: 0 }],
      ledgers: [{ ledgerId: k.L.consult, amount: 10000, gst: { rate: 12 } }],
    }));
    const gst = p.warnings.filter((w) => w.code === 'gst').map((w) => [w.path, w.level, w.message]);
    assert.deepEqual(gst, [
      ['items[0]', 'confirm', 'Line 1 (Rice Bag): GST rate is 0% on a taxable line; mark it nil-rated/exempt or set the rate'],
      ['ledgers[0]', 'info', 'Consultancy Income: the 12% slab was largely merged into 5%/18% from 22-Sep-2025; check the item\'s GST rate'],
    ]);
    k.t.close();
  });
});

describe('post-dated and optional flags reach every child row', () => {
  it('ledger entries, bills, cost allocations, inventory and gst_lines carry is_post_dated and the books/stock flag', () => {
    const k = setupKit({ features: { costCentres: true } });
    const ts = k.t.clock.now().toISOString();
    const centre = k.t.db.run('INSERT INTO cost_centres (guid, name, category_id, created_at, updated_at) VALUES (:g, :n, :c, :ts, :ts)', {
      g: 'cc-1',
      n: 'Mumbai Branch',
      c: k.t.ids.costCategoryId,
      ts,
    }).lastInsertRowid;
    const packing = k.t.addLedger({ name: 'Packing Charges', group: 'INDIRECT_INCOMES', costCentres: true });
    // Mixer 1 × ₹200 = ₹200.00 + CGST 9% ₹18.00 + SGST ₹18.00 + packing ₹5.00 (non-GST, after tax) = ₹241.00.
    const input = salesInput(k, {
      date: '2026-05-10',
      isPostDated: true,
      items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }],
      ledgers: [{ ledgerId: packing, amount: 500, costAllocations: [{ costCentreId: centre, amount: 500 }] }],
    });
    const res = save(k, input);
    assert.deepEqual(entryMap(k, res.id), { 'Acme Traders': 24100, Sales: -20000, 'Packing Charges': -500, 'Output CGST': -1800, 'Output SGST/UTGST': -1800 });
    const flags = (): Record<string, unknown> => ({
      ledger: k.t.db.get('SELECT MIN(is_post_dated) AS pdc, MIN(affects_books) AS f, COUNT(*) AS n FROM ledger_entries WHERE voucher_id = :id', { id: res.id }),
      bills: k.t.db.get('SELECT MIN(is_post_dated) AS pdc, MIN(affects_books) AS f, COUNT(*) AS n FROM bill_allocations WHERE voucher_id = :id', { id: res.id }),
      costs: k.t.db.get('SELECT MIN(is_post_dated) AS pdc, MIN(affects_books) AS f, COUNT(*) AS n FROM cost_allocations WHERE voucher_id = :id', { id: res.id }),
      stock: k.t.db.get('SELECT MIN(is_post_dated) AS pdc, MIN(affects_stock) AS f, COUNT(*) AS n FROM inventory_entries WHERE voucher_id = :id', { id: res.id }),
      gst: k.t.db.get('SELECT MIN(is_post_dated) AS pdc, MIN(affects_books) AS f, COUNT(*) AS n FROM gst_lines WHERE voucher_id = :id', { id: res.id }),
    });
    const all = (pdc: number, f: number) => ({
      ledger: { pdc, f, n: 5 },
      bills: { pdc, f, n: 1 },
      costs: { pdc, f, n: 1 },
      stock: { pdc, f, n: 1 },
      gst: { pdc, f, n: 1 },
    });
    assert.deepEqual(flags(), all(1, 1));
    assert.equal(k.t.db.value('SELECT amount FROM cost_allocations WHERE voucher_id = :id', { id: res.id }), -500);
    setVoucherOptional(k.t.ctx, res.id, true);
    assert.deepEqual(flags(), all(1, 0));
    k.t.close();
  });
});

describe('GST engine warnings on lines whose names contain brackets or colons', () => {
  it('still point at the input cell and name the ledger', () => {
    const k = setupKit();
    // Before the fix the label pattern stopped at the first ")" so "Basmati (25 kg)" lost its path, and the
    // ledger line kept the engine's cross-numbered "Line 2 (…)" label.
    const bag = k.t.addStockItem({ name: 'Basmati (25 kg)', gstRate: 5, hsnSac: '1006', openingQty: 10, openingRate: 50 });
    const retainer = k.t.addLedger({ name: 'Consulting (Retainer): Monthly', group: 'DIRECT_INCOMES', gstRate: 18, hsnSac: '998311', supplyType: 'services' });
    const p = previewVoucher(k.t.ctx, salesInput(k, {
      items: [{ itemId: bag, qty: 1, rate: 80, gstRateOverride: 0 }],
      ledgers: [{ ledgerId: retainer, amount: 10000, gst: { rate: 12 } }],
    }));
    assert.deepEqual(p.warnings.filter((w) => w.code === 'gst').map((w) => [w.path, w.level, w.message]), [
      ['items[0]', 'confirm', 'Line 1 (Basmati (25 kg)): GST rate is 0% on a taxable line; mark it nil-rated/exempt or set the rate'],
      ['ledgers[0]', 'info', 'Consulting (Retainer): Monthly: the 12% slab was largely merged into 5%/18% from 22-Sep-2025; check the item\'s GST rate'],
    ]);
    k.t.close();
  });
});
