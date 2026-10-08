import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrintBankOption, PrintBatchResult, PrintVoucherData } from '../../../shared/types/print.ts';
import { save, setupKit } from '../vouchers/testkit.ts';
import { printRoutes } from './routes.ts';
import { sampleGstin } from './sample.ts';
import { validateGstin } from '../../../shared/gst/index.ts';

function sale(k: ReturnType<typeof setupKit>): number {
  return save(k, { voucherTypeId: k.vt.sales, date: '2026-04-15', mode: 'item_invoice', partyLedgerId: k.L.acme, items: [{ itemId: k.I.rice, qty: 10, rate: 50 }] }).id;
}

describe('print routes (through the dispatcher)', () => {
  it('print.voucherData returns the document; overrides apply to the preview only', async () => {
    const k = setupKit();
    const id = sale(k);
    const d = await k.t.callOk<PrintVoucherData>(printRoutes, 'print.voucherData', { id, overrides: { template: 'classic', upiId: '' } });
    assert.equal(d.title, 'Tax Invoice');
    assert.equal(d.defaultTemplate, 'classic');
    // 500.00 @5% → 525.00
    assert.equal(d.totals.grandTotal, 52500);
    const again = await k.t.callOk<PrintVoucherData>(printRoutes, 'print.voucherData', { id });
    assert.equal(again.defaultTemplate, 'modern');
    k.t.close();
  });

  it('needs vouchers.view', async () => {
    const k = setupKit({ security: true });
    const id = sale(k);
    const res = await k.t.call(printRoutes, 'print.voucherData', { id }, { session: k.t.sessionAs({ permissions: ['company.view'] }) });
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.error.code, 'FORBIDDEN');
    k.t.close();
  });

  it('rejects an invalid UPI id override and an empty batch', async () => {
    const k = setupKit();
    const id = sale(k);
    const bad = await k.t.call(printRoutes, 'print.voucherData', { id, overrides: { upiId: 'not a vpa' } });
    assert.equal(!bad.ok && bad.error.code, 'VALIDATION');
    const empty = await k.t.call(printRoutes, 'print.batchData', { ids: [] });
    assert.equal(!empty.ok && empty.error.code, 'VALIDATION');
    k.t.close();
  });

  it('print.batchData', async () => {
    const k = setupKit();
    const a = sale(k);
    const out = await k.t.callOk<PrintBatchResult>(printRoutes, 'print.batchData', { ids: [a, 777] });
    assert.deepEqual(out.documents.map((d) => d.id), [a]);
    assert.deepEqual(out.notFound, [777]);
    k.t.close();
  });

  it('print.sample builds a tying sample invoice from the company profile', async () => {
    const k = setupKit();
    const d = await k.t.callOk<PrintVoucherData>(printRoutes, 'print.sample', { overrides: { showUpiQr: true, upiId: 'shop@okaxis' } });
    // Bottle 10 × 450 = 4,500.00 @18% → CGST 405.00 + SGST 405.00
    // Rice 4 × 625 = 2,500.00 − 5% = 2,375.00 @5% → CGST 59.375 → 59.38, SGST 59.38 (each head rounded) = 118.76
    // Taxable 6,875.00 + tax 928.76 = 7,803.76 → 7,804.00 (round off +0.24)
    assert.equal(d.sample, true);
    assert.equal(d.title, 'Tax Invoice');
    assert.deepEqual([d.totals.taxable, d.totals.tax, d.totals.roundOff, d.totals.grandTotal], [687500, 92876, 24, 780400]);
    assert.equal(d.totals.taxable + d.totals.tax + d.totals.roundOff, d.totals.grandTotal);
    assert.equal(d.upi?.uri.includes('am=7804.00'), true);
    assert.equal(validateGstin(d.party?.gstin ?? '').valid, true);
    assert.equal(validateGstin(sampleGstin('29')).valid, true);
    k.t.close();
  });

  it('print.bankLedgers lists bank accounts with their details', async () => {
    const k = setupKit();
    const banks = await k.t.callOk<PrintBankOption[]>(printRoutes, 'print.bankLedgers', {});
    const hdfc = banks.find((b) => b.ledgerName === 'HDFC Bank');
    assert.equal(hdfc?.accountNo, '50100012345678');
    assert.equal(banks.some((b) => b.ledgerName === 'Cash'), false);
    k.t.close();
  });
});
