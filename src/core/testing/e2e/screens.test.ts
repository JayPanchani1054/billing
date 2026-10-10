/**
 * API-level twin of the setup of e2e/screens.spec.ts (the every-screen sweep): EVERY F11 feature the
 * Features screen changes switched on in one save, then the same seed (parityFlow.ts) and the same
 * vouchers the spec creates through window.pevqori.api — so the sweep never starts from a setup the core
 * refuses (e.g. a master that needs a godown or a batch once Multiple godowns / Batches are on).
 * Also pins that the company's reports agree with everything on.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_FEATURES } from '../../../shared/settings.ts';
import type { CompanyFeatures } from '../../../shared/settings.ts';
import type { VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { startRuntime } from './harness.ts';
import type { E2E } from './harness.ts';
import { chequePaymentInput, exportInvoiceInput, financialYearOf, PARITY, quotationInput, seedParityMasters } from './parityFlow.ts';
import type { ApiCall, ParityMasters } from './parityFlow.ts';

const T = PARITY.today;

describe('every-screen sweep setup (API twin of e2e/screens.spec.ts)', () => {
  let e: E2E;
  let m: ParityMasters;

  before(() => {
    e = startRuntime(T);
  });
  after(async () => {
    await e.close();
  });

  it('turns every F11 feature on (all but password protection, which has its own screen)', async () => {
    const s = await e.call<{ dataDir: string }>('app.state');
    await e.call('app.dataDir.set', { path: s.dataDir, mode: 'use' });
    await e.call('app.company.create', {
      name: 'Every Screen Traders E2E',
      stateCode: PARITY.company.stateCode,
      gstRegistrationType: 'regular',
      gstin: PARITY.company.gstin,
      pan: PARITY.company.pan,
      booksFrom: financialYearOf(T).from,
      fyStartMonth: 4,
      features: { inventory: true, multipleGodowns: false, batches: false, billWise: true, costCentres: false, orderProcessing: false, einvoice: false, ewayBill: false, gst: true },
    });
    const keys = (Object.keys(DEFAULT_FEATURES) as Array<keyof CompanyFeatures>).filter((k) => k !== 'security');
    const f = await e.call<CompanyFeatures>('company.features.save', Object.fromEntries(keys.map((k) => [k, true])));
    for (const k of keys) assert.equal(f[k], true, k);
    assert.equal(f.security, false);
  });

  it('seeds the masters and saves a voucher of each kind the sweep lists', async () => {
    const call: ApiCall = <R>(route: string, input?: unknown) => e.call<R>(route, input);
    m = await seedParityMasters(call, T);
    const q = await e.call<VoucherSaveResult>('vouchers.save', quotationInput(m, T));
    assert.equal(q.number, '1');
    const sale = await e.call<VoucherSaveResult>('vouchers.save', {
      voucherTypeId: m.types.sales,
      date: T,
      mode: 'item_invoice',
      partyLedgerId: m.customer,
      items: [{ itemId: m.item, qty: 2, rate: 100 }],
      acknowledgeWarnings: true,
    });
    assert.equal(sale.totals.grandTotal, 23_600); // 2 × ₹100 = ₹200 + 18 % = ₹236.00
    const purchase = await e.call<VoucherSaveResult>('vouchers.save', {
      voucherTypeId: m.types.purchase,
      date: T,
      mode: 'accounting_invoice',
      partyLedgerId: m.supplier,
      referenceNo: PARITY.tds.supplierInvoiceNo,
      ledgers: [{ ledgerId: m.expense, amount: PARITY.tds.amount }],
      acknowledgeWarnings: true,
    });
    assert.equal(purchase.totals.grandTotal, PARITY.tds.total);
    assert.equal((await e.call<VoucherSaveResult>('vouchers.save', exportInvoiceInput(m, T))).totals.grandTotal, PARITY.forex.inr);
    assert.ok((await e.call<VoucherSaveResult>('vouchers.save', chequePaymentInput(m, T))).id > 0);
  });

  it('the Day Book lists them for the working date (the id screens are opened from it)', async () => {
    const list = await e.call<{ rows: Array<{ partyName: string | null }>; total: number }>('vouchers.list', { from: T, to: T });
    assert.ok(list.total >= 5, String(list.total));
    assert.ok(list.rows.some((r) => r.partyName === PARITY.customer.name));
  });

  it('with everything on, the Trial Balance agrees and the Balance Sheet balances', async () => {
    const tb = await e.call<{ totals: { debit: number; credit: number } }>('reports.trialBalance', { from: financialYearOf(T).from, to: T });
    assert.equal(tb.totals.debit, tb.totals.credit);
    const bs = await e.call<{ balanced: boolean; openingDifference: number }>('reports.balanceSheet', { asOf: T, mode: 'condensed' });
    assert.equal(bs.balanced, true);
    // The seed enters opening stock (100 Nos × ₹60.00) without a capital opening balance: the Balance
    // Sheet reports that as the opening difference (as accountants expect), Dr side → −₹6,000.00.
    assert.equal(bs.openingDifference, -PARITY.item.openingQty * PARITY.item.openingRate * 100);
  });
});
