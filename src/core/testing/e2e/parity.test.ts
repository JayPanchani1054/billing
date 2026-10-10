/**
 * API-level twin of the Playwright flows in e2e/parity.spec.ts: the parity features used the way
 * the screens use them, through runtime.dispatch exactly as the Electron main process does.
 *
 *   company (wizard defaults) → F11: TDS, multiple currencies, cheque printing, manufacturing, POS →
 *   masters (parityFlow.ts, the same calls the spec makes through window.pevqori.api) →
 *   quotation → converted into Sales 1 → POS bill, split tender UPI + cash with change →
 *   purchase with the TDS auto-line → export invoice in US$ → Manufacturing Journal from the BOM →
 *   print data (Modern on A4/A5, Compact on the 80 mm roll) → cheque of a payment → books balance.
 *
 * Masters, inputs and figures come from parityFlow.ts (shared with the spec) — see its header for the
 * arithmetic. The Playwright spec cannot run in the dev container (no Electron); this test pins every
 * route and figure it relies on.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ChequePrintData } from '../../../shared/types/cheques.ts';
import type { ForexVoucherDetail } from '../../../shared/types/forex.ts';
import type { ProductionRegisterResult } from '../../../shared/types/mfg.ts';
import type { PosContext, PosItemLookupResult } from '../../../shared/types/pos.ts';
import type { PrintVoucherData } from '../../../shared/types/print.ts';
import type { VoucherPreview, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { makeGstin, TEST_PAN } from '../fixtures.ts';
import { startRuntime } from './harness.ts';
import type { E2E } from './harness.ts';
import { chequePaymentInput, exportInvoiceInput, financialYearOf, PARITY, quotationInput, seedParityMasters } from './parityFlow.ts';
import type { ApiCall, ParityMasters } from './parityFlow.ts';

const T = PARITY.today;

describe('parity flows (API twin of e2e/parity.spec.ts)', () => {
  let e: E2E;
  let m: ParityMasters;
  let call: ApiCall;
  let quotation = 0;
  let sales1 = 0;
  let posBill = 0;

  before(() => {
    e = startRuntime(T);
    call = <R>(route: string, input?: unknown): Promise<R> => e.call<R>(route, input);
  });
  after(async () => {
    await e.close();
  });

  it('uses fictional, checksum-valid GSTINs and the financial year of the working date', () => {
    assert.equal(makeGstin('27'), PARITY.company.gstin);
    assert.equal(PARITY.company.pan, TEST_PAN);
    assert.equal(makeGstin('27', PARITY.tds.pan), PARITY.tds.supplierGstin);
    assert.deepEqual(financialYearOf('2026-10-09'), { from: '2026-04-01', to: '2027-03-31' });
    assert.deepEqual(financialYearOf('2027-03-31'), { from: '2026-04-01', to: '2027-03-31' });
    assert.deepEqual(financialYearOf('2026-04-01'), { from: '2026-04-01', to: '2027-03-31' });
  });

  it('creates the company as the wizard does and turns the parity features on (F11)', async () => {
    const s = await e.call<{ dataDir: string }>('app.state');
    await e.call('app.dataDir.set', { path: s.dataDir, mode: 'use' });
    await e.call('app.company.create', {
      name: PARITY.company.name,
      stateCode: PARITY.company.stateCode,
      gstRegistrationType: 'regular',
      gstin: PARITY.company.gstin,
      pan: PARITY.company.pan,
      booksFrom: financialYearOf(T).from,
      fyStartMonth: 4,
      features: { inventory: true, multipleGodowns: false, batches: false, billWise: true, costCentres: false, orderProcessing: false, einvoice: false, ewayBill: false, gst: true },
    });
    const patch = Object.fromEntries(PARITY.features.map((k) => [k, true]));
    const f = await e.call<Record<string, boolean>>('company.features.save', patch);
    for (const k of PARITY.features) assert.equal(f[k], true, k);
    m = await seedParityMasters(call, T);
    assert.ok(m.types.quotation > 0 && m.types.sales > 0 && m.types.purchase > 0 && m.types.payment > 0);
  });

  it('quotation → Sales 1: the conversion saves without a confirmation and links back', async () => {
    const q = await e.call<VoucherSaveResult>('vouchers.save', quotationInput(m, T));
    quotation = q.id;
    assert.equal(q.number, '1');
    assert.equal(q.totals.grandTotal, PARITY.quotation.total);
    // Quotation Register › Alt+V → voucher entry pre-filled by documents.draft → Ctrl+A.
    const draft = await e.call<Record<string, unknown>>('documents.draft', { sourceId: quotation, targetBaseType: 'sales', date: T });
    assert.equal(draft.convertedFromId, quotation);
    const inv = await e.call<VoucherSaveResult>('vouchers.save', draft); // no acknowledgeWarnings: stock is on hand
    sales1 = inv.id;
    assert.equal(inv.number, '1');
    assert.equal(inv.totals.grandTotal, PARITY.quotation.total);
    const list = await e.call<{ rows: Array<{ id: number; status: string; convertedTo: { id: number; voucherTypeName: string; number: string | null } | null; amount: number }> }>(
      'documents.quotation.list',
      { baseType: 'quotation', ...financialYearOf(T) },
    );
    assert.deepEqual(
      list.rows.map((r) => [r.id, r.status, r.convertedTo && `${r.convertedTo.voucherTypeName} ${r.convertedTo.number}`, r.amount]),
      [[quotation, 'converted', 'Sales 1', PARITY.quotation.total]],
    );
  });

  it('POS: scan by barcode, pay UPI + cash with change, saved as POS/1', async () => {
    const ctx = await e.call<PosContext>('pos.context', {});
    assert.equal(ctx.enabled, true);
    assert.deepEqual(ctx.tenderModes.map((t) => [t.name, t.kind]), [
      ['Cash', 'cash'],
      [PARITY.pos.upiMode, 'upi'],
      ['Exchange credit', 'exchange'],
    ]);
    const hit = await e.call<PosItemLookupResult>('pos.item.lookup', { code: PARITY.item.barcode, date: T });
    assert.equal(hit.item?.itemId, m.item);
    assert.equal(hit.item?.mrp, PARITY.item.mrp);
    // The counter bills the scanned item at its selling price, exclusive of GST (₹100.00 + 18 %).
    assert.deepEqual([hit.item?.matchedBy, hit.item?.sellingRate, hit.item?.rateInclusiveOfTax, hit.item?.stock], ['barcode', PARITY.item.sellingPrice / 100, false, PARITY.item.openingQty - PARITY.quotation.qty]);
    const cash = ctx.tenderModes.find((t) => t.kind === 'cash')?.id;
    const input = {
      voucherTypeId: ctx.saleVoucherTypeId,
      date: T,
      mode: 'item_invoice',
      partyLedgerId: ctx.walkIn?.id,
      placeOfSupply: ctx.companyStateCode ?? undefined,
      items: [{ itemId: m.item, qty: PARITY.pos.qty, rate: hit.item?.sellingRate }],
      posBill: { tenders: [{ modeId: cash, amount: PARITY.pos.cash }, { modeId: m.upiMode, amount: PARITY.pos.upi }], cashTendered: PARITY.pos.tendered },
    };
    const pv = await e.call<VoucherPreview>('vouchers.preview', input);
    assert.equal(pv.totals.grandTotal, PARITY.pos.total);
    assert.equal(pv.posBill?.change, PARITY.pos.change);
    const saved = await e.call<VoucherSaveResult>('vouchers.save', input);
    posBill = saved.id;
    assert.equal(saved.number, 'POS/1');
    const pos = await e.call<{ paid: number; change: number; credit: number; tenders: Array<{ name: string; amount: number }> }>('pos.voucher', { id: posBill });
    assert.deepEqual([pos.paid, pos.change, pos.credit], [PARITY.pos.total, PARITY.pos.change, 0]);
    assert.deepEqual(pos.tenders.map((t) => [t.name, t.amount]).sort(), [
      ['Cash', PARITY.pos.cash],
      [PARITY.pos.upiMode, PARITY.pos.upi],
    ]);
  });

  it('purchase in accounting-invoice mode gets the TDS auto-line (194C, ₹800.00)', async () => {
    const input = {
      voucherTypeId: m.types.purchase,
      date: T,
      mode: 'accounting_invoice',
      partyLedgerId: m.supplier,
      referenceNo: PARITY.tds.supplierInvoiceNo,
      ledgers: [{ ledgerId: m.expense, amount: PARITY.tds.amount }],
    };
    const pv = await e.call<{ tds?: { tds: number; lines: Array<{ section: string; amount: number }> } }>('vouchers.preview', input);
    assert.equal(pv.tds?.tds, PARITY.tds.tds);
    assert.deepEqual(pv.tds?.lines.map((l) => [l.section, l.amount]), [[PARITY.tds.section, PARITY.tds.tds]]);
    // Saved without acknowledgeWarnings: the screen's Ctrl+A saves it without a confirmation.
    const saved = await e.call<VoucherSaveResult>('vouchers.save', input);
    assert.deepEqual(saved.warnings, []);
    assert.equal(saved.number, '1');
    assert.equal(saved.totals.grandTotal, PARITY.tds.total);
    const v = await e.call<{ entries: Array<{ ledgerName: string; amount: number }> }>('vouchers.get', { id: saved.id });
    const by = Object.fromEntries(v.entries.map((x) => [x.ledgerName, x.amount]));
    assert.equal(by[PARITY.tds.supplier], -PARITY.tds.partyCredit);
    assert.equal(by[`TDS Payable – ${PARITY.tds.section}`], -PARITY.tds.tds);
  });

  it('export invoice in US$ under LUT: ₹1,66,000.00, rate 83, shown by the forex panel', async () => {
    const saved = await e.call<VoucherSaveResult>('vouchers.save', exportInvoiceInput(m, T));
    assert.equal(saved.number, '2', 'Sales 2: the same GST invoice series as the converted invoice');
    assert.equal(saved.totals.grandTotal, PARITY.forex.inr);
    const fx = await e.call<ForexVoucherDetail>('forex.voucher', { id: saved.id });
    assert.deepEqual([fx.currency?.isoCode, fx.documentForex, fx.rate], ['USD', PARITY.forex.amount, PARITY.forex.rate]);
    assert.deepEqual(fx.entries.map((x) => [x.ledgerName, x.forexAmount, x.amount]), [[PARITY.forex.customer, PARITY.forex.amount, PARITY.forex.inr]]);
    const doc = await e.call<PrintVoucherData>('print.voucherData', { id: saved.id });
    assert.ok(doc.forex, 'the invoice prints its foreign-currency block');
  });

  it('Manufacturing Journal from the default BOM: 2 kits consume 10 bolts, ₹600.00', async () => {
    const types = await e.call<Array<{ id: number; class: string; name: string }>>('mfg.journal.types', {});
    const mj = types.find((t) => t.class === 'manufacturing');
    assert.ok(mj, JSON.stringify(types));
    assert.equal(mj.name, 'Manufacturing Journal');
    const boms = await e.call<{ rows: Array<{ id: number; itemId: number; isDefault: boolean }> }>('mfg.bom.list', { itemId: m.kit });
    assert.deepEqual(boms.rows.map((b) => [b.id, b.isDefault]), [[m.bom, true]], 'the only BOM is the default the screen picks');
    const saved = await e.call<VoucherSaveResult>('vouchers.save', {
      voucherTypeId: mj.id,
      date: T,
      mode: 'inventory',
      stockJournal: {
        bomId: m.bom,
        lines: [
          { role: 'product', itemId: m.kit, qty: PARITY.kit.qty },
          { role: 'component', itemId: m.item, qty: PARITY.kit.consumed },
        ],
      },
    });
    assert.equal(saved.number, '1');
    const reg = await e.call<ProductionRegisterResult>('mfg.production.register', { ...financialYearOf(T) });
    assert.deepEqual(
      reg.rows.map((r) => [r.typeName, r.number, r.itemName, r.qty, r.bomName, r.consumed, r.productValue, r.productRate]),
      [['Manufacturing Journal', '1', PARITY.kit.name, PARITY.kit.qty, 'Standard', PARITY.kit.cost, PARITY.kit.cost, PARITY.kit.cost / 100 / PARITY.kit.qty]],
    );
  });

  it('print data: Sales 1 prints on the Modern template, the POS bill on the Compact roll', async () => {
    const inv = await e.call<PrintVoucherData>('print.voucherData', { id: sales1 });
    assert.equal(inv.party?.name, PARITY.customer.name);
    assert.equal(inv.defaultTemplate, 'modern');
    assert.equal(inv.totals.grandTotal, PARITY.quotation.total);
    const bill = await e.call<PrintVoucherData>('print.voucherData', { id: posBill });
    assert.equal(bill.defaultTemplate, 'compact');
    assert.equal(bill.pos?.change, PARITY.pos.change);
  });

  it('cheque of a payment: next leaf, payee, amount in words and figures', async () => {
    const pay = await e.call<VoucherSaveResult>('vouchers.save', chequePaymentInput(m, T));
    const data = await e.call<ChequePrintData>('cheques.print.data', { voucherIds: [pay.id] });
    assert.equal(data.cheques.length, 1);
    const c = data.cheques[0];
    assert.deepEqual([c.chequeNo, c.payee, c.amountWords, c.amountFigures, c.amount], [PARITY.cheque.leaf, PARITY.cheque.payee, PARITY.cheque.words, PARITY.cheque.figures, PARITY.cheque.amount]);
  });

  it('the books still balance', async () => {
    const tb = await e.call<{ totals: { debit: number; credit: number } }>('reports.trialBalance', { from: financialYearOf(T).from, to: T });
    assert.equal(tb.totals.debit, tb.totals.credit);
  });
});
