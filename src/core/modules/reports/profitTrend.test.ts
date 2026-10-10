/**
 * `reports.profitTrend` (2.1, the P&L graph's data): the P&L month by month. The graph's total must be
 * the table's total, so every case here proves Σ months = the P&L of the same period — for every
 * costing method, with and without integrated inventory, with and without a scenario, across a
 * financial-year boundary, for partial first/last months and for books that begin mid-year.
 *
 * Books (makeBooks, books from 1-Feb-2026, working date 30-Jun-2026): mid-year nominal openings
 * (Sales Cr 50,000, Office Rent Dr 10,000), Widget opening 100 @ ₹1,000, then trade from February
 * to June (FY 2025-26 ends 31-Mar) with a sales return in May.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SYSTEM_ROLES } from '../../../shared/constants.ts';
import { addDays } from '../../../shared/dates.ts';
import type { ProfitTrendResult } from '../../../shared/types/reports.ts';
import { planProblems, recordSql } from '../../testing/sqlPlans.ts';
import { saveScenario } from '../documents/scenarios.ts';
import { cancelVoucher } from '../vouchers/service.ts';
import { loadReportEnv, stockAtEnd } from './engine.ts';
import { profitLoss, profitTrend } from './financials.ts';
import { reportsRoutes } from './routes.ts';
import { makeBooks, type Books } from './testkit.ts';

const METHODS = ['avg_cost', 'fifo', 'lifo', 'last_purchase', 'std_cost'] as const;
type Method = (typeof METHODS)[number];

function books(opts: { method?: Method; integrated?: boolean } = {}): Books {
  const b = makeBooks({
    booksFrom: '2026-02-01',
    today: '2026-06-30',
    skipVouchers: true,
    ...(opts.integrated === false ? { features: { integrateInventory: false } } : {}),
  });
  const db = b.t.db;
  // Year-to-date results entered as opening balances (books begin mid-year); cash keeps L + S0 = 0.
  db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: -5_000_000, id: b.L.sales });
  db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 1_000_000, id: b.L.rent });
  db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 9_000_000, id: b.L.cash });
  db.run('UPDATE stock_items SET costing_method = :m, standard_cost = :c WHERE id = :id', { m: opts.method ?? 'avg_cost', c: 110_000, id: b.widget });
  const vt = b.t.ids.voucherTypes;
  const buy = (date: string, qty: number, rate: number) =>
    b.post({ voucherTypeId: vt.purchase, date, mode: 'item_invoice', partyLedgerId: b.L.supreme, referenceNo: `SUP-${date}`, items: [{ itemId: b.widget, qty, rate }] });
  const sell = (date: string, qty: number, rate: number) => b.post({ voucherTypeId: vt.sales, date, mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty, rate }] });
  buy('2026-02-10', 30, 1100);
  sell('2026-02-20', 40, 1500);
  buy('2026-03-15', 20, 1300);
  sell('2026-03-28', 50, 1600);
  buy('2026-04-05', 50, 1200);
  sell('2026-04-10', 30, 1500);
  b.post({ voucherTypeId: vt.payment, date: '2026-04-20', mode: 'ledger', ledgers: [{ ledgerId: b.L.rent, amount: 2_500_000 }, { ledgerId: b.L.cash, amount: -2_500_000 }] });
  b.post({ voucherTypeId: vt.journal, date: '2026-04-28', mode: 'ledger', ledgers: [{ ledgerId: b.L.depreciation, amount: 500_000 }, { ledgerId: b.L.furniture, amount: -500_000 }] });
  b.post({ voucherTypeId: vt.credit_note, date: '2026-05-05', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 5, rate: 1500 }] });
  sell('2026-05-12', 20, 1700);
  buy('2026-06-03', 10, 1250);
  return b;
}

/** Periods: whole (contains the books beginning, crosses 31-Mar), partial both ends, starting before the books, one partial month. */
const PERIODS = [
  { from: '2026-02-01', to: '2026-06-30' },
  { from: '2026-02-10', to: '2026-05-20' },
  { from: '2026-01-15', to: '2026-04-30' },
  { from: '2026-04-05', to: '2026-04-25' },
] as const;

