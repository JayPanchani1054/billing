/**
 * 2.2 line descriptions: the text typed under a voucher line, kept with that voucher only (never the
 * stock item master's description) — item lines' `description` → inventory_entries.description, ledger
 * ("Particulars") lines' `narration` → ledger_entries.narration. Stored in every mode, returned by
 * vouchers.get / vouchers.preview / vouchers.trackingRefs, kept by the input fallback of vouchers saved
 * without their input, and recorded in the edit log.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TrackingDoc, VoucherDetail, VoucherInput, VoucherPreview, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { verifyAuditChain } from '../../lib/audit.ts';
import { entityHistory } from '../security/auditlog.ts';
import { diffJson } from '../security/diff.ts';
import { getVoucher, trackingRefs } from './queries.ts';
import { vouchersRoutes } from './routes.ts';
import { cancelVoucher, deleteVoucher, duplicateVoucher, loadVoucherRow, previewVoucher, setVoucherOptional, snapshotFromDb } from './service.ts';
import { entryMap, salesInput, save, setupKit, type Kit } from './testkit.ts';

/** inventory_entries of a voucher: [line_no, description]. */
const itemTexts = (k: Kit, id: number) =>
  k.t.db
    .all<{ line_no: number; description: string | null }>('SELECT line_no, description FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no', { id })
    .map((r) => [r.line_no, r.description]);

/** ledger_entries of a voucher: ledger name → narration. */
const entryTexts = (k: Kit, id: number): Record<string, string | null> =>
  Object.fromEntries(
    k.t.db
      .all<{ name: string; narration: string | null }>(
        'SELECT l.name, le.narration FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id WHERE le.voucher_id = :id ORDER BY le.line_no',
        { id },
      )
      .map((r) => [r.name, r.narration]),
  );

const storedMeta = (k: Kit, id: number): { input: VoucherInput } => JSON.parse(String(k.t.db.value('SELECT meta FROM vouchers WHERE id = :id', { id }))) as { input: VoucherInput };

const audits = (k: Kit, id: number) =>
  k.t.db
    .all<{ action: string; before_json: string | null; after_json: string | null }>(
      `SELECT action, before_json, after_json FROM audit_log WHERE entity_type = 'voucher' AND entity_id = :id ORDER BY id`,
      { id },
    )
    .map((a) => ({ action: a.action, before: JSON.parse(a.before_json ?? 'null') as Record<string, unknown> | null, after: JSON.parse(a.after_json ?? 'null') as Record<string, unknown> | null }));

/** The voucher's edit history (Alt+H) as [action, summary], oldest first. */
const history = (k: Kit, id: number) => entityHistory(k.t.db, { entityType: 'voucher', entityId: id }).versions.map((v) => [v.action, v.summary]);

