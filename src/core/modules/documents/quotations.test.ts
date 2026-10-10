/**
 * Quotations / proforma invoices: no books, no stock, no GST returns, own number series; status,
 * conversion (draft → save → link back), no double conversion, migration of existing companies.
 *
 * Figures: 5 × Mixer Grinder @ ₹200 = ₹1,000.00 taxable, intra-state (27 → 27) CGST 9% ₹90.00 +
 * SGST 9% ₹90.00 → document value ₹1,180.00 (118000 paise).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { Db } from '../../db/db.ts';
import { getSchemaVersion, migrate } from '../../db/migrate.ts';
import { migrations } from '../../db/migrations/index.ts';
import { seedCompany } from '../../db/seed.ts';
import { makeGstin } from '../../testing/fixtures.ts';
import { cancelVoucher, deleteVoucher, duplicateVoucher, saveVoucher } from '../vouchers/service.ts';
import { save, setupKit, stockOf, throwsApp, throwsField, type Kit } from '../vouchers/testkit.ts';
import './hook.ts';
import { draftVoucher, listDocuments, setDocumentStatus, voucherLinks } from './quotations.ts';

function quote(k: Kit, over: Partial<VoucherInput> = {}): VoucherInput {
  return {
    voucherTypeId: k.vt.quotation,
    date: k.t.today,
    mode: 'item_invoice',
    partyLedgerId: k.L.acme,
    validUntil: '2026-04-30',
    items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }],
    orderDetails: { terms: 'Delivery within 7 days of PO. Payment 30 days.' },
    ...over,
  };
}

const kit = (): Kit => setupKit({ features: { orderProcessing: true } });

describe('quotation / proforma documents', () => {
  it('compute GST for printing but post nothing: no ledger entries, no stock, no gst_lines', () => {
    const k = kit();
    const before = stockOf(k, k.I.mixer);
    const q = save(k, quote(k));
    const v = k.t.db.get<Record<string, unknown>>('SELECT * FROM vouchers WHERE id = :id', { id: q.id }) ?? {};
    assert.equal(v.total_amount, 118000);
    assert.equal(v.taxable_amount, 100000);
    assert.equal(v.tax_amount, 18000);
    assert.equal(v.affects_books, 0);
    assert.equal(v.affects_stock, 0);
    assert.equal(v.valid_until, '2026-04-30');
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM ledger_entries WHERE voucher_id = :id', { id: q.id }), 0);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM gst_lines WHERE voucher_id = :id', { id: q.id }), 0);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM inventory_entries WHERE voucher_id = :id AND affects_stock = 1', { id: q.id }), 0);
    assert.equal(stockOf(k, k.I.mixer), before);
    k.t.close();
  });

  it('have their own number series: quotations never consume the GST invoice series', () => {
    const k = kit();
    const q1 = save(k, quote(k));
    const q2 = save(k, quote(k));
    const p1 = save(k, quote(k, { voucherTypeId: k.vt.proforma }));
    const s1 = save(k, { voucherTypeId: k.vt.sales, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] });
    assert.deepEqual([q1.number, q2.number, p1.number, s1.number], ['1', '2', '1', '1']);
    k.t.close();
  });

  it('accept an accounting invoice (services) and refuse validity rules', () => {
    const k = kit();
    const svc = save(k, quote(k, { mode: 'accounting_invoice', items: undefined, ledgers: [{ ledgerId: k.L.consult, amount: 5000000 }] }));
    assert.equal(k.t.db.value('SELECT total_amount FROM vouchers WHERE id = :id', { id: svc.id }), 5900000, '₹50,000 + 18% = ₹59,000');
    throwsField(() => saveVoucher(k.t.ctx, quote(k, { validUntil: '2026-04-01' })), 'validUntil', /before the document date/);
    throwsField(
      () => saveVoucher(k.t.ctx, { voucherTypeId: k.vt.sales, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, validUntil: '2026-05-01', items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] }),
      'validUntil',
      /quotations and proforma/,
    );
    k.t.close();
  });

  it('status: open → expired after valid-until; accepted / rejected recorded and audited', () => {
    const k = kit();
    const a = save(k, quote(k));
    const b = save(k, quote(k, { validUntil: '2026-04-20' }));
    const c = save(k, quote(k, { validUntil: undefined }));
    k.t.clock.setToday('2026-04-25');
    const list = () => listDocuments(k.t.ctx, { baseType: 'quotation', from: '2026-04-01', to: '2026-04-30' });
    const st = () => Object.fromEntries(list().rows.map((r) => [r.id, r.status]));
    assert.deepEqual(st(), { [a.id]: 'open', [b.id]: 'expired', [c.id]: 'open' });
    throwsField(() => setDocumentStatus(k.t.ctx, { id: a.id, status: 'rejected' }), 'reason', /reason/);
    setDocumentStatus(k.t.ctx, { id: a.id, status: 'rejected', reason: 'Lost on price' });
    setDocumentStatus(k.t.ctx, { id: b.id, status: 'accepted' });
    assert.deepEqual(st(), { [a.id]: 'rejected', [b.id]: 'accepted', [c.id]: 'open' });
    const audit = k.t.db.all<{ after_json: string }>(`SELECT after_json FROM audit_log WHERE entity_type = 'voucher' AND entity_id = :id AND action = 'alter'`, { id: a.id });
    assert.match(audit[audit.length - 1].after_json, /Lost on price/);
    setDocumentStatus(k.t.ctx, { id: a.id, status: 'open' });
    assert.equal(st()[a.id], 'open');
    throwsApp(() => setDocumentStatus(k.t.ctx, { id: k.t.db.value<number>('SELECT id FROM vouchers WHERE base_type = :b', { b: 'quotation' }) as number + 999, status: 'open' }), 'NOT_FOUND');
    k.t.close();
  });

  it('converts a quotation into a sales order and into a sales invoice, linked back, never twice', () => {
    const k = kit();
    const q = save(k, quote(k));
    const draft = draftVoucher(k.t.ctx, { sourceId: q.id, targetBaseType: 'sales_order' });
    assert.equal(draft.voucherTypeId, k.vt.sales_order);
    assert.equal(draft.convertedFromId, q.id);
    assert.equal(draft.validUntil, undefined, 'the validity belongs to the quotation');
    assert.equal(draft.partyLedgerId, k.L.acme);
    assert.deepEqual(draft.items, [{ itemId: k.I.mixer, qty: 5, rate: 200 }]);
    assert.match(draft.orderDetails?.otherRefs ?? '', /Quotation 1 dt 15-Apr-2026/);
    assert.equal(draft.orderDetails?.terms, 'Delivery within 7 days of PO. Payment 30 days.');
    const so = save(k, draft);
    const links = voucherLinks(k.t.ctx, q.id);
    assert.equal(links.document?.status, 'converted');
    assert.deepEqual(links.convertedTo.map((r) => r.id), [so.id]);
    assert.equal(voucherLinks(k.t.ctx, so.id).convertedFrom?.id, q.id);
    // The source is audited as converted, in the same transaction.
    assert.match(k.t.db.value<string>(`SELECT after_json FROM audit_log WHERE entity_id = :id AND action = 'alter' ORDER BY id DESC LIMIT 1`, { id: q.id }) ?? '', /converted/);

    // No double conversion: neither the draft nor a hand-made voucher.
    throwsApp(() => draftVoucher(k.t.ctx, { sourceId: q.id, targetBaseType: 'sales' }), 'BUSINESS_RULE', /already been converted into Sales Order 1/);
    throwsField(() => saveVoucher(k.t.ctx, { ...draft, voucherTypeId: k.vt.sales, acknowledgeWarnings: true }), 'convertedFromId', /already been converted/);

    // Cancelling the order frees the quotation; it converts again (now into an invoice).
    cancelVoucher(k.t.ctx, so.id, 'Customer changed the order');
    assert.equal(voucherLinks(k.t.ctx, q.id).document?.status, 'open');
    const inv = save(k, draftVoucher(k.t.ctx, { sourceId: q.id, targetBaseType: 'sales' }));
    assert.equal(k.t.db.value('SELECT total_amount FROM vouchers WHERE id = :id', { id: inv.id }), 118000);
    assert.equal(k.t.db.value('SELECT SUM(amount) FROM ledger_entries WHERE voucher_id = :id', { id: inv.id }), 0, 'Σ entries = 0');
    assert.equal(voucherLinks(k.t.ctx, q.id).document?.status, 'converted');

    // An alter of the invoice keeps the link; deleting it removes the link (the quotation is open again).
    const detail = k.t.db.get<{ updated_at: string }>('SELECT updated_at FROM vouchers WHERE id = :id', { id: inv.id });
    save(k, { voucherTypeId: k.vt.sales, id: inv.id, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.mixer, qty: 6, rate: 200 }], expectedUpdatedAt: detail?.updated_at });
    assert.equal(voucherLinks(k.t.ctx, q.id).document?.status, 'converted');
    deleteVoucher(k.t.ctx, inv.id);
    assert.equal(voucherLinks(k.t.ctx, q.id).document?.status, 'open');
    k.t.close();
  });

  it('a proforma converts only into a sales invoice; rejected / cancelled documents cannot convert', () => {
    const k = kit();
    const p = save(k, quote(k, { voucherTypeId: k.vt.proforma }));
    throwsField(() => draftVoucher(k.t.ctx, { sourceId: p.id, targetBaseType: 'sales_order' }), 'targetBaseType', /sales only/);
    throwsField(
      () => saveVoucher(k.t.ctx, { voucherTypeId: k.vt.sales_order, date: k.t.today, mode: 'item_invoice', partyLedgerId: k.L.acme, convertedFromId: p.id, items: [{ itemId: k.I.mixer, qty: 1, rate: 200 }] }),
      'convertedFromId',
      /Sales invoice only/,
    );
    const svc = save(k, quote(k, { mode: 'accounting_invoice', items: undefined, ledgers: [{ ledgerId: k.L.consult, amount: 100000 }] }));
    throwsApp(() => draftVoucher(k.t.ctx, { sourceId: svc.id, targetBaseType: 'sales_order' }), 'BUSINESS_RULE', /needs stock items/);
    const q = save(k, quote(k));
    setDocumentStatus(k.t.ctx, { id: q.id, status: 'rejected', reason: 'No budget' });
    throwsApp(() => draftVoucher(k.t.ctx, { sourceId: q.id, targetBaseType: 'sales' }), 'BUSINESS_RULE', /rejected/);
    const q2 = save(k, quote(k));
    cancelVoucher(k.t.ctx, q2.id, 'Duplicate');
    throwsApp(() => draftVoucher(k.t.ctx, { sourceId: q2.id, targetBaseType: 'sales' }), 'BUSINESS_RULE', /cancelled/);
    // Dated before the quotation.
    const q3 = save(k, quote(k, { date: '2026-04-15' }));
    throwsField(() => saveVoucher(k.t.ctx, { ...draftVoucher(k.t.ctx, { sourceId: q3.id, targetBaseType: 'sales' }), date: '2026-04-10', acknowledgeWarnings: true }), 'date', /cannot be dated before/);
    k.t.close();
  });

  it('the register counts statuses, value and the conversion rate; duplicate drops the link', () => {
    const k = kit();
    const a = save(k, quote(k));
    save(k, quote(k));
    const c = save(k, quote(k));
    save(k, draftVoucher(k.t.ctx, { sourceId: a.id, targetBaseType: 'sales' }));
    cancelVoucher(k.t.ctx, c.id, 'Typo');
    const r = listDocuments(k.t.ctx, { baseType: 'quotation', from: '2026-04-01', to: '2026-04-30' });
    assert.equal(r.summary.count, 3);
    assert.equal(r.summary.byStatus.converted.count, 1);
    assert.equal(r.summary.byStatus.open.count, 1);
    assert.equal(r.summary.byStatus.cancelled.count, 1);
    assert.equal(r.summary.conversionRatePct, 50, '1 converted of 2 not cancelled');
    assert.equal(r.summary.value, 118000 * 2, 'a cancelled document is worth 0');
    const onlyOpen = listDocuments(k.t.ctx, { baseType: 'quotation', from: '2026-04-01', to: '2026-04-30', status: 'open' });
    assert.equal(onlyOpen.rows.length, 1);
    assert.equal(r.rows.find((x) => x.id === a.id)?.convertedTo?.voucherTypeName, 'Sales');
    const inv = k.t.db.value<number>(`SELECT id FROM vouchers WHERE base_type = 'sales'`) as number;
    const dup = duplicateVoucher(k.t.ctx, inv);
    assert.equal(dup.convertedFromId, undefined);
    k.t.close();
  });
});

describe('migration 190 on an existing company', () => {
  it('adds the Quotation and Proforma Invoice types (renamed when the name is taken), not on a fresh database', () => {
    const db = new Db(':memory:');
    migrate(db, migrations.filter((m) => m.version <= 150));
    seedCompany(
      db,
      { name: 'Old Co', stateCode: '27', gstRegistrationType: 'regular', gstin: makeGstin('27'), booksFrom: '2026-04-01' },
      { now: new Date('2026-05-01T00:00:00Z') },
    );
    // The seed of THIS build already has them; simulate a company seeded before 190.
    db.run(`DELETE FROM voucher_types WHERE base_type IN ('quotation', 'proforma')`);
    db.run(`UPDATE voucher_types SET name = 'Quotation' WHERE base_type = 'memorandum'`);
    db.exec('PRAGMA user_version = 150');
    migrate(db);
    assert.ok(getSchemaVersion(db) >= 193);
    const rows = db.all<{ name: string; base_type: string; is_predefined: number; numbering_method: string; guid: string }>(
      `SELECT name, base_type, is_predefined, numbering_method, guid FROM voucher_types WHERE base_type IN ('quotation', 'proforma') ORDER BY base_type`,
    );
    assert.deepEqual(rows.map((r) => [r.base_type, r.name, r.is_predefined, r.numbering_method]), [
      ['proforma', 'Proforma Invoice', 1, 'automatic'],
      ['quotation', 'Quotation (Pevqori)', 1, 'automatic'],
    ]);
    for (const r of rows) assert.match(r.guid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    db.close();

    const fresh = new Db(':memory:');
    migrate(fresh);
    assert.equal(fresh.value('SELECT COUNT(*) FROM voucher_types'), 0, 'no company row yet: the seed creates the types');
    fresh.close();
  });
});

describe('printing quotations and proforma invoices', () => {
  it('titles them "Quotation" / "Proforma Invoice" (not a tax invoice) with the validity date and the GST computed', async () => {
    const { buildPrintDataFor } = await import('../print/data.ts');
    const k = kit();
    const q = save(k, quote(k));
    const p = save(k, quote(k, { voucherTypeId: k.vt.proforma }));
    const dq = buildPrintDataFor(k.t.ctx, q.id);
    assert.equal(dq.kind, 'quotation');
    assert.equal(dq.title, 'Quotation');
    assert.equal(dq.endorsement, null);
    assert.deepEqual(dq.references[0], { label: 'Valid Until', value: '30-Apr-2026' });
    assert.equal(dq.totals.grandTotal, 118000);
    assert.equal(dq.totals.tax, 18000);
    const dp = buildPrintDataFor(k.t.ctx, p.id);
    assert.equal(dp.kind, 'proforma_invoice');
    assert.equal(dp.title, 'Proforma Invoice');
    assert.equal(dp.endorsement, 'This is not a tax invoice');
    assert.equal(dp.totals.grandTotal, 118000);
    assert.deepEqual(dp.warnings.filter((w) => /differs|printed from the books/.test(w)), []);
    k.t.close();
  });
});