const sum = (r: ProfitTrendResult, k: 'sales' | 'purchases' | 'grossProfit' | 'netProfit'): number => r.months.reduce((s, m) => s + m[k], 0);

function assertShape(r: ProfitTrendResult, p: { from: string; to: string }): void {
  assert.equal(r.from, p.from);
  assert.equal(r.to, p.to);
  assert.ok(r.months.length > 0);
  assert.equal(r.months[0].from, p.from, 'first month clipped to the period');
  assert.equal(r.months.at(-1)?.to, p.to, 'last month clipped to the period');
  r.months.forEach((m, i) => {
    assert.equal(m.month, m.from.slice(0, 7));
    assert.equal(m.to.slice(0, 7), m.month, 'a slice never leaves its month');
    assert.ok(m.from <= m.to);
    if (i > 0) assert.equal(m.from, addDays(r.months[i - 1].to, 1), 'contiguous');
    if (i > 0) assert.ok(m.from.endsWith('-01'));
  });
}

describe('reports.profitTrend: Σ months = the P&L of the period', () => {
  for (const integrated of [true, false]) {
    for (const method of METHODS) {
      it(`${method}, ${integrated ? 'integrated inventory' : 'inventory not integrated'}`, () => {
        const env = books({ method, integrated }).env();
        assert.equal(env.integrated, integrated);
        let revalued = 0;
        for (const p of PERIODS) {
          const r = profitTrend(env, p);
          const pl = profitLoss(env, p);
          assertShape(r, p);
          assert.equal(r.inventoryIntegrated, integrated);
          assert.equal(r.netProfit, pl.figures.netProfit, `${p.from}..${p.to} net`);
          assert.equal(sum(r, 'netProfit'), pl.figures.netProfit, `${p.from}..${p.to} Σ net`);
          assert.equal(sum(r, 'purchases'), pl.figures.purchases, `${p.from}..${p.to} Σ purchases`);
          assert.equal(sum(r, 'sales'), pl.figures.sales, `${p.from}..${p.to} Σ sales`);
          assert.equal(sum(r, 'grossProfit'), pl.figures.grossProfit, `${p.from}..${p.to} Σ gross`);
          // Each month is the P&L of that month, its opening stock being the previous month's closing.
          // That is the same number (stock at the start of a day = the closing of the day before) except
          // for a standard-cost item at the books beginning: the opening stock there is the value as
          // entered, every closing is quantity × standard cost — the trend counts that revaluation once
          // (in the month before), as the period's P&L does, never twice.
          r.months.forEach((m, i) => {
            const f = profitLoss(env, { from: m.from, to: m.to }).figures;
            const chained = i === 0 ? f.openingStock : stockAtEnd(env, r.months[i - 1].to);
            const reval = f.openingStock - chained;
            revalued += Math.abs(reval);
            if (method !== 'std_cost' || m.from > env.booksFrom) assert.equal(reval, 0, `${method} ${m.month}: stockAt = closing of the day before`);
            assert.deepEqual(
              [m.sales, m.purchases, m.grossProfit, m.netProfit],
              [f.sales, f.purchases, f.grossProfit + reval, f.netProfit + reval],
              `${method} ${m.month}`,
            );
          });
        }
        // 15-Jan → 30-Apr starts before the books: 100 Widget entered at ₹1,000, standard cost ₹1,100.
        assert.equal(revalued, method === 'std_cost' && integrated ? 1_000_000 : 0);
      });
    }
  }

  it('the costing methods really differ (the cases above are not all the same numbers)', () => {
    const net = (method: Method) => profitTrend(books({ method }).env(), PERIODS[0]).months.map((m) => m.grossProfit);
    const fifo = net('fifo');
    assert.notDeepEqual(fifo, net('lifo'));
    assert.notDeepEqual(fifo, net('std_cost'));
    // Without integrated inventory there is no stock in any month: gross profit = sales − purchases.
    const plain = profitTrend(books({ integrated: false }).env(), PERIODS[0]);
    for (const m of plain.months) assert.equal(m.grossProfit, m.sales - m.purchases, m.month);
  });

  it('the books-beginning month carries the nominal openings; months, sales and purchases by hand', () => {
    const r = profitTrend(books({ integrated: false }).env(), PERIODS[0]);
    assert.deepEqual(
      r.months.map((m) => [m.month, m.from, m.to]),
      [
        ['2026-02', '2026-02-01', '2026-02-28'],
        ['2026-03', '2026-03-01', '2026-03-31'],
        ['2026-04', '2026-04-01', '2026-04-30'],
        ['2026-05', '2026-05-01', '2026-05-31'],
        ['2026-06', '2026-06-01', '2026-06-30'],
      ],
    );
    // Feb: opening Sales Cr 50,000 + 40 × 1,500; Mar 50 × 1,600; Apr 30 × 1,500; May 20 × 1,700 − return 5 × 1,500; Jun none.
    assert.deepEqual(
      r.months.map((m) => m.sales),
      [5_000_000 + 6_000_000, 8_000_000, 4_500_000, 3_400_000 - 750_000, 0],
    );
    assert.deepEqual(
      r.months.map((m) => m.purchases),
      [3_300_000, 2_600_000, 6_000_000, 0, 1_250_000],
    );
    // Feb net = sales − purchases − opening rent 10,000; Apr also rent 25,000 + depreciation 5,000.
    assert.equal(r.months[0].netProfit, 11_000_000 - 3_300_000 - 1_000_000);
    assert.equal(r.months[2].netProfit, 4_500_000 - 6_000_000 - 2_500_000 - 500_000);
    // A period that starts after the books beginning never counts the openings.
    const late = profitTrend(books({ integrated: false }).env(), PERIODS[1]);
    assert.equal(late.months[0].sales, 6_000_000);
  });

  it('an empty company answers with zero months, and a reversed period is a VALIDATION error', () => {
    const env = makeBooks({ skipVouchers: true }).env();
    const r = profitTrend(env, { from: '2026-04-01', to: '2026-06-30' });
    assert.equal(r.months.length, 3);
    assert.equal(r.netProfit, 0);
    for (const m of r.months) assert.deepEqual([m.sales, m.purchases, m.grossProfit, m.netProfit], [0, 0, 0, 0]);
    assert.throws(() => profitTrend(env, { from: '2026-05-01', to: '2026-04-30' }), /ends before it starts/);
  });
});