describe('item line descriptions', () => {
  it('item invoice: stored on the line, returned by vouchers.get and vouchers.preview — trimmed, inner line breaks kept, never the master text', async () => {
    const k = setupKit();
    // The masters' own descriptions are not the voucher's: a line without text has none.
    k.t.db.run(`UPDATE stock_items SET description = 'Basmati, 25 kg bag' WHERE id = :id`, { id: k.I.rice });
    const input = salesInput(k, {
      items: [
        { itemId: k.I.mixer, qty: 5, rate: 200, description: '  Blue colour\nSerial nos. 1001–1005  ' },
        { itemId: k.I.rice, qty: 2, rate: 100 },
      ],
    });
    const text = 'Blue colour\nSerial nos. 1001–1005';
    const res = await k.t.callOk<VoucherSaveResult>(vouchersRoutes, 'vouchers.save', { ...input, acknowledgeWarnings: true });
    assert.deepEqual(itemTexts(k, res.id), [[1, text], [2, null]]);

    const d = await k.t.callOk<VoucherDetail>(vouchersRoutes, 'vouchers.get', { id: res.id });
    assert.deepEqual(d.inventory.map((l) => [l.itemName, l.description]), [['Mixer Grinder', text], ['Rice Bag', null]]);
    assert.equal(d.input.items?.[0].description, text, 'the voucher as entered, trimmed by the route');
    assert.equal(d.input.items?.[1].description, undefined);

    // GST rows (e-invoice PrdDesc, e-way bill, GSTR-1 HSN) keep the master names.
    assert.deepEqual(
      k.t.db.all<{ description: string }>('SELECT description FROM gst_lines WHERE voucher_id = :id ORDER BY line_no', { id: res.id }).map((g) => g.description),
      ['Mixer Grinder', 'Rice Bag'],
    );
    assert.deepEqual(d.gstLines.map((g) => g.description), ['Mixer Grinder', 'Rice Bag']);

    const p = await k.t.callOk<VoucherPreview>(vouchersRoutes, 'vouchers.preview', input);
    assert.deepEqual(p.inventory.map((l) => l.description), [text, null]);
    // The engine trims too (callers that skip the route schema, e.g. imports or recurring vouchers).
    assert.equal(previewVoucher(k.t.ctx, input).inventory[0].description, text);
    k.t.close();
  });

  it('inventory mode: a delivery note keeps each line its own description', () => {
    const k = setupKit();
    const res = save(k, {
      voucherTypeId: k.vt.delivery_note,
      date: k.t.today,
      mode: 'inventory',
      partyLedgerId: k.L.acme,
      items: [
        { itemId: k.I.mixer, qty: 2, rate: 200, description: 'Demo pieces' },
        { itemId: k.I.mixer, qty: 3, rate: 200 },
        { itemId: k.I.rice, qty: 1, rate: 50, description: 'Sample bag' },
      ],
    });
    assert.deepEqual(itemTexts(k, res.id), [[1, 'Demo pieces'], [2, null], [3, 'Sample bag']]);
    assert.deepEqual(getVoucher(k.t.db, res.id).inventory.map((l) => l.description), ['Demo pieces', null, 'Sample bag']);
    k.t.close();
  });

  it('stock journal (both sides) and physical stock keep their line descriptions', () => {
    const k = setupKit();
    const sj = save(k, {
      voucherTypeId: k.vt.stock_journal,
      date: k.t.today,
      mode: 'inventory',
      items: [
        { itemId: k.I.rice, qty: 10, rate: 50, isConsumption: true, description: 'Torn bags' },
        { itemId: k.I.mixer, qty: 1, rate: 500, description: 'Assembled from spares' },
      ],
    });
    assert.deepEqual(
      k.t.db.all<{ qty: number; description: string | null }>('SELECT qty, description FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no', { id: sj.id }).map((r) => [r.qty, r.description]),
      [[-10, 'Torn bags'], [1, 'Assembled from spares']],
    );
    assert.deepEqual(getVoucher(k.t.db, sj.id).inventory.map((l) => [l.isConsumption, l.description]), [[true, 'Torn bags'], [false, 'Assembled from spares']]);

    // Book 90 rice after the journal; counted 88 → adjustment −2, with the counter's note.
    const ps = save(k, { voucherTypeId: k.vt.physical_stock, date: k.t.today, mode: 'inventory', items: [{ itemId: k.I.rice, qty: 88, rate: 50, description: 'Counted in rack B' }] });
    assert.deepEqual(
      k.t.db.all<{ qty: number; description: string | null }>('SELECT qty, description FROM inventory_entries WHERE voucher_id = :id', { id: ps.id }).map((r) => [r.qty, r.description]),
      [[-2, 'Counted in rack B']],
    );
    assert.equal(getVoucher(k.t.db, ps.id).inventory[0].description, 'Counted in rack B');
    k.t.close();
  });
});

