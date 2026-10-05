/**
 * Performance: a 500-line GST invoice must save well under 300 ms on a developer machine. The assertion
 * uses a generous bound (CI machines are slower); the measured time is logged.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ItemLineInput, LedgerLineInput } from '../../../shared/types/vouchers.ts';
import { getVoucher } from './queries.ts';
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

  it('alters a 500-line invoice and a 600-line journal quickly (child FK columns are indexed)', () => {
    const k = setupKit();
    const items: number[] = [];
    for (let i = 0; i < 25; i++) items.push(k.t.addStockItem({ name: `Alter Item ${i}`, gstRate: 18, hsnSac: String(8500 + i), openingQty: 10_000, openingRate: 10 }));
    const lines: ItemLineInput[] = [];
    for (let i = 0; i < 500; i++) lines.push({ itemId: items[i % items.length], qty: 1 + (i % 5), rate: 20 + (i % 9) });
    const inv = saveVoucher(k.t.ctx, salesInput(k, { items: lines, acknowledgeWarnings: true }));

    // A journal with 600 bill-wise party lines (one on-account bill allocation each).
    const parties: number[] = [];
    for (let i = 0; i < 30; i++) parties.push(k.t.addLedger({ name: `Perf Debtor ${i}`, group: 'SUNDRY_DEBTORS' }));
    const jl: LedgerLineInput[] = [];
    for (let i = 0; i < 600; i++) jl.push({ ledgerId: parties[i % parties.length], amount: i % 2 === 0 ? 1000 + i : -(1000 + i - 1) });
    const jv = saveVoucher(k.t.ctx, { voucherTypeId: k.vt.journal, date: k.t.today, mode: 'ledger', ledgers: jl, acknowledgeWarnings: true });
    // 20,000 imported bank statement lines: deleting a ledger entry must not scan them (SET NULL lookup).
    const batch = k.t.db.run(`INSERT INTO import_batches (kind, imported_at) VALUES ('bank_statement', :ts)`, { ts: k.t.clock.now().toISOString() }).lastInsertRowid;
    k.t.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
       INSERT INTO bank_statement_lines (batch_id, ledger_id, txn_date, amount, status) SELECT :b, :l, '2026-04-15', i, 'unmatched' FROM n`,
      { b: batch, l: k.L.bank },
    );

    const t0 = performance.now();
    k.t.db.transaction(() =>
      saveVoucher(k.t.ctx, { ...getVoucher(k.t.db, inv.id).input, narration: 'altered', items: lines.map((l, i) => (i === 0 ? { ...l, qty: 9 } : l)), acknowledgeWarnings: true }),
    );
    const invMs = performance.now() - t0;
    const t1 = performance.now();
    k.t.db.transaction(() => saveVoucher(k.t.ctx, { ...getVoucher(k.t.db, jv.id).input, narration: 'altered', acknowledgeWarnings: true }));
    const jvMs = performance.now() - t1;
    console.log(`# 500-line invoice alter: ${invMs.toFixed(1)} ms; 600-line journal alter: ${jvMs.toFixed(1)} ms`);
    assert.equal(entrySum(k, inv.id), 0);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM bill_allocations WHERE voucher_id = :id', { id: jv.id }), 600);
    assert.ok(invMs < 1500, `500-line invoice alter took ${invMs.toFixed(1)} ms`);
    assert.ok(jvMs < 1500, `600-line journal alter took ${jvMs.toFixed(1)} ms`);

    // The foreign-key child lookups use an index (no full scans per deleted parent row).
    for (const [table, column] of [
      ['bill_allocations', 'ledger_entry_id'],
      ['cost_allocations', 'ledger_entry_id'],
      ['bank_statement_lines', 'matched_entry_id'],
      ['gst_portal_docs', 'matched_voucher_id'],
    ] as const) {
      const plan = k.t.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${column} = 1`).map((r) => r.detail).join(' | ');
      assert.match(plan, /USING (COVERING )?INDEX/, `${table}.${column}: ${plan}`);
    }
    k.t.close();
  });
});
