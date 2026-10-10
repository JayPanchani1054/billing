/**
 * (2.0) Print layouts in core: storage round-trips through the real routes (company config with
 * mergeDefaults, voucher-type config key patches), the pass-through into PrintVoucherData.savedLayout
 * (validated, corrupt values → empty + one log line), the four voucher-type print flags in resolveOptions,
 * and applyPrintLayout / layoutWarnings on documents built from real vouchers (money untouched).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyPrintLayout,
  EMPTY_PRINT_LAYOUT,
  layoutWarnings,
  PRINT_PARTS,
  resolvePrintLayout,
  type PrintLayoutSpec,
  type PrintPartDef,
  type PrintPartId,
} from '../../../shared/printLayout.ts';
import type { CompanyConfig } from '../../../shared/settings.ts';
import type { VoucherTypeDetail } from '../../../shared/types/accounts.ts';
import type { PrintBatchResult, PrintVoucherData } from '../../../shared/types/print.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { accountsRoutes } from '../accounts/routes.ts';
import { companyRoutes } from '../company/routes.ts';
import { getConfig } from '../company/service.ts';
import { save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { buildBatch, buildPrintDataFor, loadPrintEnv, resolveOptions } from './data.ts';
import { printRoutes } from './routes.ts';

const DATE = '2026-04-15';
const spec = (o: Partial<PrintLayoutSpec> = {}): PrintLayoutSpec => ({ hide: [], show: [], text: [], ...o });

function kit(): Kit {
  const k = setupKit();
  k.t.db.run("UPDATE ledgers SET address = '12, MG Road, Pune' WHERE id = :id", { id: k.L.acme });
  k.t.db.run("UPDATE ledgers SET address = '5, Residency Road, Bengaluru' WHERE id = :id", { id: k.L.blr });
  return k;
}

function sale(k: Kit, extra: Partial<VoucherInput> = {}): number {
  return save(k, {
    voucherTypeId: k.vt.sales,
    date: DATE,
    mode: 'item_invoice',
    partyLedgerId: k.L.acme,
    items: [
      { itemId: k.I.rice, qty: 10, rate: 50 },
      { itemId: k.I.mixer, qty: 2, rate: 150, discountPct: 10 },
    ],
    ...extra,
  }).id;
}

async function issuePaths(p: Promise<{ ok: boolean; error?: { code: string; details?: unknown } }>): Promise<string[]> {
  const res = await p;
  assert.equal(res.ok, false, 'expected a refusal');
  assert.equal(res.error?.code, 'VALIDATION');
  return (res.error?.details as Array<{ path: string }>).map((i) => i.path);
}

// ───────────────────────────── Storage ─────────────────────────────

describe('company layout: company.config.save { invoice: { layout } }', () => {
  it('round-trips through mergeDefaults (save → reload equal) and survives saves of other keys', async () => {
    const k = kit();
    const layout = spec({ hide: ['logo', 'col.batch'], show: ['company.pan'], text: [{ id: 'footer', value: 'Thank you\nVisit again' }, { id: 'title', value: '' }] });
    const saved = await k.t.callOk<CompanyConfig>(companyRoutes, 'company.config.save', { invoice: { layout } });
    assert.deepEqual(saved.invoice.layout, layout);
    assert.deepEqual(getConfig(k.t.db).invoice.layout, layout, 'read back from the settings table');
    assert.deepEqual((await k.t.callOk<CompanyConfig>(companyRoutes, 'company.config.get', {})).invoice.layout, layout);
    // Other Invoice Printing keys and other F12 sections keep the layout.
    await k.t.callOk(companyRoutes, 'company.config.save', { invoice: { showMrp: true, terms: 'Net 30' } });
    await k.t.callOk(companyRoutes, 'company.config.save', { display: { showZeroBalances: true } });
    assert.deepEqual(getConfig(k.t.db).invoice.layout, layout);
    // The whole draft sent back (what Invoice Printing does) is accepted as it is.
    const cfg = getConfig(k.t.db);
    await k.t.callOk(companyRoutes, 'company.config.save', { invoice: cfg.invoice });
    assert.deepEqual(getConfig(k.t.db).invoice.layout, layout);
    // A new layout replaces the old one whole.
    await k.t.callOk(companyRoutes, 'company.config.save', { invoice: { layout: { hide: ['footer'] } } });
    assert.deepEqual(getConfig(k.t.db).invoice.layout, spec({ hide: ['footer'] }));
    // Reset = the empty layout.
    await k.t.callOk(companyRoutes, 'company.config.save', { invoice: { layout: { hide: [], show: [], text: [] } } });
    assert.deepEqual(getConfig(k.t.db).invoice.layout, spec());
    k.t.close();
  });

  it('is audited with the rest of the configuration', async () => {
    const k = kit();
    await k.t.callOk(companyRoutes, 'company.config.save', { invoice: { layout: { hide: ['logo'] } } });
    const row = k.t.db.get<{ after_json: string | null }>(
      "SELECT after_json FROM audit_log WHERE entity_type = 'company_config' ORDER BY id DESC LIMIT 1",
    );
    assert.ok(row?.after_json?.includes('"layout"'), 'the saved layout is in the edit-log entry');
    k.t.close();
  });

  it('refuses unknown, locked, option-owned and over-long entries (nothing silently dropped on save)', async () => {
    const k = kit();
    const paths = await issuePaths(
      k.t.call(companyRoutes, 'company.config.save', {
        invoice: { layout: { hide: ['doc.number', 'nope', 'bank'], show: [], text: [{ id: 'declaration', value: 'x' }, { id: 'footer', value: 'x'.repeat(201) }] } },
      }),
    );
    assert.deepEqual(paths, ['invoice.layout.hide[0]', 'invoice.layout.hide[1]', 'invoice.layout.hide[2]', 'invoice.layout.text[0].id', 'invoice.layout.text[1].value']);
    assert.deepEqual(getConfig(k.t.db).invoice.layout, spec(), 'nothing saved');
    assert.deepEqual(await issuePaths(k.t.call(companyRoutes, 'company.config.save', { invoice: { layout: 'hide everything' } })), ['invoice.layout']);
    k.t.close();
  });

  it('a stored layer that is no longer valid never blocks the Invoice Printing save (whole draft sent back)', async () => {
    const k = kit();
    const cfg = getConfig(k.t.db);
    const stale = { hide: ['logo', 'doc.number', 'retired-part'], show: [], text: [{ id: 'declaration', value: 'x' }, { id: 'footer', value: 'Thanks' }] };
    k.t.db.run("UPDATE settings SET value = :v WHERE key = 'config'", { v: JSON.stringify({ ...cfg, invoice: { ...cfg.invoice, layout: stale } }) });
    const got = await k.t.callOk<CompanyConfig>(companyRoutes, 'company.config.get', {});
    assert.deepEqual(got.invoice.layout, spec({ hide: ['logo'], text: [{ id: 'footer', value: 'Thanks' }] }), 'the screens get the layer print data uses');
    // Invoice Printing sends its whole draft (layout included): accepted, and the stored layer is repaired.
    const saved = await k.t.callOk<CompanyConfig>(companyRoutes, 'company.config.save', { invoice: { ...got.invoice, terms: 'Net 15' } });
    assert.equal(saved.invoice.terms, 'Net 15');
    assert.deepEqual(getConfig(k.t.db).invoice.layout, spec({ hide: ['logo'], text: [{ id: 'footer', value: 'Thanks' }] }));
    // A save of another section returns the clean layer too (the stored one stays until the next layout save).
    k.t.db.run("UPDATE settings SET value = :v WHERE key = 'config'", { v: JSON.stringify({ ...cfg, invoice: { ...cfg.invoice, layout: stale } }) });
    const other = await k.t.callOk<CompanyConfig>(companyRoutes, 'company.config.save', { display: { showZeroBalances: true } });
    assert.deepEqual(other.invoice.layout.hide, ['logo']);
    k.t.close();
  });

  it('needs Company › Manage', async () => {
    const k = setupKit({ security: true });
    const res = await k.t.call(companyRoutes, 'company.config.save', { invoice: { layout: { hide: ['logo'] } } }, { session: k.t.sessionAs({ permissions: ['company.view', 'masters.alter'] }) });
    assert.equal(!res.ok && res.error.code, 'FORBIDDEN');
    k.t.close();
  });
});

describe('voucher-type layout: accounts.voucherType.save { config: { printLayout, … } }', () => {
  it('round-trips the layer and the four print flags; null clears each key', async () => {
    const k = kit();
    const layout = spec({ hide: ['col.discount'], show: ['logo'], text: [{ id: 'signatoryLabel', value: 'Partner' }, { id: 'copy.original', value: 'Buyer copy' }] });
    const flags = { showHsnSummary: false, showBankDetails: false, showUpiQr: true, itemwiseTax: true };
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.save', { id: k.vt.sales, config: { printLayout: layout, ...flags } });
    const got = await k.t.callOk<VoucherTypeDetail>(accountsRoutes, 'accounts.voucherType.get', { id: k.vt.sales });
    assert.deepEqual(got.config.printLayout, layout);
    assert.deepEqual([got.config.showHsnSummary, got.config.showBankDetails, got.config.showUpiQr, got.config.itemwiseTax], [false, false, true, true]);
    // Saving another key keeps them (key-level patch).
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.save', { id: k.vt.sales, config: { printTitle: 'Retail Invoice' } });
    const kept = await k.t.callOk<VoucherTypeDetail>(accountsRoutes, 'accounts.voucherType.get', { id: k.vt.sales });
    assert.deepEqual(kept.config.printLayout, layout);
    assert.equal(kept.config.showUpiQr, true);
    // null clears.
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.save', {
      id: k.vt.sales,
      config: { printLayout: null, showHsnSummary: null, showBankDetails: null, showUpiQr: null, itemwiseTax: null },
    });
    const cleared = await k.t.callOk<VoucherTypeDetail>(accountsRoutes, 'accounts.voucherType.get', { id: k.vt.sales });
    for (const key of ['printLayout', 'showHsnSummary', 'showBankDetails', 'showUpiQr', 'itemwiseTax'] as const) assert.equal(key in cleared.config, false, key);
    assert.equal(cleared.config.printTitle, 'Retail Invoice');
    k.t.close();
  });

  it('refuses ids owned by a voucher-type option and malformed flags', async () => {
    const k = kit();
    const paths = await issuePaths(
      k.t.call(accountsRoutes, 'accounts.voucherType.save', {
        id: k.vt.sales,
        config: { printLayout: { hide: ['hsnSummary', 'stamp'], show: [], text: [{ id: 'title', value: 'Bill' }, { id: 'terms', value: '' }] }, showUpiQr: 'yes' },
      }),
    );
    assert.deepEqual(paths.sort(), ['config.printLayout.hide[0]', 'config.printLayout.hide[1]', 'config.printLayout.text[0].id', 'config.printLayout.text[1].id', 'config.showUpiQr'].sort());
    k.t.close();
  });
});

// ───────────────────────────── Pass-through ─────────────────────────────

describe('buildPrintData → savedLayout', () => {
  it('empty layers by default (every existing document unchanged apart from the empty layers)', () => {
    const k = kit();
    const d = buildPrintDataFor(k.t.ctx, sale(k));
    assert.deepEqual(d.savedLayout, { company: EMPTY_PRINT_LAYOUT, voucherType: EMPTY_PRINT_LAYOUT });
    assert.equal(d.applied, undefined, 'core never applies a layout');
    assert.deepEqual(d.options.layout, spec());
    k.t.close();
  });

  it('carries the company and voucher-type layers; batch print carries each document`s own voucher-type layer', async () => {
    const k = kit();
    await k.t.callOk(companyRoutes, 'company.config.save', { invoice: { layout: { hide: ['logo'], text: [{ id: 'footer', value: 'Thanks' }] } } });
    const retail = await k.t.callOk<{ id: number }>(accountsRoutes, 'accounts.voucherType.save', { name: 'Retail Sales', parentId: k.vt.sales });
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.save', { id: retail.id, config: { printLayout: { hide: ['col.batch'], show: ['logo'] } } });
    const a = sale(k);
    const b = sale(k, { voucherTypeId: retail.id });
    const da = buildPrintDataFor(k.t.ctx, a);
    assert.deepEqual(da.savedLayout, { company: spec({ hide: ['logo'], text: [{ id: 'footer', value: 'Thanks' }] }), voucherType: EMPTY_PRINT_LAYOUT });
    const batch = await k.t.callOk<PrintBatchResult>(printRoutes, 'print.batchData', { ids: [a, b] });
    assert.deepEqual(batch.documents.map((d) => d.savedLayout?.voucherType), [spec(), spec({ hide: ['col.batch'], show: ['logo'] })]);
    assert.deepEqual(batch.documents.map((d) => d.savedLayout?.company.hide), [['logo'], ['logo']]);
    // Resolved as the renderer will: the Retail type shows the logo again and hides the batch column.
    const r = resolvePrintLayout(batch.documents[1].savedLayout?.company, batch.documents[1].savedLayout?.voucherType);
    assert.deepEqual([...r.hidden], ['col.batch']);
    k.t.close();
  });

  it('a corrupt stored company layout → empty layer and ONE log line per request (never a crash)', () => {
    const k = kit();
    const a = sale(k);
    const b = sale(k);
    const cfg = getConfig(k.t.db);
    const store = (layout: unknown): void => {
      k.t.db.run("UPDATE settings SET value = :v WHERE key = 'config'", { v: JSON.stringify({ ...cfg, invoice: { ...cfg.invoice, layout } }) });
    };
    store({ hide: 'logo', show: 7, text: 'x' });
    k.t.logs.length = 0;
    const out = buildBatch(k.t.ctx, [a, b]);
    assert.deepEqual(out.documents.map((d) => d.savedLayout?.company), [EMPTY_PRINT_LAYOUT, EMPTY_PRINT_LAYOUT]);
    const lines = k.t.logs.filter((l) => l.message.startsWith('Print layout'));
    assert.equal(lines.length, 1, JSON.stringify(k.t.logs));
    assert.equal(lines[0].level, 'warn');
    assert.deepEqual(lines[0].meta, { paths: ['hide', 'show', 'text'] }, 'paths only, never the stored values');
    assert.equal(lines[0].message.includes('logo'), false);
    // Partly bad: the good entries are kept, the bad ones dropped (locked, unknown, legacy, too long).
    store({ hide: ['doc.number', 'logo', 'bank', 'zzz'], show: [], text: [{ id: 'footer', value: 'y'.repeat(500) }, { id: 'notes', value: 'Fine' }] });
    const d = buildPrintDataFor(k.t.ctx, a);
    assert.deepEqual(d.savedLayout?.company, spec({ hide: ['logo'], text: [{ id: 'footer', value: 'y'.repeat(200) }, { id: 'notes', value: 'Fine' }] }));
    // Not even JSON.
    k.t.db.run("UPDATE settings SET value = '{not json' WHERE key = 'config'");
    assert.deepEqual(buildPrintDataFor(k.t.ctx, a).savedLayout?.company, EMPTY_PRINT_LAYOUT);
    k.t.close();
  });

  it('a corrupt stored voucher-type layout or config → empty layer, the document still prints', () => {
    const k = kit();
    const a = sale(k);
    k.t.db.run('UPDATE voucher_types SET config = :c WHERE id = :id', { c: JSON.stringify({ printLayout: { hide: ['entries', 42, 'logo'], text: [{ id: 'title', value: 'x' }] } }), id: k.vt.sales });
    k.t.logs.length = 0;
    const d = buildPrintDataFor(k.t.ctx, a);
    assert.deepEqual(d.savedLayout?.voucherType, spec({ hide: ['logo'] }), 'locked, malformed and printTitle-owned entries dropped');
    assert.equal(k.t.logs.filter((l) => l.message.startsWith('Print layout of voucher type')).length, 1);
    k.t.db.run("UPDATE voucher_types SET config = '[1,2' WHERE id = :id", { id: k.vt.sales });
    const e = buildPrintDataFor(k.t.ctx, a);
    assert.deepEqual(e.savedLayout?.voucherType, EMPTY_PRINT_LAYOUT);
    assert.equal(e.totals.grandTotal, d.totals.grandTotal);
    k.t.close();
  });

  it('legacy shadowing: a voucher-type Print title beats the company title text; the preview signatory beats the voucher-type text', async () => {
    const k = kit();
    await k.t.callOk(companyRoutes, 'company.config.save', { invoice: { layout: { text: [{ id: 'title', value: 'Bill' }, { id: 'footer', value: 'f' }] } } });
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.save', { id: k.vt.sales, config: { printLayout: { text: [{ id: 'signatoryLabel', value: 'Partner' }] } } });
    const id = sale(k);
    const plain = await k.t.callOk<PrintVoucherData>(printRoutes, 'print.voucherData', { id });
    assert.deepEqual(plain.savedLayout?.company.text.map((t) => t.id), ['title', 'footer']);
    assert.deepEqual(plain.savedLayout?.voucherType.text.map((t) => t.id), ['signatoryLabel']);
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.save', { id: k.vt.sales, config: { printTitle: 'Retail Invoice' } });
    const titled = await k.t.callOk<PrintVoucherData>(printRoutes, 'print.voucherData', { id, overrides: { signatoryLabel: 'Owner' } });
    assert.equal(titled.title, 'Retail Invoice');
    assert.deepEqual(titled.savedLayout?.company.text.map((t) => t.id), ['footer']);
    assert.deepEqual(titled.savedLayout?.voucherType.text, []);
    assert.equal(titled.signatoryLabel, 'Owner');
    const applied = applyPrintLayout(titled, resolvePrintLayout(titled.savedLayout?.company, titled.savedLayout?.voucherType));
    assert.deepEqual([applied.title, applied.signatoryLabel], ['Retail Invoice', 'Owner']);
    k.t.close();
  });

  it('print.sample carries the company layer and an empty voucher-type layer', async () => {
    const k = kit();
    await k.t.callOk(companyRoutes, 'company.config.save', { invoice: { layout: { hide: ['logo'] } } });
    const d = await k.t.callOk<PrintVoucherData>(printRoutes, 'print.sample', {});
    assert.deepEqual(d.savedLayout, { company: spec({ hide: ['logo'] }), voucherType: EMPTY_PRINT_LAYOUT });
    k.t.close();
  });

  it('preview overrides accept the whole Invoice Printing draft (layout included) and ignore its layout', async () => {
    const k = kit();
    await k.t.callOk(companyRoutes, 'company.config.save', { invoice: { layout: { hide: ['logo'] } } });
    const id = sale(k);
    const draft = { ...getConfig(k.t.db).invoice, layout: { hide: ['not-a-part'], junk: true } };
    const d = await k.t.callOk<PrintVoucherData>(printRoutes, 'print.voucherData', { id, overrides: draft });
    assert.deepEqual(d.options.layout, spec({ hide: ['logo'] }));
    assert.deepEqual(d.savedLayout?.company, spec({ hide: ['logo'] }));
    const s = await k.t.callOk<PrintVoucherData>(printRoutes, 'print.sample', { overrides: draft });
    assert.deepEqual(s.savedLayout?.company, spec({ hide: ['logo'] }));
    k.t.close();
  });
});

describe('resolveOptions — the four voucher-type print flags sit between Invoice Printing and the preview overrides', () => {
  it('options.layout is the validated company layer; an override `layout` never replaces it', async () => {
    const k = kit();
    await k.t.callOk(companyRoutes, 'company.config.save', { invoice: { layout: { hide: ['logo'] } } });
    const env = loadPrintEnv(k.t.ctx);
    const junk = { hide: ['doc.number', 'nope'], show: [], text: [] } as unknown as PrintLayoutSpec;
    assert.deepEqual(resolveOptions(env, {}, { layout: junk, showMrp: true }).layout, spec({ hide: ['logo'] }));
    assert.equal(resolveOptions(env, {}, { layout: junk, showMrp: true }).showMrp, true);
    k.t.close();
  });

  it('bank details, HSN summary, UPI QR and item-wise tax per voucher type', async () => {
    const k = kit();
    await k.t.callOk(companyRoutes, 'company.config.save', { invoice: { showBankDetails: true, bankLedgerId: k.L.bank, showHsnSummary: true, showUpiQr: false, upiId: 'shop@okhdfcbank', itemwiseTax: false } });
    const id = sale(k);
    const base = buildPrintDataFor(k.t.ctx, id);
    assert.equal(base.bank?.accountNo, '50100012345678');
    assert.equal(base.upi, null);
    assert.deepEqual([base.options.showHsnSummary, base.options.itemwiseTax], [true, false]);

    await k.t.callOk(accountsRoutes, 'accounts.voucherType.save', { id: k.vt.sales, config: { showBankDetails: false, showHsnSummary: false, showUpiQr: true, itemwiseTax: true } });
    const vt = buildPrintDataFor(k.t.ctx, id);
    assert.equal(vt.bank, null, 'voucher type hides bank details');
    assert.equal(vt.upi?.id, 'shop@okhdfcbank', 'voucher type shows the UPI QR');
    assert.deepEqual([vt.options.showBankDetails, vt.options.showHsnSummary, vt.options.showUpiQr, vt.options.itemwiseTax], [false, false, true, true]);
    assert.equal(vt.totals.grandTotal, base.totals.grandTotal);

    // Preview overrides beat the voucher type.
    const over = await k.t.callOk<PrintVoucherData>(printRoutes, 'print.voucherData', { id, overrides: { showBankDetails: true, itemwiseTax: false } });
    assert.equal(over.bank?.accountNo, '50100012345678');
    assert.equal(over.options.itemwiseTax, false);

    // null → as in Invoice Printing again.
    await k.t.callOk(accountsRoutes, 'accounts.voucherType.save', { id: k.vt.sales, config: { showBankDetails: null, showHsnSummary: null, showUpiQr: null, itemwiseTax: null } });
    const back = buildPrintDataFor(k.t.ctx, id);
    assert.deepEqual([back.bank?.accountNo, back.upi, back.options.showHsnSummary, back.options.itemwiseTax], ['50100012345678', null, true, false]);
    k.t.close();
  });
});

// ───────────────────────────── Real documents ─────────────────────────────

describe('applyPrintLayout and layoutWarnings on documents built from real vouchers', () => {
  function documents(k: Kit): PrintVoucherData[] {
    const ids = [
      sale(k),
      sale(k, { partyLedgerId: k.L.blr }),
      save(k, { voucherTypeId: k.vt.delivery_note, date: DATE, mode: 'inventory', partyLedgerId: k.L.acme, items: [{ itemId: k.I.rice, qty: 5, rate: 50 }] }).id,
      save(k, {
        voucherTypeId: k.vt.payment,
        date: DATE,
        mode: 'ledger',
        narration: 'Advance',
        ledgers: [
          { ledgerId: k.L.supplier, amount: 100000 },
          { ledgerId: k.L.bank, amount: -100000 },
        ],
      }).id,
    ];
    return ids.map((id) => buildPrintDataFor(k.t.ctx, id));
  }

  it('every part hidden at once and one at a time: amounts, totals and tax rows untouched', () => {
    const k = kit();
    const every = (PRINT_PARTS as readonly PrintPartDef[]).map((p) => p.id as PrintPartId);
    for (const doc of documents(k)) {
      const before = structuredClone(doc);
      for (const layout of [resolvePrintLayout({ hide: every, show: [], text: [] }), ...every.map((id) => resolvePrintLayout({ hide: [id], show: [], text: [] }))]) {
        const out = applyPrintLayout(doc, layout);
        assert.equal(out.lines, doc.lines);
        assert.equal(out.totals, doc.totals);
        assert.equal(out.taxByRate, doc.taxByRate);
        assert.equal(out.taxByHsn, doc.taxByHsn);
        assert.equal(out.entries, doc.entries);
        assert.equal(out.charges, doc.charges);
      }
      assert.deepEqual(doc, before, `${doc.title}: never mutated`);
    }
    k.t.close();
  });

  it('statutory warnings by kind on real documents', () => {
    const k = kit();
    const [b2b, interState, challan, payment] = documents(k);
    const w = (d: PrintVoucherData, ...ids: PrintPartId[]): string[] => layoutWarnings(d, resolvePrintLayout({ hide: ids, show: [], text: [] }));
    assert.deepEqual(w(b2b, 'party.gstin'), ["Hidden on this print: the buyer's GSTIN — required on a B2B tax invoice (Rule 46(d))."]);
    assert.deepEqual(w(b2b, 'placeOfSupply'), [], 'intra-State');
    assert.deepEqual(w(interState, 'placeOfSupply'), ['Hidden on this print: the place of supply — required on an inter-State tax invoice (Rule 46(n)).']);
    assert.deepEqual(w(challan, 'signature'), ['Hidden on this print: the signature — required on a delivery challan (Rule 55).']);
    assert.deepEqual(w(payment, 'signature', 'party', 'title'), []);
    k.t.close();
  });
});
