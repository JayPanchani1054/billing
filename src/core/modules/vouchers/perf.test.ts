/**
 * Performance: a 500-line GST invoice must save well under 300 ms on a developer machine. The assertion
 * uses a generous bound (CI machines are slower); the measured time is logged.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ItemLineInput } from '../../../shared/types/vouchers.ts';
import { previewVoucher, saveVoucher } from './service.ts';
import { entrySum, salesInput, setupKit } from './testkit.ts';

describe('performance', () => {
  it('saves a 500-line invoice quickly and exactly balanced', () => {
    const k = setupKit();
    const items: number[] = [];
    const rates = [0, 5, 18, 40];
    for (let i = 0; i < 50; i++) {
      items.push(k.t.addStockItem({ name: `Perf Item ${i}`, gstRate: rates[i % rates.length], hsnSac: String(8400 + i), openingQty: 10_000, openingRate: 10 }));
    }
    const lines: ItemLineInput[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push({ itemId: items[i % items.length], qty: 1 + (i % 7), rate: 10 + (i % 13) * 3.37, discountPct: i % 5 === 0 ? 2.5 : undefined });
    }
    const input = salesInput(k, { items: lines, ledgers: [{ ledgerId: k.L.freight, amount: 123456 }], acknowledgeWarnings: true });

    // Warm-up (statement preparation), then measure inside one transaction like the route does.
    previewVoucher(k.t.ctx, input);
    const t0 = performance.now();
    const res = k.t.db.transaction(() => saveVoucher(k.t.ctx, input));
    const ms = performance.now() - t0;
    k.t.logs.push({ level: 'info', message: `500-line save ${ms.toFixed(1)} ms` });
    console.log(`# 500-line invoice save: ${ms.toFixed(1)} ms`);

    assert.equal(entrySum(k, res.id), 0);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM inventory_entries WHERE voucher_id = :id', { id: res.id }), 500);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM gst_lines WHERE voucher_id = :id', { id: res.id }), 500);
    const sums = k.t.db.get<{ taxable: number; tax: number }>(
      'SELECT SUM(taxable_value) AS taxable, SUM(igst + cgst + sgst + cess) AS tax FROM gst_lines WHERE voucher_id = :id',
      { id: res.id },
    );
    assert.deepEqual([sums?.taxable, sums?.tax], [res.totals.taxable, res.totals.tax]);
    assert.ok(ms < 1500, `500-line invoice took ${ms.toFixed(1)} ms`);
    k.t.close();
  });
});
