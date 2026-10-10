/**
 * Performance: a 500-line GST invoice must save well under 300 ms on a developer machine. The assertion
 * uses a generous bound (CI machines are slower); the measured time is logged.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ItemLineInput, LedgerLineInput } from '../../../shared/types/vouchers.ts';
import { ledgerBalanceAsOf } from './guards.ts';
import { NUMBER_TAKEN_SQL } from './numbering.ts';
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

describe('save cost does not grow with the books (audit finding: number probe and balance guard plans)', () => {
  const plan = (k: ReturnType<typeof setupKit>, sql: string, params: Record<string, string | number>): string =>
    k.t.db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params)
      .map((r) => r.detail)
      .join(' | ');

  it('the voucher-number probe looks the number up; the balance guard reads the covering index', () => {
    const k = setupKit();
    // Without INDEXED BY (and without ANALYZE statistics) SQLite picked idx_vouchers_type_date and
    // scanned every voucher of the type in the year on each probe.
    const p1 = plan(k, NUMBER_TAKEN_SQL, { vt: 1, number: '5', from: '2026-04-01', to: '2027-03-31', ex: 0 });
    assert.match(p1, /USING INDEX idx_vouchers_number \(voucher_type_id=\? AND number=\?\)/);
    const t0 = performance.now();
    ledgerBalanceAsOf(k.t.db, k.L.cash, k.t.today, k.t.today, 1);
    assert.ok(performance.now() - t0 < 1000);
    const p2 = plan(
      k,
      'SELECT COALESCE(SUM(amount), 0) FROM ledger_entries INDEXED BY idx_le_books WHERE ledger_id = :id AND affects_books = 1 AND (is_post_dated = 0 OR date <= :today) AND date <= :date',
      { id: 1, today: '2026-04-15', date: '2026-04-15' },
    );
    assert.match(p2, /USING COVERING INDEX idx_le_books/);
    k.t.close();
  });

  it('an automatic-numbered save costs the same with 30,000 vouchers of its type in the year', () => {
    const k = setupKit();
    const journal = (i: number) =>
      saveVoucher(k.t.ctx, {
        voucherTypeId: k.vt.journal,
        date: k.t.today,
        mode: 'ledger',
        ledgers: [{ ledgerId: k.L.rent, amount: 100 + i }, { ledgerId: k.L.capital, amount: -(100 + i) }],
        acknowledgeWarnings: true,
      });
    const timed = (n: number, from: number): number => {
      const t0 = performance.now();
      k.t.db.transaction(() => {
        for (let i = 0; i < n; i++) journal(from + i);
      });
      return performance.now() - t0;
    };
    timed(50, 0); // warm-up (statement cache)
    const before = timed(300, 50);
    // 30,000 more journals of the same type in FY 2026-27 (numbers 100000…), with a Cash entry each so the
    // Cash ledger has a long history too.
    const now = k.t.clock.now().toISOString();
    k.t.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
       INSERT INTO vouchers (guid, voucher_type_id, base_type, number, number_seq, date, created_at, updated_at)
       SELECT lower(hex(randomblob(16))), :vt, 'journal', CAST(100000 + i AS TEXT), 100000 + i, date('2026-04-01', '+' || (i % 300) || ' days'), :now, :now FROM n`,
      { vt: k.vt.journal, now },
    );
    k.t.db.run(
      `INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, date)
       SELECT id, 1, :cash, 100, date FROM vouchers WHERE number_seq >= 100000`,
      { cash: k.L.cash },
    );
    const after = timed(300, 400);
    console.log(`# 300 journal saves: ${before.toFixed(0)} ms on an empty year, ${after.toFixed(0)} ms with 30,000 journals in it`);
    // Before the fix each save probed the series twice by scanning the type's year: ~30× slower here.
    assert.ok(after < before * 3 + 300, `saves slowed from ${before.toFixed(0)} ms to ${after.toFixed(0)} ms`);

    // The balance guard on the Cash ledger (30,000 entries), excluding a voucher, is as cheap as without
    // (before the fix the exclusion forced a table lookup per entry: ~4× slower here).
    ledgerBalanceAsOf(k.t.db, k.L.cash, '2027-03-31', '2027-03-31', null);
    ledgerBalanceAsOf(k.t.db, k.L.cash, '2027-03-31', '2027-03-31', 5);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) ledgerBalanceAsOf(k.t.db, k.L.cash, '2027-03-31', '2027-03-31', null);
    const plain = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 50; i++) ledgerBalanceAsOf(k.t.db, k.L.cash, '2027-03-31', '2027-03-31', 5);
    const excluding = performance.now() - t1;
    console.log(`# 50 Cash balances over 30,000 entries: ${plain.toFixed(0)} ms; excluding a voucher: ${excluding.toFixed(0)} ms`);
    assert.ok(excluding < plain * 2 + 50, `excluding a voucher: ${excluding.toFixed(0)} ms vs ${plain.toFixed(0)} ms`);
    // Same figure either way: 30,000 × ₹1.00 (the excluded voucher has no Cash entry).
    assert.equal(ledgerBalanceAsOf(k.t.db, k.L.cash, '2027-03-31', '2027-03-31', 5), ledgerBalanceAsOf(k.t.db, k.L.cash, '2027-03-31', '2027-03-31', null));
    k.t.close();
  });
});

describe('performance: restart change on a large series (2.0, WP-04)', () => {
  it('switching yearly → never seeds the new counter: the next allocation on 20,000 vouchers takes < 50 ms', async () => {
    const { saveVoucherType } = await import('../accounts/voucherTypes.ts');
    const { allocateNextNumber, loadVoucherType } = await import('./numbering.ts');
    const k = setupKit();
    const now = k.t.clock.now().toISOString();
    // 20,000 journals 1…20,000 in FY 2026-27 (the yearly counter at 20,000).
    k.t.db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
       INSERT INTO vouchers (guid, voucher_type_id, base_type, number, number_seq, date, created_at, updated_at)
       SELECT lower(hex(randomblob(16))), :vt, 'journal', CAST(i AS TEXT), i, date('2026-04-01', '+' || (i % 300) || ' days'), :now, :now FROM n`,
      { vt: k.vt.journal, now },
    );
    k.t.db.run(`INSERT INTO voucher_counters (voucher_type_id, period_key, last_number) VALUES (:vt, '2026-27', 20000)`, { vt: k.vt.journal });
    saveVoucherType(k.t.ctx, { id: k.vt.journal, numbering: { restart: 'never' } });
    assert.equal(k.t.db.value(`SELECT last_number FROM voucher_counters WHERE voucher_type_id = :vt AND period_key = 'all'`, { vt: k.vt.journal }), 20000);
    const vt = loadVoucherType(k.t.db, k.vt.journal);
    const t0 = performance.now();
    const next = k.t.db.transaction(() => allocateNextNumber(k.t.db, vt, k.t.today, 4));
    const ms = performance.now() - t0;
    console.log(`# next number after yearly → never on 20,000 vouchers: ${ms.toFixed(2)} ms`);
    assert.equal(next.number, '20001');
    assert.ok(ms < 50, `allocation took ${ms.toFixed(1)} ms`);
    k.t.close();
  });
});