describe('reports.profitTrend with a scenario (the same overlay as the P&L)', () => {
  /** + a memorandum (rent ₹2,000, 12-Apr) and a reversing journal (rent ₹3,000 on 30-Apr, applicable up to 15-May). */
  function scenarioBooks() {
    const b = books();
    const vt = b.t.ids.voucherTypes;
    const payable = b.t.addLedger({ name: 'Rent Payable', group: 'PROVISIONS' });
    const jv = (voucherTypeId: number, date: string, amount: number, cr: number) =>
      b.post({ voucherTypeId, date, mode: 'ledger', ledgers: [{ ledgerId: b.L.rent, amount }, { ledgerId: cr, amount: -amount }] });
    jv(vt.memorandum, '2026-04-12', 200_000, b.L.capital);
    const rj = jv(vt.reversing_journal, '2026-04-30', 300_000, payable);
    // "Applicable up to" is stored by the documents module's voucher hook (not registered in these books).
    b.t.db.run("UPDATE vouchers SET applicable_upto = '2026-05-15' WHERE id = :id", { id: rj.id });
    const ctx = b.t.ctx;
    return {
      b,
      provisional: saveScenario(ctx, { name: 'Provisional', includeActuals: true, includeTypeIds: [vt.memorandum, vt.reversing_journal], excludeTypeIds: [] }).id,
      noJournals: saveScenario(ctx, { name: 'No journals', includeActuals: true, includeTypeIds: [], excludeTypeIds: [vt.journal] }).id,
      memoOnly: saveScenario(ctx, { name: 'Memo only', includeActuals: false, includeTypeIds: [vt.memorandum], excludeTypeIds: [] }).id,
    };
  }

  it('Σ months = P&L net profit and purchases for every scenario and period (through the dispatcher)', async () => {
    const s = scenarioBooks();
    const call = <T>(name: string, input: unknown) => s.b.t.callOk<T>(reportsRoutes, name, input);
    for (const scenarioId of [s.provisional, s.noJournals, s.memoOnly]) {
      for (const p of [...PERIODS, { from: '2026-04-01', to: '2026-04-30' }, { from: '2026-04-01', to: '2026-05-10' }]) {
        const r = await call<ProfitTrendResult>('reports.profitTrend', { ...p, scenarioId });
        const pl = await call<{ figures: { netProfit: number; purchases: number; sales: number } }>('reports.profitLoss', { ...p, scenarioId });
        assertShape(r, p);
        assert.equal(sum(r, 'netProfit'), pl.figures.netProfit, `scenario ${scenarioId} ${p.from}..${p.to}`);
        assert.equal(r.netProfit, pl.figures.netProfit);
        assert.equal(sum(r, 'purchases'), pl.figures.purchases);
        assert.equal(sum(r, 'sales'), pl.figures.sales);
      }
    }
  });

  it('each month = scenario P&L to its end − scenario P&L to the end before (every provisional kind, every cut)', async () => {
    const s = scenarioBooks();
    const b = s.b;
    const vt = b.t.ids.voucherTypes;
    const payable = b.t.addLedger({ name: 'Accrued Rent', group: 'PROVISIONS' });
    const jv = (voucherTypeId: number, date: string, amount: number, extra: Record<string, unknown> = {}) =>
      b.post({ voucherTypeId, date, mode: 'ledger', ledgers: [{ ledgerId: b.L.rent, amount }, { ledgerId: payable, amount: -amount }], ...extra });
    const upto = (id: number, d: string | null) => b.t.db.run('UPDATE vouchers SET applicable_upto = :d WHERE id = :id', { d, id });
    // Reversing journals: lapses inside its own month (counts only for a cut on or before 25-May), no limit, lapses after the books.
    upto(jv(vt.reversing_journal, '2026-05-20', 70_000).id, '2026-05-25');
    upto(jv(vt.reversing_journal, '2026-02-14', 110_000).id, null);
    upto(jv(vt.reversing_journal, '2026-03-31', 130_000).id, '2026-12-31');
    // An optional reversing journal counts whatever its "applicable up to" (optional wins).
    upto(jv(vt.reversing_journal, '2026-04-03', 170_000, { isOptional: true }).id, '2026-04-04');
    // An optional sale (included only by a scenario that includes Sales), a cancelled memorandum, and
    // a memorandum after the working date (post-dated: not counted yet).
    b.post({ voucherTypeId: vt.sales, date: '2026-05-08', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 2, rate: 1900 }], isOptional: true });
    cancelVoucher(b.t.ctx, jv(vt.memorandum, '2026-06-11', 190_000).id, 'Entered twice');
    jv(vt.memorandum, '2026-07-09', 230_000);
    const optionalSales = saveScenario(b.t.ctx, { name: 'Optional sales', includeActuals: true, includeTypeIds: [vt.sales, vt.reversing_journal], excludeTypeIds: [vt.payment] }).id;
    const call = <T>(name: string, input: unknown) => b.t.callOk<T>(reportsRoutes, name, input);
    type Figures = { figures: { netProfit: number; purchases: number; sales: number; grossProfit: number } };
    const periods = [...PERIODS, { from: '2026-04-01', to: '2026-05-22' }, { from: '2026-05-01', to: '2026-07-31' }, { from: '2026-01-01', to: '2026-12-31' }];
    let moved = 0;
    for (const scenarioId of [undefined, s.provisional, s.noJournals, s.memoOnly, optionalSales]) {
      for (const p of periods) {
        const r = await call<ProfitTrendResult>('reports.profitTrend', { ...p, scenarioId });
        assertShape(r, p);
        let prev = { netProfit: 0, purchases: 0, sales: 0, grossProfit: 0, closingStock: 0 };
        for (const m of r.months) {
          const cum = (await call<Figures & { figures: { closingStock: number } }>('reports.profitLoss', { from: p.from, to: m.to, scenarioId })).figures;
          const label = `scenario ${scenarioId ?? 'none'} ${p.from}..${p.to} ${m.month}`;
          // Opening stock is the period's either way, so the cumulative difference is exactly the month.
          assert.deepEqual(
            [m.sales, m.purchases, m.grossProfit, m.netProfit],
            [cum.sales - prev.sales, cum.purchases - prev.purchases, cum.grossProfit - prev.grossProfit, cum.netProfit - prev.netProfit],
            label,
          );
          moved += Math.abs(m.netProfit);
          prev = cum;
        }
        assert.equal(r.netProfit, prev.netProfit);
      }
    }
    assert.ok(moved > 0);
    // The optional sale (₹3,800) and the payments' exclusion reach May / April of that scenario.
    const base = await call<ProfitTrendResult>('reports.profitTrend', { from: '2026-04-01', to: '2026-05-31' });
    const opt = await call<ProfitTrendResult>('reports.profitTrend', { from: '2026-04-01', to: '2026-05-31', scenarioId: optionalSales });
    assert.equal(opt.months[1].sales - base.months[1].sales, 380_000);
    // April: payments excluded (+ rent ₹25,000), reversing journals of 30-Apr (₹3,000) and the optional one (₹1,700) added.
    assert.equal(opt.months[0].netProfit - base.months[0].netProfit, 2_500_000 - 300_000 - 170_000);
  });

  it('the scenario changes the months, and a lapsed reversing journal reverses in the month it lapses', async () => {
    const s = scenarioBooks();
    const p = { from: '2026-04-01', to: '2026-06-30' };
    const books0 = await s.b.t.callOk<ProfitTrendResult>(reportsRoutes, 'reports.profitTrend', p);
    const prov = await s.b.t.callOk<ProfitTrendResult>(reportsRoutes, 'reports.profitTrend', { ...p, scenarioId: s.provisional });
    const delta = prov.months.map((m, i) => m.netProfit - books0.months[i].netProfit);
    // April: memorandum ₹2,000 + reversing journal ₹3,000 more expense; May: the reversing journal lapses (15-May).
    assert.deepEqual(delta, [-500_000, 300_000, 0]);
    // Without journals April loses the ₹5,000 depreciation; memo-only books hold just the memorandum.
    const noJv = await s.b.t.callOk<ProfitTrendResult>(reportsRoutes, 'reports.profitTrend', { ...p, scenarioId: s.noJournals });
    assert.equal(noJv.months[0].netProfit - books0.months[0].netProfit, 500_000);
    const memo = await s.b.t.callOk<ProfitTrendResult>(reportsRoutes, 'reports.profitTrend', { ...p, scenarioId: s.memoOnly });
    // Memo only (integrated inventory): stock still moves with the books; April's nominal figures are the memorandum only.
    assert.deepEqual([memo.months[0].sales, memo.months[0].purchases], [0, 0]);
  });
});

