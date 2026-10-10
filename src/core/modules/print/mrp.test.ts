/**
 * (print group) MRP on printed documents: per-line MRP from the item master, the MRP summary and the
 * buyer's saving, the F12 / voucher-type switch, and the Legal Metrology warning for a sale above MRP.
 * Company: Maharashtra, vouchers testkit (rice 5%, mixer 18%, party Acme in 27).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { saveConfig } from '../company/service.ts';
import { saveVoucherType } from '../accounts/voucherTypes.ts';
import { save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { buildPrintDataFor, mrpSummaryOf } from './data.ts';
import { buildSampleData } from './sample.ts';
import { loadPrintEnv } from './data.ts';

const DATE = '2026-04-15';

function withMrp(k: Kit, rice: number | null, mixer: number | null): void {
  k.t.db.run('UPDATE stock_items SET mrp = :m WHERE id = :id', { m: rice, id: k.I.rice });
  k.t.db.run('UPDATE stock_items SET mrp = :m WHERE id = :id', { m: mixer, id: k.I.mixer });
  k.t.db.run('UPDATE ledgers SET address = :a WHERE id = :id', { a: '12, MG Road, Pune', id: k.L.acme });
}

function sale(k: Kit): number {
  return save(k, {
    voucherTypeId: k.vt.sales,
    date: DATE,
    mode: 'item_invoice',
    partyLedgerId: k.L.acme,
    items: [
      { itemId: k.I.rice, qty: 10, rate: 50 },
      { itemId: k.I.mixer, qty: 2, rate: 150, discountPct: 10 },
    ],
  }).id;
}

describe('MRP on printed invoices', () => {
  it('carries the item MRP per line and works out what the buyer saved', () => {
    const k = setupKit();
    // Rice MRP ₹60 (10 × 60 = 600.00; charged 500.00 + 5% = 525.00 → saved 75.00).
    // Mixer MRP ₹165 (2 × 165 = 330.00; charged 270.00 + 18% = 318.60 → saved 11.40).
    withMrp(k, 60_00, 165_00);
    saveConfig(k.t.ctx, { invoice: { showMrp: true } });
    const d = buildPrintDataFor(k.t.ctx, sale(k));
    assert.deepEqual(
      d.lines.map((l) => l.mrp),
      [60_00, 165_00],
    );
    assert.deepEqual(d.mrpSummary, { show: true, mrpValue: 930_00, savings: 86_40 });
    assert.equal(d.warnings.some((w) => /MRP/.test(w)), false);
  });

  it('is off unless F12 or the voucher type turns it on; the voucher type wins', () => {
    const k = setupKit();
    withMrp(k, 60_00, null);
    const id = sale(k);
    assert.equal(buildPrintDataFor(k.t.ctx, id).mrpSummary?.show, false, 'F12 default: off');
    saveVoucherType(k.t.ctx, { id: k.vt.sales, config: { showMrp: true } });
    const d = buildPrintDataFor(k.t.ctx, id);
    // Only rice has an MRP: 10 × 60.00 = 600.00; saved 600.00 − 525.00 = 75.00.
    assert.deepEqual(d.mrpSummary, { show: true, mrpValue: 600_00, savings: 75_00 });
    assert.equal(d.lines[1].mrp, null);
    saveConfig(k.t.ctx, { invoice: { showMrp: true } });
    saveVoucherType(k.t.ctx, { id: k.vt.sales, config: { showMrp: false } });
    assert.equal(buildPrintDataFor(k.t.ctx, id).mrpSummary?.show, false, 'type says no');
    // Preview overrides (print settings) apply on top.
    assert.equal(buildPrintDataFor(k.t.ctx, id, { showMrp: true }).mrpSummary?.show, true);
  });

  it('warns when a line is sold above its MRP (Legal Metrology), whatever the print option', () => {
    const k = setupKit();
    // Mixer MRP ₹150: 2 × 150 = 300.00 < 318.60 charged incl. GST.
    withMrp(k, null, 150_00);
    const d = buildPrintDataFor(k.t.ctx, sale(k));
    const w = d.warnings.find((x) => /above the item's MRP/.test(x));
    assert.ok(w, d.warnings.join(' | '));
    assert.match(w, /Line 2 \(Mixer/);
    assert.match(w, /Legal Metrology \(Packaged Commodities\) Rules, 2011/);
    assert.deepEqual(d.mrpSummary, { show: false, mrpValue: 300_00, savings: 0 });
  });

  it('purchases carry no MRP summary; summaries ignore absorbed and quantity-less lines', () => {
    const k = setupKit();
    withMrp(k, 60_00, 165_00);
    const p = save(k, {
      voucherTypeId: k.vt.purchase,
      date: DATE,
      mode: 'item_invoice',
      partyLedgerId: k.L.supplier,
      referenceNo: 'S-1',
      items: [{ itemId: k.I.rice, qty: 10, rate: 40 }],
    }).id;
    assert.equal(buildPrintDataFor(k.t.ctx, p).mrpSummary, null);
    assert.equal(mrpSummaryOf([], true, 'invoice', true), null);
  });

  it('the settings sample shows MRP and the saving when the option is on', () => {
    const k = setupKit();
    const env = loadPrintEnv(k.t.ctx);
    const off = buildSampleData(env);
    assert.equal(off.mrpSummary?.show, false);
    const on = buildSampleData(env, { showMrp: true });
    assert.equal(on.mrpSummary?.show, true);
    // Bottle 10 × 599.00 = 5,990.00 vs 4,500.00 + 18% = 5,310.00 → 680.00;
    // rice 4 × 699.00 = 2,796.00 vs 2,375.00 + CGST 59.38 + SGST 59.38 (2.5% each, rounded per head)
    // = 2,493.76 → 302.24. Saved 680.00 + 302.24 = 982.24.
    assert.deepEqual(on.mrpSummary, { show: true, mrpValue: 8_786_00, savings: 982_24 });
  });
});
