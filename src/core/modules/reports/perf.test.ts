import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveScenario } from '../documents/scenarios.ts';
import { computeStockValuation, stockReplayCount } from '../inventory/index.ts';
import { loadReportEnv } from './engine.ts';
import { balanceSheet, profitLoss, profitTrend } from './financials.ts';
import { cashFlow, fundsFlow } from './flows.ts';
import { groupVouchers, ledgerReport, monthlySummary } from './ledger.ts';
import { ratiosReport } from './ratios.ts';
import { bulkTrade, bulkVouchers, makeBooks } from './testkit.ts';
import { cashBank, groupSummary, trialBalance } from './trialBalance.ts';

const YEAR = { from: '2026-04-01', to: '2027-03-31' };

/** Fastest of `n` runs of `f` (ms): a ratio of two timings on a loaded machine needs the noise taken out. */
function fastest(f: () => unknown, n = 5): number {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    f();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** Run `f` and return [result, milliseconds]. */
function timed<T>(f: () => T): [T, number] {
  const t0 = performance.now();
  const r = f();
  return [r, performance.now() - t0];
}

test('performance: 20,000 vouchers — Trial Balance < 1 s, ledger and P&L/BS stay fast', () => {
  const b = makeBooks({ today: '2027-03-31', features: { integrateInventory: false } });
  // 200 extra ledgers spread over expense / income / debtor groups.
  const extra: number[] = [];
  const groups = ['INDIRECT_EXPENSES', 'INDIRECT_INCOMES', 'SUNDRY_DEBTORS', 'SUNDRY_CREDITORS'] as const;
  for (let i = 0; i < 200; i++) extra.push(b.t.addLedger({ name: `Perf Ledger ${i}`, group: groups[i % groups.length] }));
  bulkVouchers(b.t, 20_000, { ledgers: [b.L.cash, b.L.bank, ...extra] });
  const env = b.env();

  const [tb, tbMs] = timed(() => trialBalance(env, { ...YEAR, mode: 'detailed' }));
  assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
  assert.ok(tbMs < 1000, `Trial Balance took ${tbMs.toFixed(0)} ms`);

  const [led, ledMs] = timed(() => ledgerReport(env, { ...YEAR, ledgerId: b.L.cash }));
  assert.ok(led.count > 0);
  assert.equal(led.rows.at(-1)?.balance, led.closing);
  assert.ok(ledMs < 1000, `Ledger took ${ledMs.toFixed(0)} ms`);

  const [bs, finMs] = timed(() => {
    const out = balanceSheet(env, { asOf: YEAR.to });
    profitLoss(env, { ...YEAR, compareWith: 'previous_period' });
    return out;
  });
  assert.equal(bs.balanced, true);
  assert.ok(finMs < 2000, `P&L + BS took ${finMs.toFixed(0)} ms`);

  // 2.1: the P&L graph's monthly figures cost at most twice the P&L itself (fresh environment each
  // run, as a route call builds its own), and tie to it.
  const trend = profitTrend(b.env(), YEAR);
  assert.equal(trend.months.length, 12);
  assert.equal(trend.netProfit, profitLoss(b.env(), YEAR).figures.netProfit);
  const plMs = fastest(() => profitLoss(b.env(), YEAR));
  const trendMs = fastest(() => profitTrend(b.env(), YEAR));
  assert.ok(trendMs <= 2 * plMs, `P&L by month ${trendMs.toFixed(1)} ms vs P&L ${plMs.toFixed(1)} ms`);
  // The same under a scenario that drops all 20,000 journals and adds memoranda / reversing journals:
  // its adjustment is two aggregate queries for the whole period, never one per month.
  const vt = b.t.ids.voucherTypes;
  const scenarioId = saveScenario(b.t.ctx, { name: 'Perf', includeActuals: true, includeTypeIds: [vt.memorandum, vt.reversing_journal], excludeTypeIds: [vt.journal] }).id;
  const senv = () => loadReportEnv(b.t.db, b.t.today, { scenarioId });
  assert.equal(profitTrend(senv(), YEAR).netProfit, profitLoss(senv(), YEAR).figures.netProfit);
  const splMs = fastest(() => profitLoss(senv(), YEAR));
  const strendMs = fastest(() => profitTrend(senv(), YEAR));
  assert.ok(strendMs <= 2 * splMs, `P&L by month with a scenario ${strendMs.toFixed(1)} ms vs P&L ${splMs.toFixed(1)} ms`);
});

test('performance: 2,000 ledgers, 20,000 item invoices, integrated inventory — every report well under budget', () => {
  const b = makeBooks({ today: '2027-03-31', skipVouchers: true });
  const t = b.t;
  const groups = ['SUNDRY_DEBTORS', 'SUNDRY_CREDITORS', 'INDIRECT_EXPENSES', 'INDIRECT_INCOMES'] as const;
  const parties: number[] = [];
  for (let i = 0; i < 2_000; i++) {
    const id = t.addLedger({ name: `Party ${i}`, group: groups[i % groups.length] });
    if (i % 4 < 2) parties.push(id);
  }
  const items = [b.widget];
  for (let i = 0; i < 50; i++) items.push(t.addStockItem({ name: `Item ${i}`, gstRate: 18, hsnSac: '8471', openingQty: 1_000, openingRate: 100 + i }));
  bulkTrade(t, 20_000, { parties, items, salesLedger: b.L.sales, purchaseLedger: b.L.purchase });
  // A fresh environment per report, as each route call builds its own.
  const env = () => b.env();

  const [tb, tbMs] = timed(() => trialBalance(env(), { ...YEAR, mode: 'detailed' }));
  assert.equal(tb.balanced, true);
  assert.ok(tb.openingStock > 0);
  assert.ok(tbMs < 1000, `Trial Balance took ${tbMs.toFixed(0)} ms`);

  const budgets: Array<[string, () => unknown]> = [
    ['Balance Sheet with comparison', () => assert.equal(balanceSheet(env(), { asOf: YEAR.to, compareAsOf: '2026-09-30' }).balanced, true)],
    ['P&L with comparison', () => profitLoss(env(), { ...YEAR, compareWith: 'previous_period' })],
    ['P&L by month (12 months)', () => assert.equal(profitTrend(env(), YEAR).months.length, 12)],
    ['Group Summary (Current Assets)', () => groupSummary(env(), { ...YEAR, groupId: t.ids.groups.CURRENT_ASSETS })],
    ['Ledger (10,000 sales)', () => assert.equal(ledgerReport(env(), { ...YEAR, ledgerId: b.L.sales }).count, 10_000)],
    ['Group Vouchers (Sundry Debtors, 500 ledgers)', () => groupVouchers(env(), { ...YEAR, groupId: t.ids.groups.SUNDRY_DEBTORS })],
    ['Cash Flow', () => cashFlow(env(), YEAR)],
    ['Funds Flow', () => assert.equal(fundsFlow(env(), YEAR).difference, 0)],
    ['Ratios', () => ratiosReport(env(), YEAR)],
  ];
  for (const [label, run] of budgets) {
    const [, ms] = timed(run);
    assert.ok(ms < 2000, `${label} took ${ms.toFixed(0)} ms`);
  }
});

test('performance: 8,000 items, 60,000 item invoices over two years — one stock replay per report, none for drill-downs', () => {
  const b = makeBooks({ today: '2027-03-31', booksFrom: '2025-04-01', skipVouchers: true });
  const t = b.t;
  const parties: number[] = [];
  for (let i = 0; i < 1_000; i++) parties.push(t.addLedger({ name: `Party ${i}`, group: i % 2 === 0 ? 'SUNDRY_DEBTORS' : 'SUNDRY_CREDITORS' }));
  const items: number[] = [];
  for (let i = 0; i < 8_000; i++) items.push(t.addStockItem({ name: `Item ${i}`, gstRate: 18, hsnSac: '8471', openingQty: 100, openingRate: 100 + (i % 50) }));
  bulkTrade(t, 30_000, { parties, items, salesLedger: b.L.sales, purchaseLedger: b.L.purchase, from: '2025-04-01', batch: 'a' });
  bulkTrade(t, 30_000, { parties, items, salesLedger: b.L.sales, purchaseLedger: b.L.purchase, from: '2026-04-01', batch: 'b' });
  const env = () => b.env();
  const today = t.today;
  /** Run `f`: result, milliseconds and the number of stock valuation replays it caused. */
  const run = <T>(f: () => T): { out: T; ms: number; replays: number } => {
    const r0 = stockReplayCount();
    const t0 = performance.now();
    const out = f();
    return { out, ms: performance.now() - t0, replays: stockReplayCount() - r0 };
  };
  const FY = { from: '2026-04-01', to: '2027-03-31' };
  const debtor = parties[0];
  const times: string[] = [];
  const note = (label: string, r: { ms: number; replays: number }): void => void times.push(`${label} ${r.ms.toFixed(0)} ms/${r.replays}`);

  // Drill-downs first, while nothing is memoised: a ledger, a group and the cash book never value stock.
  const led = run(() => ledgerReport(env(), { ...FY, ledgerId: debtor }));
  note('ledger', led);
  assert.equal(led.replays, 0, 'Ledger Vouchers values no stock');
  assert.equal(led.out.rows.at(-1)?.balance ?? led.out.opening, led.out.closing);
  assert.ok(led.ms < 300, `Ledger took ${led.ms.toFixed(0)} ms`);
  const monthly = run(() => monthlySummary(env(), { ...FY, ledgerId: debtor }));
  assert.equal(monthly.replays, 0);
  assert.equal(monthly.out.closing, led.out.closing);
  const debtors = run(() => groupSummary(env(), { ...FY, groupId: t.ids.groups.SUNDRY_DEBTORS }));
  note('group summary', debtors);
  assert.equal(debtors.replays, 0, 'Group Summary of a group without stock values no stock');
  assert.ok(debtors.ms < 500, `Group Summary took ${debtors.ms.toFixed(0)} ms`);
  assert.equal(run(() => cashBank(env(), FY)).replays, 0);
  assert.equal(run(() => cashFlow(env(), FY)).replays, 0);

  // Balance Sheet with a comparison: every stock figure (two year starts, two closings, the books
  // beginning) from ONE replay.
  const bs = run(() => balanceSheet(env(), { asOf: FY.to, compareAsOf: '2026-03-31' }));
  note('balance sheet', bs);
  assert.equal(bs.out.balanced, true);
  assert.equal(bs.replays, 1);
  assert.ok(bs.ms < 2000, `Balance Sheet took ${bs.ms.toFixed(0)} ms`);
  const closing = computeStockValuation(t.db, { from: FY.to, to: FY.to, today }).totals.closingValue;
  assert.equal(bs.out.closingStock, closing, 'Balance Sheet stock = the Stock Summary closing');

  // The P&L (with last year) and the Trial Balance reuse those values: no replay at all.
  const pl = run(() => profitLoss(env(), { ...FY, compareWith: 'previous_year' }));
  note('P&L', pl);
  assert.equal(pl.replays, 0);
  assert.equal(pl.out.figures.closingStock, closing);
  assert.ok(pl.ms < 1000, `P&L took ${pl.ms.toFixed(0)} ms`);
  // The P&L graph's months need one more replay for the month ends (then memoised), tie to the P&L,
  // and cost at most twice the P&L once the stock values are known.
  const trend = run(() => profitTrend(env(), FY));
  note('P&L by month', trend);
  assert.ok(trend.replays <= 1);
  assert.equal(trend.out.netProfit, pl.out.figures.netProfit);
  assert.equal(trend.out.months.reduce((s, m) => s + m.purchases, 0), pl.out.figures.purchases);
  const plMs = fastest(() => profitLoss(env(), FY), 3);
  const trendMs = fastest(() => profitTrend(env(), FY), 3);
  assert.ok(trendMs <= 2 * plMs, `P&L by month ${trendMs.toFixed(1)} ms vs P&L ${plMs.toFixed(1)} ms`);
  const tb = run(() => trialBalance(env(), { ...FY, mode: 'detailed' }));
  note('trial balance', tb);
  assert.equal(tb.out.balanced, true);
  assert.equal(tb.replays, 0);
  // Ratios and funds flow need the same dates.
  assert.equal(run(() => ratiosReport(env(), FY)).replays, 0);
  assert.equal(run(() => fundsFlow(env(), FY).difference).out, 0);

  // Any change to the books invalidates: the next Balance Sheet replays once and sees the purchase.
  const vt = t.ids.voucherTypes.purchase;
  t.db.transaction(() => {
    const vid = t.db.run(
      `INSERT INTO vouchers (guid, voucher_type_id, base_type, number, number_seq, date, total_amount, created_at, updated_at)
       VALUES ('late', :vt, 'purchase', 'late-1', 1, '2027-03-31', 50000, :ts, :ts)`,
      { vt, ts: new Date().toISOString() },
    ).lastInsertRowid;
    t.db.run("INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, date) VALUES (:v, 1, :l, 50000, '2027-03-31')", { v: vid, l: b.L.purchase });
    t.db.run("INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, date) VALUES (:v, 2, :l, -50000, '2027-03-31')", { v: vid, l: b.L.cash });
    t.db.run("INSERT INTO inventory_entries (voucher_id, line_no, item_id, qty, rate, amount, date) VALUES (:v, 1, :it, 1, 500, 50000, '2027-03-31')", { v: vid, it: items[0] });
  });
  const again = run(() => balanceSheet(env(), { asOf: FY.to }));
  assert.equal(again.replays, 1);
  assert.equal(again.out.balanced, true);
  assert.equal(again.out.closingStock, computeStockValuation(t.db, { from: FY.to, to: FY.to, today }).totals.closingValue);
  assert.notEqual(again.out.closingStock, closing);
  console.log(`reports on 8,000 items / 60,000 invoices (ms / stock replays): ${times.join(' · ')}`);
});