describe('reports.profitTrend cost', () => {
  it('a fixed number of statements however many months (no query per month), each on an index', () => {
    // Not integrated: the stock valuation (one replay, memoised across requests) stays out of the count.
    const b = books({ integrated: false });
    const rec = recordSql(b.t.db);
    const count = (p: { from: string; to: string }): number => {
      const env = b.env();
      rec.start();
      profitTrend(env, p);
      const stmts = rec.stop();
      for (const st of stmts) if (st.sql.includes('ledger_entries')) assert.deepEqual(planProblems(b.t.db, st), [], st.sql);
      return stmts.length;
    };
    const oneMonth = count({ from: '2026-04-01', to: '2026-04-30' });
    assert.equal(count({ from: '2026-02-01', to: '2027-01-31' }), oneMonth);
    // The same statements as the P&L of the period (plus nothing per month).
    const env = b.env();
    rec.start();
    profitLoss(env, { from: '2026-02-01', to: '2027-01-31' });
    const pl = rec.stop().length;
    assert.ok(oneMonth <= pl + 1, `trend ${oneMonth} statements, P&L ${pl}`);
  });

  it('with a scenario too: at most two more statements, however many months, each on an index', () => {
    const b = books({ integrated: false });
    const vt = b.t.ids.voucherTypes;
    const both = saveScenario(b.t.ctx, { name: 'Both', includeActuals: true, includeTypeIds: [vt.memorandum, vt.reversing_journal], excludeTypeIds: [vt.journal] }).id;
    const rec = recordSql(b.t.db);
    const count = (p: { from: string; to: string }, scenarioId?: number): number => {
      const env = loadReportEnv(b.t.db, b.t.today, scenarioId !== undefined ? { scenarioId } : {});
      rec.start();
      profitTrend(env, p);
      const stmts = rec.stop();
      for (const st of stmts) if (st.sql.includes('ledger_entries')) assert.deepEqual(planProblems(b.t.db, st), [], st.sql);
      return stmts.length;
    };
    const plain = count({ from: '2026-04-01', to: '2026-04-30' });
    const oneMonth = count({ from: '2026-04-01', to: '2026-04-30' }, both);
    assert.ok(oneMonth <= plain + 2, `scenario ${oneMonth} statements, books ${plain}`);
    assert.equal(count({ from: '2026-02-01', to: '2027-01-31' }, both), oneMonth);
  });
});