describe('ledger line descriptions (Particulars)', () => {
  it('accounting invoice: each line keeps its narration on its own entry; party and tax lines have none', async () => {
    const k = setupKit();
    // Consultancy ₹50,000.00 @18% → CGST 4,500.00 + SGST 4,500.00 = ₹59,000.00; discount ₹10.00 after tax → ₹58,990.00.
    const input: VoucherInput = {
      voucherTypeId: k.vt.sales,
      date: k.t.today,
      mode: 'accounting_invoice',
      partyLedgerId: k.L.acme,
      ledgers: [
        { ledgerId: k.L.consult, amount: 5000000, narration: 'April retainer\nSite visits included' },
        { ledgerId: k.L.discount, amount: -1000, narration: 'Loyalty discount' },
      ],
    };
    const res = save(k, input);
    assert.deepEqual(entryMap(k, res.id), {
      'Acme Traders': 5899000,
      'Consultancy Income': -5000000,
      'Discount Allowed': 1000,
      'Output CGST': -450000,
      'Output SGST/UTGST': -450000,
    });
    const expected = {
      'Acme Traders': null,
      'Consultancy Income': 'April retainer\nSite visits included',
      'Discount Allowed': 'Loyalty discount',
      'Output CGST': null,
      'Output SGST/UTGST': null,
    };
    assert.deepEqual(entryTexts(k, res.id), expected);
    const d = await k.t.callOk<VoucherDetail>(vouchersRoutes, 'vouchers.get', { id: res.id });
    assert.deepEqual(Object.fromEntries(d.entries.map((e) => [e.ledgerName, e.narration])), expected);
    assert.deepEqual(Object.fromEntries(previewVoucher(k.t.ctx, input).entries.map((e) => [e.ledgerName, e.narration])), expected);
    // GST rows keep the ledger's name.
    assert.equal(d.gstLines[0].description, 'Consultancy Income');
    k.t.close();
  });

  it('item invoice: GST-computed, apportioned and after-tax ledgers keep their narration; Sales, tax and round off have none', () => {
    const k = setupKit();
    // Rice 10 × ₹100 @5% and mixer 5 × ₹200 @18%, freight ₹100 apportioned 50 : 50 → taxable 1,050.00 + 1,050.00;
    // consultancy ₹500.00 @18% as its own GST line. CGST = SGST = 26.25 + 94.50 + 45.00 = 165.75.
    // 2,600.00 + 331.50 = 2,931.50; discount ₹10.00 after tax → 2,921.50 → rounded to 2,922.00 (round off +0.50).
    const res = save(k, salesInput(k, {
      items: [
        { itemId: k.I.rice, qty: 10, rate: 100 },
        { itemId: k.I.mixer, qty: 5, rate: 200 },
      ],
      ledgers: [
        { ledgerId: k.L.freight, amount: 10000, narration: 'Door delivery' },
        { ledgerId: k.L.consult, amount: 50000, narration: 'Installation visit' },
        { ledgerId: k.L.discount, amount: -1000, narration: 'Festival offer' },
      ],
    }));
    assert.deepEqual(entryMap(k, res.id), {
      'Acme Traders': 292200,
      Sales: -200000,
      'Freight Outward': -10000,
      'Consultancy Income': -50000,
      'Discount Allowed': 1000,
      'Output CGST': -16575,
      'Output SGST/UTGST': -16575,
      'Round Off': -50,
    });
    assert.deepEqual(entryTexts(k, res.id), {
      'Acme Traders': null,
      Sales: null,
      'Freight Outward': 'Door delivery',
      'Consultancy Income': 'Installation visit',
      'Discount Allowed': 'Festival offer',
      'Output CGST': null,
      'Output SGST/UTGST': null,
      'Round Off': null,
    });
    k.t.close();
  });

  it('ledger mode (journal, payment): the narration typed on each line is stored with it', () => {
    const k = setupKit();
    const jv = save(k, {
      voucherTypeId: k.vt.journal,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.rent, amount: 50000, narration: '  April rent\nFlat 4B  ' },
        { ledgerId: k.L.capital, amount: -50000 },
      ],
    });
    assert.deepEqual(entryTexts(k, jv.id), { 'Office Rent': 'April rent\nFlat 4B', 'Owner Capital': null });
    const pv = save(k, {
      voucherTypeId: k.vt.payment,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.rent, amount: 25000, narration: 'Shop rent' },
        { ledgerId: k.L.bank, amount: -25000, narration: 'NEFT from current account' },
      ],
    });
    assert.deepEqual(entryTexts(k, pv.id), { 'Office Rent': 'Shop rent', 'HDFC Bank': 'NEFT from current account' });
    assert.deepEqual(getVoucher(k.t.db, pv.id).entries.map((e) => e.narration), ['Shop rent', 'NEFT from current account']);
    k.t.close();
  });

  it('a zero-amount line and the ledger lines of an order keep their text in the voucher as entered only', () => {
    const k = setupKit();
    const inv = save(k, salesInput(k, { ledgers: [{ ledgerId: k.L.freight, amount: 0, narration: 'Free delivery' }] }));
    assert.equal(entryTexts(k, inv.id)['Freight Outward'], undefined, 'a zero line posts no entry');
    assert.equal(storedMeta(k, inv.id).input.ledgers?.[0].narration, 'Free delivery');
    assert.equal(getVoucher(k.t.db, inv.id).input.ledgers?.[0].narration, 'Free delivery');

    // A sales order in item-invoice mode posts nothing; its lines' texts live in the voucher as entered.
    const so = save(k, {
      voucherTypeId: k.vt.sales_order,
      date: k.t.today,
      mode: 'item_invoice',
      partyLedgerId: k.L.acme,
      items: [{ itemId: k.I.mixer, qty: 4, rate: 200, description: 'Matte finish' }],
      ledgers: [{ ledgerId: k.L.freight, amount: 5000, narration: 'Packing extra' }],
    });
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM ledger_entries WHERE voucher_id = :id', { id: so.id }), 0);
    assert.deepEqual(itemTexts(k, so.id), [[1, 'Matte finish']]);
    const d = getVoucher(k.t.db, so.id);
    assert.equal(d.input.ledgers?.[0].narration, 'Packing extra');
    assert.equal(d.inventory[0].description, 'Matte finish');
    k.t.close();
  });

  it('a description over 1,000 characters is refused at its line; 1,000 are accepted', async () => {
    const k = setupKit();
    const long = 'x'.repeat(1001);
    const item = await k.t.call(vouchersRoutes, 'vouchers.save', salesInput(k, { items: [{ itemId: k.I.mixer, qty: 1, rate: 200, description: long }] }));
    assert.equal(item.ok ? 'ok' : item.error.code, 'VALIDATION');
    assert.deepEqual(item.ok ? null : (item.error.details as Array<{ path: string }>).map((i) => i.path), ['items[0].description']);
    const ledger = await k.t.call(vouchersRoutes, 'vouchers.save', {
      voucherTypeId: k.vt.journal,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.rent, amount: 100, narration: long },
        { ledgerId: k.L.capital, amount: -100 },
      ],
    });
    assert.equal(ledger.ok ? 'ok' : ledger.error.code, 'VALIDATION');
    assert.deepEqual(ledger.ok ? null : (ledger.error.details as Array<{ path: string }>).map((i) => i.path), ['ledgers[0].narration']);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM vouchers'), 0);

    // Exactly 1,000 (spaces around it are trimmed before the length is counted).
    const max = 'y'.repeat(1000);
    const ok = await k.t.callOk<VoucherSaveResult>(vouchersRoutes, 'vouchers.save', {
      ...salesInput(k, { items: [{ itemId: k.I.mixer, qty: 1, rate: 200, description: ` ${max} ` }] }),
      acknowledgeWarnings: true,
    });
    assert.deepEqual(itemTexts(k, ok.id), [[1, max]]);
    k.t.close();
  });
});