describe('reports.profitTrend route', () => {
  it('is financial: served to exactly the roles that may see the P&L', async () => {
    const b = books();
    const p = { from: '2026-04-01', to: '2026-04-30' };
    const de = await b.t.call(reportsRoutes, 'reports.profitTrend', p, { session: b.t.sessionAs({ role: 'Data Entry' }) });
    assert.equal(de.ok ? 'ok' : de.error.code, 'FORBIDDEN');
    const acc = await b.t.call(reportsRoutes, 'reports.profitTrend', p, { session: b.t.sessionAs({ role: 'Accountant' }) });
    assert.equal(acc.ok, true);
    for (const role of SYSTEM_ROLES) {
      const session = b.t.sessionAs({ role: role.name });
      const trend = await b.t.call(reportsRoutes, 'reports.profitTrend', p, { session });
      const pl = await b.t.call(reportsRoutes, 'reports.profitLoss', p, { session });
      assert.equal(trend.ok ? 'ok' : trend.error.code, pl.ok ? 'ok' : pl.error.code, role.name);
    }
  });

  it('validates like the P&L period: reversed period, bad date, unknown scenario, unknown key', async () => {
    const b = books();
    const path = async (input: unknown): Promise<string[]> => {
      const r = await b.t.call(reportsRoutes, 'reports.profitTrend', input);
      assert.equal(r.ok ? 'ok' : r.error.code, 'VALIDATION', JSON.stringify(input));
      return r.ok ? [] : (r.error.details as Array<{ path: string }>).map((d) => d.path).sort();
    };
    assert.deepEqual(await path({ from: '2026-04-30', to: '2026-04-01' }), ['to']);
    assert.deepEqual(await path({ from: '2026-02-30', to: '2026-04-01' }), ['from']);
    assert.deepEqual(await path({ from: '2026-04-01', to: '2026-04-30', scenarioId: 9_999 }), ['scenarioId']);
    assert.deepEqual(await path({ from: '2026-04-01', to: '2026-04-30', compareWith: 'previous_year' }), ['compareWith']);
  });

  it('leaves the P&L itself untouched (same output with or without a trend call in between)', async () => {
    const b = books();
    const p = { from: '2026-02-01', to: '2026-06-30' };
    const before = await b.t.callOk(reportsRoutes, 'reports.profitLoss', p);
    await b.t.callOk(reportsRoutes, 'reports.profitTrend', p);
    assert.deepEqual(await b.t.callOk(reportsRoutes, 'reports.profitLoss', p), before);
  });
});