describe('vouchers saved without their input (older imports)', () => {
  it('the rebuilt input keeps the item descriptions, so alter and duplicate do not lose them', () => {
    const k = setupKit();
    const dn = save(k, {
      voucherTypeId: k.vt.delivery_note,
      date: k.t.today,
      mode: 'inventory',
      partyLedgerId: k.L.acme,
      items: [
        { itemId: k.I.mixer, qty: 2, rate: 200, description: 'Gift wrapped' },
        { itemId: k.I.rice, qty: 1, rate: 50 },
      ],
    });
    k.t.db.run('UPDATE vouchers SET meta = NULL WHERE id = :id', { id: dn.id });
    assert.deepEqual(getVoucher(k.t.db, dn.id).input.items?.map((i) => [i.itemId, i.description]), [[k.I.mixer, 'Gift wrapped'], [k.I.rice, undefined]]);
    assert.equal(duplicateVoucher(k.t.ctx, dn.id).items?.[0].description, 'Gift wrapped');
    // Making it optional re-saves it from the rebuilt input.
    setVoucherOptional(k.t.ctx, dn.id, true);
    assert.deepEqual(itemTexts(k, dn.id), [[1, 'Gift wrapped'], [2, null]]);
    k.t.close();
  });
});

describe('tracking (notes and orders into invoices)', () => {
  it('every line of an open note or order carries its own description, also when partly billed', async () => {
    const k = setupKit();
    save(k, {
      voucherTypeId: k.vt.delivery_note,
      date: k.t.today,
      mode: 'inventory',
      partyLedgerId: k.L.acme,
      items: [
        { itemId: k.I.mixer, qty: 3, rate: 200, description: 'Red' },
        { itemId: k.I.mixer, qty: 2, rate: 200, description: 'Blue' },
        { itemId: k.I.rice, qty: 4, rate: 100 },
      ],
    });
    const lines = (docs: TrackingDoc[]) => docs.flatMap((d) => d.lines.map((l) => [l.itemName, l.pendingQty, l.description]));
    assert.deepEqual(lines(trackingRefs(k.t.db, k.L.acme, 'delivery')), [['Mixer Grinder', 3, 'Red'], ['Mixer Grinder', 2, 'Blue'], ['Rice Bag', 4, null]]);

    // Billing 2 mixers takes them from the note's first mixer line (FIFO); 4 more empty it and start the second.
    save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 2, rate: 200, trackingRef: '1' }] }));
    assert.deepEqual(lines(trackingRefs(k.t.db, k.L.acme, 'delivery')), [['Mixer Grinder', 1, 'Red'], ['Mixer Grinder', 2, 'Blue'], ['Rice Bag', 4, null]]);
    save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 2, rate: 200, trackingRef: '1' }] }));
    const docs = await k.t.callOk<TrackingDoc[]>(vouchersRoutes, 'vouchers.trackingRefs', { partyLedgerId: k.L.acme, kind: 'delivery' });
    assert.deepEqual(lines(docs), [['Mixer Grinder', 0, 'Red'], ['Mixer Grinder', 1, 'Blue'], ['Rice Bag', 4, null]]);

    // An order's lines too, while partly fulfilled.
    save(k, { voucherTypeId: k.vt.sales_order, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 10, rate: 200, description: 'Matte finish' }] });
    save(k, { voucherTypeId: k.vt.delivery_note, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 4, rate: 200, orderRef: '1' }] });
    assert.deepEqual(lines(trackingRefs(k.t.db, k.L.acme, 'sales_order')), [['Mixer Grinder', 6, 'Matte finish']]);
    k.t.close();
  });

  const pending = (docs: TrackingDoc[]) => docs.flatMap((d) => d.lines.map((l) => [l.description, l.qty, l.pendingQty]));

  it('a billing line with a line’s own description bills that line first, also out of line order', () => {
    const k = setupKit();
    // Delivery Note 1: two mixers told apart by their serial numbers.
    save(k, {
      voucherTypeId: k.vt.delivery_note,
      date: k.t.today,
      mode: 'inventory',
      partyLedgerId: k.L.acme,
      items: [
        { itemId: k.I.mixer, qty: 1, rate: 200, description: 'SN-111' },
        { itemId: k.I.mixer, qty: 1, rate: 200, description: 'SN-222' },
      ],
    });
    // Alt+T brought both lines; the customer is billed for SN-222 only (the SN-111 row was removed).
    const inv = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 1, rate: 200, trackingRef: '1', description: 'SN-222' }] }));
    assert.deepEqual(pending(trackingRefs(k.t.db, k.L.acme, 'delivery')), [['SN-111', 1, 1], ['SN-222', 1, 0]]);
    // Altering that invoice leaves it out: both lines are open to it again.
    assert.deepEqual(pending(trackingRefs(k.t.db, k.L.acme, 'delivery', inv.id)), [['SN-111', 1, 1], ['SN-222', 1, 1]]);
    k.t.close();
  });

  it('an order fulfilled out of line order: each described line takes what was fulfilled under its text', () => {
    const k = setupKit({ features: { orderProcessing: true } });
    // Sales Order 1: Red 5 and Blue 5. Alt+T gave both; only 3 red were in stock, so Red became 3.
    save(k, {
      voucherTypeId: k.vt.sales_order,
      date: k.t.today,
      mode: 'item_invoice',
      partyLedgerId: k.L.acme,
      items: [
        { itemId: k.I.mixer, qty: 5, rate: 200, description: 'Red' },
        { itemId: k.I.mixer, qty: 5, rate: 200, description: 'Blue' },
      ],
    });
    save(k, salesInput(k, {
      items: [
        { itemId: k.I.mixer, qty: 3, rate: 200, orderRef: '1', description: 'Red' },
        { itemId: k.I.mixer, qty: 5, rate: 200, orderRef: '1', description: 'Blue' },
      ],
    }));
    // Red 2 are still to come (in line order alone, Red would read fulfilled and Blue 2 pending).
    assert.deepEqual(pending(trackingRefs(k.t.db, k.L.acme, 'sales_order')), [['Red', 5, 2], ['Blue', 5, 0]]);
    k.t.close();
  });

  it('what no line’s text claims is applied in line order, as without descriptions', () => {
    const k = setupKit();
    const note = (items: VoucherInput['items']) => save(k, { voucherTypeId: k.vt.delivery_note, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.acme, items });
    // Delivery Note 1 without texts, billed under a text: line order (the first line is billed).
    note([
      { itemId: k.I.mixer, qty: 2, rate: 200 },
      { itemId: k.I.mixer, qty: 3, rate: 200 },
    ]);
    // Delivery Note 2 with texts, billed without one (removed on the invoice): line order.
    note([
      { itemId: k.I.mixer, qty: 2, rate: 200, description: 'Red' },
      { itemId: k.I.mixer, qty: 3, rate: 200, description: 'Blue' },
    ]);
    // Delivery Note 3: 'blue' (another text — the case differs) claims no line; 'Green' 5 claims its line's 4,
    // and the 1 over it joins the rest, applied in line order from the first line.
    note([
      { itemId: k.I.mixer, qty: 2, rate: 200, description: 'Red' },
      { itemId: k.I.mixer, qty: 3, rate: 200, description: 'Blue' },
      { itemId: k.I.mixer, qty: 4, rate: 200, description: 'Green' },
    ]);
    save(k, salesInput(k, {
      items: [
        { itemId: k.I.mixer, qty: 2, rate: 200, trackingRef: '1', description: 'Blue' },
        { itemId: k.I.mixer, qty: 2, rate: 200, trackingRef: '2' },
        { itemId: k.I.mixer, qty: 1, rate: 200, trackingRef: '3', description: 'blue' },
        { itemId: k.I.mixer, qty: 5, rate: 200, trackingRef: '3', description: 'Green' },
      ],
    }));
    const docs = trackingRefs(k.t.db, k.L.acme, 'delivery');
    assert.deepEqual(docs.map((d) => d.number), ['1', '2', '3']);
    assert.deepEqual(
      docs.map((d) => d.lines.map((l) => l.pendingQty)),
      [
        [0, 3],
        [0, 3],
        // Green takes its 4; the other 2 (1 over Green, 1 'blue') bill Red; Blue stays open.
        [0, 3, 0],
      ],
    );
    k.t.close();
  });
});

describe('edit log', () => {
  it('an alteration that only changes line descriptions is recorded and summarised as such', () => {
    const k = setupKit();
    const res = save(k, salesInput(k, {
      items: [{ itemId: k.I.mixer, qty: 5, rate: 200, description: 'Blue' }],
      ledgers: [{ ledgerId: k.L.discount, amount: -1000, narration: 'Festival offer' }],
    }));
    const created = audits(k, res.id)[0];
    // Each line is named by its place in its own list and its item / ledger, as the diff shows it.
    assert.deepEqual(created.after?.lineDescriptions, { items: { '1 · Mixer Grinder': 'Blue' }, ledgers: { '1 · Discount Allowed': 'Festival offer' } });

    k.t.clock.advance(60_000);
    const input = getVoucher(k.t.db, res.id).input;
    save(k, { ...input, items: [{ ...input.items![0], description: 'Red' }] });
    const altered = audits(k, res.id)[1];
    assert.equal(altered.action, 'alter');
    assert.deepEqual(altered.before?.lineDescriptions, { items: { '1 · Mixer Grinder': 'Blue' }, ledgers: { '1 · Discount Allowed': 'Festival offer' } });
    assert.deepEqual(altered.after?.lineDescriptions, { items: { '1 · Mixer Grinder': 'Red' }, ledgers: { '1 · Discount Allowed': 'Festival offer' } });
    // Figures and the entry / item tuples are untouched: the description is the only difference.
    assert.deepEqual([altered.after?.entries, altered.after?.items], [altered.before?.entries, altered.before?.items]);
    assert.deepEqual(diffJson(altered.before, altered.after).changes, [{ path: 'lineDescriptions.items["1 · Mixer Grinder"]', kind: 'changed', before: 'Blue', after: 'Red' }]);

    // Saved again unchanged: nothing to report.
    k.t.clock.advance(60_000);
    save(k, { ...getVoucher(k.t.db, res.id).input });
    // The voucher narration and a removed item text: the field, then the line descriptions.
    k.t.clock.advance(60_000);
    const again = getVoucher(k.t.db, res.id).input;
    save(k, { ...again, narration: 'Rate revised', items: [{ ...again.items![0], description: undefined }] });
    assert.deepEqual(audits(k, res.id)[3].after?.lineDescriptions, { ledgers: { '1 · Discount Allowed': 'Festival offer' } });

    assert.deepEqual(history(k, res.id), [
      ['create', 'Created voucher'],
      ['alter', 'Line descriptions changed'],
      ['alter', 'Saved without changes'],
      ['alter', 'Changed 1 field: narration; line descriptions changed'],
    ]);
    assert.equal(verifyAuditChain(k.t.db).ok, true);
    k.t.close();
  });

  it('ledger-line texts of every kind are recorded, zero-amount lines included', () => {
    const k = setupKit();
    const jv = save(k, {
      voucherTypeId: k.vt.journal,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.rent, amount: 50000, narration: 'April rent' },
        { ledgerId: k.L.capital, amount: -50000 },
      ],
    });
    k.t.clock.advance(60_000);
    const input = getVoucher(k.t.db, jv.id).input;
    save(k, { ...input, ledgers: [input.ledgers![0], { ...input.ledgers![1], narration: 'Paid by the owner' }] });
    const inv = save(k, salesInput(k, { ledgers: [{ ledgerId: k.L.freight, amount: 0, narration: 'Free delivery' }] }));
    assert.deepEqual(audits(k, inv.id)[0].after?.lineDescriptions, { ledgers: { '1 · Freight Outward': 'Free delivery' } });
    assert.deepEqual(audits(k, jv.id)[1].after?.lineDescriptions, { ledgers: { '1 · Office Rent': 'April rent', '2 · Owner Capital': 'Paid by the owner' } });
    assert.deepEqual(history(k, jv.id).map(([, s]) => s), ['Created voucher', 'Line descriptions changed']);
    k.t.close();
  });

  it('a voucher without line texts has the earlier image (no lineDescriptions key)', () => {
    const k = setupKit();
    const res = save(k, salesInput(k));
    k.t.clock.advance(60_000);
    save(k, { ...getVoucher(k.t.db, res.id).input, narration: 'Checked' });
    for (const a of audits(k, res.id)) {
      assert.equal(a.before !== null && 'lineDescriptions' in a.before, false);
      assert.equal(a.after !== null && 'lineDescriptions' in a.after, false);
    }
    assert.deepEqual(history(k, res.id).map(([, s]) => s), ['Created voucher', 'Changed 1 field: narration']);
    k.t.close();
  });

  it('cancel and delete images carry the texts; a cancel does not report them as changed', () => {
    const k = setupKit();
    const a = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 1, rate: 200, description: 'Display piece' }] }));
    cancelVoucher(k.t.ctx, a.id, 'Wrong party');
    const cancel = audits(k, a.id)[1];
    assert.equal(cancel.action, 'cancel');
    assert.deepEqual([cancel.before?.lineDescriptions, cancel.after?.lineDescriptions], [{ items: { '1 · Mixer Grinder': 'Display piece' } }, { items: { '1 · Mixer Grinder': 'Display piece' } }]);
    assert.equal(diffJson(cancel.before, cancel.after).changes.some((c) => c.path.startsWith('lineDescriptions')), false);

    const b = save(k, salesInput(k, { items: [{ itemId: k.I.mixer, qty: 1, rate: 200, description: 'Spare jar' }] }));
    deleteVoucher(k.t.ctx, b.id, 'Entered twice');
    assert.deepEqual(audits(k, b.id)[1].before?.lineDescriptions, { items: { '1 · Mixer Grinder': 'Spare jar' } });
    k.t.close();
  });

  it('a voucher saved without its input: the texts come from its lines, keyed like its rebuilt input', () => {
    const k = setupKit();
    const jv = save(k, {
      voucherTypeId: k.vt.journal,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.capital, amount: -50000 },
        { ledgerId: k.L.rent, amount: 50000, narration: 'April rent' },
      ],
    });
    const dn = save(k, { voucherTypeId: k.vt.delivery_note, date: k.t.today, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 2, rate: 200, description: 'Gift wrapped' }] });
    k.t.db.run('UPDATE vouchers SET meta = NULL WHERE id IN (:a, :b)', { a: jv.id, b: dn.id });
    assert.deepEqual(snapshotFromDb(k.t.db, loadVoucherRow(k.t.db, jv.id)!, 'Journal').lineDescriptions, { ledgers: { '2 · Office Rent': 'April rent' } });
    assert.deepEqual(snapshotFromDb(k.t.db, loadVoucherRow(k.t.db, dn.id)!, 'Delivery Note').lineDescriptions, { items: { '1 · Mixer Grinder': 'Gift wrapped' } });
    // Altered from the rebuilt input without a change: the before (lines) and after (input) images agree.
    k.t.clock.advance(60_000);
    save(k, { ...getVoucher(k.t.db, jv.id).input });
    save(k, { ...getVoucher(k.t.db, dn.id).input });
    assert.deepEqual(history(k, jv.id).map(([, s]) => s), ['Created voucher', 'Saved without changes']);
    assert.deepEqual(history(k, dn.id).map(([, s]) => s), ['Created voucher', 'Saved without changes']);
    k.t.close();
  });

  it('each line is named for the reader: its place in its own list and its ledger or item as the masters name it now', () => {
    const k = setupKit();
    // A payment in single entry: the bank (the Account) is the voucher's first ledger line, so the rent the
    // grid shows first under Particulars is ledger line 2 — the name tells which line it is.
    const pv = save(k, {
      voucherTypeId: k.vt.payment,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.bank, amount: -2500000 },
        { ledgerId: k.L.rent, amount: 2500000, narration: 'Shop 4, April' },
      ],
    });
    assert.deepEqual(audits(k, pv.id)[0].after?.lineDescriptions, { ledgers: { '2 · Office Rent': 'Shop 4, April' } });

    // A journal's ledger is renamed, then only the line's text changes: both images are named as the masters
    // are now, so the text is the one change.
    const jv = save(k, {
      voucherTypeId: k.vt.journal,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.capital, amount: -5000000 },
        { ledgerId: k.L.rent, amount: 5000000, narration: 'Advance rent, April' },
      ],
    });
    k.t.db.run(`UPDATE ledgers SET name = 'Shop Rent' WHERE id = :id`, { id: k.L.rent });
    k.t.clock.advance(60_000);
    const input = getVoucher(k.t.db, jv.id).input;
    save(k, { ...input, ledgers: [input.ledgers![0], { ...input.ledgers![1], narration: 'Advance rent, May' }] });
    const altered = audits(k, jv.id)[1];
    assert.deepEqual(diffJson(altered.before, altered.after).changes, [
      { path: 'lineDescriptions.ledgers["2 · Shop Rent"]', kind: 'changed', before: 'Advance rent, April', after: 'Advance rent, May' },
    ]);
    // Renamed again and saved unchanged: nothing to report.
    k.t.db.run(`UPDATE ledgers SET name = 'Rent — Shop 4' WHERE id = :id`, { id: k.L.rent });
    k.t.clock.advance(60_000);
    save(k, { ...getVoucher(k.t.db, jv.id).input });
    assert.deepEqual(history(k, jv.id).map(([, s]) => s), ['Created voucher', 'Line descriptions changed', 'Saved without changes']);
    // The described line given another ledger: its text reads removed under the old name, added under the new.
    k.t.clock.advance(60_000);
    const moved = getVoucher(k.t.db, jv.id).input;
    save(k, { ...moved, ledgers: [moved.ledgers![0], { ...moved.ledgers![1], ledgerId: k.L.discount }] });
    const relined = audits(k, jv.id)[3];
    assert.deepEqual(
      diffJson(relined.before, relined.after).changes.filter((c) => c.path.startsWith('lineDescriptions')),
      [
        { path: 'lineDescriptions.ledgers["2 · Rent — Shop 4"]', kind: 'removed', before: 'Advance rent, May', after: null },
        { path: 'lineDescriptions.ledgers["2 · Discount Allowed"]', kind: 'added', before: null, after: 'Advance rent, May' },
      ],
    );

    // A stock journal: the source line and the destination line each with its item; the same item on two
    // lines is told apart by the place.
    const sj = save(k, {
      voucherTypeId: k.vt.stock_journal,
      date: k.t.today,
      mode: 'inventory',
      items: [
        { itemId: k.I.rice, qty: 10, rate: 50, isConsumption: true, description: 'Torn bags' },
        { itemId: k.I.mixer, qty: 1, rate: 500, description: 'Assembled from spares' },
        { itemId: k.I.mixer, qty: 1, rate: 500, description: 'Display piece' },
      ],
    });
    assert.deepEqual(audits(k, sj.id)[0].after?.lineDescriptions, {
      items: { '1 · Rice Bag': 'Torn bags', '2 · Mixer Grinder': 'Assembled from spares', '3 · Mixer Grinder': 'Display piece' },
    });

    // A master that is no longer there (a stored input naming a removed ledger): the place alone.
    k.t.db.run(`UPDATE vouchers SET meta = json_set(meta, '$.input.ledgers[1].ledgerId', 999999) WHERE id = :id`, { id: pv.id });
    assert.deepEqual(snapshotFromDb(k.t.db, loadVoucherRow(k.t.db, pv.id)!, 'Payment').lineDescriptions, { ledgers: { '2': 'Shop 4, April' } });
    assert.equal(verifyAuditChain(k.t.db).ok, true);
    k.t.close();
  });
});
