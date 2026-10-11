/**
 * The reports module's graphs (SPEC-21 §5, §4.8): for every builder, the graph's total equals the
 * figure the table shows; the null gates (too little data, Compare mode, stock not valued monthly);
 * the takeaway sentence; Enter on a category opens the same range as Enter on its row; and the
 * stat rule (a stat never repeats a visible table total unless allow-listed).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type {
  CashBankResult,
  CashFlowResult,
  CostCentreRow,
  CostCentresResult,
  GroupSummaryResult,
  LedgerReportResult,
  LedgerReportRow,
  MonthlySummaryResult,
  ProfitFigures,
  ProfitTrendMonth,
  ProfitTrendResult,
  RegisterMonth,
  RegisterResult,
  TbRow,
} from '../../../../shared/types/reports.ts';
import { statRepeatsTotal, specProblems, drawnTotal, inlineBars } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';
import { statTotalAllowed } from '../../../app/lib/chartCatalogue.ts';
import {
  cashBankBarRows,
  cashBankChart,
  cashFlowChart,
  costCentresChart,
  costCentresOf,
  foldMonthRows,
  groupSummaryChart,
  isOverdrawn,
  ledgerChart,
  monthlySummaryChart,
  natureSign,
  profitLossWord,
  profitTrendChart,
  profitTrendGate,
  registerChart,
  registerMeasure,
  trialBalanceStat,
} from './charts.ts';
import type { DrillRange } from './charts.ts';

/** Every spec a builder returns must pass the kit's own rules (assertSpec). */
function valid(spec: ChartSpec | null): ChartSpec {
  assert.ok(spec, 'a graph is drawn');
  assert.deepEqual(specProblems(spec), []);
  assert.equal(drawnTotal(spec), spec.total);
  return spec;
}

const monthsOf = (from: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => {
    const y = Number(from.slice(0, 4)) + Math.floor((Number(from.slice(5, 7)) - 1 + i) / 12);
    const m = ((Number(from.slice(5, 7)) - 1 + i) % 12) + 1;
    return `${y}-${String(m).padStart(2, '0')}`;
  });
const lastDay = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

// ───────────────────────────── P&L ─────────────────────────────

/** The P&L of 1-Apr-26 … 10-Oct-26 (the seeded shop): a net loss of ₹3,43,160.32. */
const PL_FIGURES: ProfitFigures = {
  openingStock: 42_750_000,
  closingStock: 39_854_400,
  sales: 39_487_400,
  purchases: 23_688_000,
  directIncomes: 0,
  directExpenses: 0,
  indirectIncomes: 0,
  indirectExpenses: 47_219_832,
  grossProfit: 12_903_800,
  netProfit: -34_316_032,
};

function trend(netByMonth: readonly number[], opts: { integrated?: boolean; purchases?: number; from?: string; to?: string } = {}): ProfitTrendResult {
  const months = monthsOf(opts.from ?? '2026-04-01', netByMonth.length);
  const rows: ProfitTrendMonth[] = months.map((m, i) => ({
    month: m,
    from: i === 0 ? (opts.from ?? `${m}-01`) : `${m}-01`,
    to: i === months.length - 1 ? (opts.to ?? lastDay(m)) : lastDay(m),
    sales: 100_000,
    purchases: i === 0 ? (opts.purchases ?? 0) : 0,
    grossProfit: netByMonth[i],
    netProfit: netByMonth[i],
  }));
  return { from: rows[0].from, to: rows[rows.length - 1].to, inventoryIntegrated: opts.integrated ?? true, months: rows, netProfit: netByMonth.reduce((a, b) => a + b, 0) };
}

/** Seven months whose Σ is the P&L fixture's net loss (Apr … Oct, Oct running to the 10th). */
const SEVEN = [-6_000_000, -5_500_000, -7_000_000, -4_100_000, -6_016_032, -1_240_000, -4_460_000];

describe('reports.profitLoss — Net profit by month', () => {
  test('the graph total equals the P&L net profit (Σ months)', () => {
    assert.equal(SEVEN.reduce((a, b) => a + b, 0), PL_FIGURES.netProfit, 'fixture: the months add up to the P&L');
    const t = trend(SEVEN, { to: '2026-10-10' });
    const spec = valid(profitTrendChart(t));
    assert.equal(spec.total, PL_FIGURES.netProfit);
    assert.equal(spec.total, t.netProfit);
    assert.equal(spec.kind, 'column');
    assert.equal(spec.color, 'polarity');
    assert.deepEqual(spec.axisCaptions, { up: 'Profit ↑', down: 'Loss ↓' });
    assert.equal(spec.title, 'Net profit by month');
    assert.deepEqual(spec.categories, ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
  });

  test('takeaway: the shape, not the total', () => {
    assert.equal(profitTrendChart(trend(SEVEN))?.takeaway, 'Loss in all 7 months; smallest in Sep (₹12.4 K)');
    assert.equal(profitTrendChart(trend([500_000, -200_000, 900_000, 100_000]))?.takeaway, 'Loss in 1 of 4 months; best Jun (₹9.0 K)');
    assert.equal(profitTrendChart(trend([500_000, 200_000, 900_000]))?.takeaway, 'Profit in all 3 months; best Jun (₹9.0 K)');
  });

  test('gates: fewer than 3 months, Compare mode, stock not valued monthly with purchases', () => {
    assert.equal(profitTrendChart(trend([100, 200])), null, '2 months');
    assert.equal(profitTrendChart(null), null);
    assert.equal(profitTrendChart(trend(SEVEN), { compare: true }), null, 'Compare mode');
    assert.equal(profitTrendGate(trend(SEVEN), true), 'compare');
    const unvalued = trend(SEVEN, { integrated: false, purchases: 23_688_000 });
    assert.equal(profitTrendChart(unvalued), null, 'purchases without monthly stock values');
    assert.equal(profitTrendGate(unvalued, false), 'stock');
    // A service business (no purchases) keeps its graph without integrated stock.
    valid(profitTrendChart(trend(SEVEN, { integrated: false })));
    assert.equal(profitTrendGate(trend(SEVEN, { integrated: false }), false), null);
    // Three months but only two with a figure: not enough to read a shape.
    assert.equal(profitTrendChart(trend([0, 100_000, -50_000])), null);
  });

  test('Enter on a month opens the P&L of that month; a long period folds into quarters, Σ kept', () => {
    const got: DrillRange[] = [];
    const spec = valid(profitTrendChart(trend(SEVEN, { to: '2026-10-10' }), { activate: (r) => got.push(r) }));
    spec.activate?.(6);
    spec.activate?.(0);
    assert.deepEqual(got, [
      { from: '2026-10-01', to: '2026-10-10' },
      { from: '2026-04-01', to: '2026-04-30' },
    ]);
    const long = Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? -10_000 : 25_000));
    const q = valid(profitTrendChart(trend(long), { activate: (r) => got.push(r) }));
    assert.equal(q.title, 'Net profit by quarter');
    assert.equal(q.categories.length, 8);
    assert.equal(q.total, long.reduce((a, b) => a + b, 0));
    q.activate?.(1);
    assert.deepEqual(got[got.length - 1], { from: '2026-07-01', to: '2026-09-30' });
  });

  test('the net word: exact money, "Net loss" for a loss (allow-listed restatement of the Net row)', () => {
    assert.deepEqual(profitLossWord(PL_FIGURES.netProfit), { text: 'Net loss ₹3,43,160.32', loss: true });
    assert.deepEqual(profitLossWord(12_903_800), { text: 'Net profit ₹1,29,038', loss: false });
    assert.equal(statRepeatsTotal([PL_FIGURES.netProfit], [PL_FIGURES.netProfit]), true, 'it is the Net row');
    assert.equal(statTotalAllowed('reports.profitLoss'), true, 'so the catalogue allow-lists it');
  });
});

// ───────────────────────────── Register ─────────────────────────────

function register(baseType: RegisterResult['baseType'], taxable: readonly number[], opts: { to?: string; from?: string } = {}): RegisterResult {
  const months = monthsOf(opts.from ?? '2026-04-01', taxable.length);
  const rows: RegisterMonth[] = months.map((m, i) => ({
    month: m,
    from: `${m}-01`,
    to: i === months.length - 1 ? (opts.to ?? lastDay(m)) : lastDay(m),
    count: taxable[i] ? 2 : 0,
    cancelled: 0,
    taxable: taxable[i],
    tax: Math.round(taxable[i] * 0.18),
    amount: taxable[i] + Math.round(taxable[i] * 0.18),
  }));
  const add = (k: 'taxable' | 'tax' | 'amount' | 'count' | 'cancelled') => rows.reduce((a, r) => a + r[k], 0);
  return {
    from: rows[0].from,
    to: rows[rows.length - 1].to,
    title: 'Sales Register',
    baseType,
    voucherTypeIds: [1],
    months: rows,
    totals: { count: add('count'), cancelled: add('cancelled'), amount: add('amount'), taxable: add('taxable'), tax: add('tax') },
    vouchers: null,
    truncated: false,
  };
}

describe('reports.register — Sales before GST, by month', () => {
  const SALES = [7_182_900, 0, 8_741_400, 5_000_000, 0, 6_120_000, 4_230_000];

  test('sales: taxable value; graph total = the Taxable value total', () => {
    const r = register('sales', SALES, { to: '2026-10-10' });
    const spec = valid(registerChart(r));
    assert.equal(spec.title, 'Sales before GST, by month');
    assert.equal(spec.total, r.totals.taxable);
    assert.equal(spec.partialLast, true, 'October runs to the 10th: "so far"');
    assert.equal(spec.takeaway, 'Best month Jun ₹87.4 K · Oct so far ₹42.3 K');
    assert.equal(spec.label, 'max');
  });

  test('purchase / notes use taxable value; receipt, payment, contra, journal the amount', () => {
    for (const t of ['purchase', 'credit_note', 'debit_note'] as const) assert.equal(registerMeasure({ baseType: t }), 'taxable');
    for (const t of ['receipt', 'payment', 'contra', 'journal'] as const) {
      const r = register(t, SALES);
      assert.equal(registerMeasure(r), 'amount');
      const spec = valid(registerChart(r));
      assert.equal(spec.total, r.totals.amount);
      assert.match(spec.title, / by month$/);
      assert.doesNotMatch(spec.title, /GST/);
    }
    assert.equal(valid(registerChart(register('payment', SALES))).title, 'Payments by month');
    assert.equal(registerMeasure({ baseType: null }), 'amount', 'a voucher-type register without a base type');
    // Such a register is named after its title, without the word "Register".
    assert.equal(valid(registerChart({ ...register('sales', SALES), baseType: null, title: 'Stock Journal Register' })).title, 'Stock Journal by month');
  });

  test('a complete last month is not "so far"; fewer than 3 months with sales → no graph', () => {
    assert.equal(valid(registerChart(register('sales', SALES))).partialLast, false);
    assert.equal(registerChart(register('sales', [100, 0, 200])), null);
    assert.equal(registerChart(register('sales', [100, 200])), null);
    assert.equal(registerChart(null), null);
  });

  test('Enter on a month = Enter on its row (that month\'s vouchers)', () => {
    const got: DrillRange[] = [];
    const spec = valid(registerChart(register('sales', SALES, { to: '2026-10-10' }), { activate: (r) => got.push(r) }));
    spec.activate?.(2);
    spec.activate?.(6);
    assert.deepEqual(got, [
      { from: '2026-06-01', to: '2026-06-30' },
      { from: '2026-10-01', to: '2026-10-10' },
    ]);
  });

  test('a multi-year register folds into quarters (Σ kept); a cut quarter is "so far"', () => {
    const long = Array.from({ length: 20 }, (_, i) => (i + 1) * 10_000);
    const r = register('sales', long, { to: '2027-11-15' });
    const spec = valid(registerChart(r));
    assert.equal(spec.title, 'Sales before GST, by quarter');
    assert.equal(spec.total, r.totals.taxable);
    assert.equal(spec.partialLast, true);
    const whole = register('sales', long.slice(0, 18));
    assert.equal(valid(registerChart(whole)).partialLast, false, 'ends on 30-Sep: a whole quarter');
  });
});

// ───────────────────────────── Cash / bank ─────────────────────────────

const tb = (key: string, kind: TbRow['kind'], name: string, level: number, parentKey: string | null, closing: number, hasChildren = false): TbRow => ({
  key,
  kind,
  id: Number(key.slice(2)) || null,
  name,
  level,
  parentKey,
  hasChildren,
  opening: 0,
  debit: Math.max(0, closing),
  credit: Math.max(0, -closing),
  closing,
});

function cashBank(ledgers: ReadonlyArray<[string, number]>): CashBankResult {
  const rows: TbRow[] = [tb('g:1', 'group', 'Cash-in-Hand', 0, null, 0, true), tb('l:1', 'ledger', 'Cash', 1, 'g:1', ledgers[0][1])];
  let bank = 0;
  rows.push(tb('g:2', 'group', 'Bank Accounts', 0, null, 0, true));
  ledgers.slice(1).forEach(([name, closing], i) => {
    rows.push(tb(`l:${i + 2}`, 'ledger', name, 1, 'g:2', closing));
    bank += closing;
  });
  rows[0].closing = ledgers[0][1];
  rows[2].closing = bank;
  const closing = ledgers.reduce((a, [, c]) => a + c, 0);
  return { from: '2026-04-01', to: '2026-10-10', rows, totals: { opening: 0, debit: 0, credit: 0, closing } };
}

describe('reports.cashBank — Closing balance by account', () => {
  test('graph total = the book\'s total closing; an overdrawn bank is slot 2 and named', () => {
    const d = cashBank([
      ['Cash', 4_520_000],
      ['HDFC Bank', 16_700_000],
      ['SBI Current', -4_400_000],
    ]);
    const spec = valid(cashBankChart(d));
    assert.equal(spec.total, d.totals.closing);
    assert.equal(spec.color, 'polarity');
    assert.equal(spec.takeaway, 'SBI Current is overdrawn by ₹44.0 K');
    assert.equal(inlineBars(spec, cashBankBarRows(d)), true, '3 ledgers: bars inline in the table');
    assert.equal(spec.label, 'tips');
    assert.equal(isOverdrawn(d.rows[4]), true);
    assert.equal(isOverdrawn(d.rows[1]), false);
    assert.equal(isOverdrawn(d.rows[2]), false, 'a group is never "overdrawn"');
  });

  test('no overdraft: the largest share; none with 2 ledgers (the seeded shop)', () => {
    const d = cashBank([
      ['Cash', 3_000_000],
      ['HDFC Bank', 6_000_000],
      ['SBI Current', 1_000_000],
    ]);
    assert.equal(valid(cashBankChart(d)).takeaway, 'HDFC Bank holds 60 % of cash and bank');
    assert.equal(
      cashBankChart(
        cashBank([
          ['Cash', 3_000_000],
          ['HDFC Bank', 6_000_000],
        ]),
      ),
      null,
    );
  });

  test('more than 7 ledgers: a Top 6 + Other strip (not inline), Σ kept', () => {
    const d = cashBank(Array.from({ length: 10 }, (_, i): [string, number] => [`Bank ${i}`, (i + 1) * 100_000]));
    const spec = valid(cashBankChart(d));
    assert.equal(spec.categories.length, 7);
    assert.equal(spec.categories[6], 'Other');
    assert.equal(spec.total, d.totals.closing);
    assert.equal(inlineBars(spec, cashBankBarRows(d)), false);
  });
});

// ───────────────────────────── Ledger and monthly summary ─────────────────────────────

function ledgerRow(date: string, debit: number, credit: number, balance: number, id: number): LedgerReportRow {
  return { voucherId: id, date, voucherType: 'Sales', baseType: 'sales', number: String(id), referenceNo: null, particulars: 'Sales', details: [], narration: null, debit, credit, balance, isPostDated: false };
}

function ledger(opening: number, moves: ReadonlyArray<[string, number]>, truncated = false): LedgerReportResult {
  let bal = opening;
  const rows = moves.map(([date, amt], i) => {
    bal += amt;
    return ledgerRow(date, Math.max(0, amt), Math.max(0, -amt), bal, i + 1);
  });
  const debit = rows.reduce((a, r) => a + r.debit, 0);
  const credit = rows.reduce((a, r) => a + r.credit, 0);
  return {
    from: '2026-04-01',
    to: '2026-10-10',
    ledger: { id: 9, name: 'Asha Retail', alias: null, groupId: 3, groupName: 'Sundry Debtors', isNominal: false, isActive: true },
    opening,
    rows,
    totals: { debit, credit },
    closing: bal,
    count: rows.length,
    truncated,
  };
}

function monthly(opening: number, net: readonly number[], isNominal?: boolean): MonthlySummaryResult {
  let bal = opening;
  const months = monthsOf('2026-04-01', net.length);
  const rows = months.map((m, i) => {
    bal += net[i];
    return { month: m, from: `${m}-01`, to: lastDay(m), debit: Math.max(0, net[i]), credit: Math.max(0, -net[i]), closing: bal, count: 1 };
  });
  return {
    from: '2026-04-01',
    to: rows[rows.length - 1].to,
    subject: { kind: 'ledger', id: 9, name: 'Sales', ...(isNominal === undefined ? {} : { isNominal }) },
    opening,
    rows,
    totals: { debit: rows.reduce((a, r) => a + r.debit, 0), credit: rows.reduce((a, r) => a + r.credit, 0) },
    closing: bal,
  };
}

describe('reports.ledger — Balance by date (detail)', () => {
  test('a Dr account: the last point is the closing balance; one point per date, opening first', () => {
    const d = ledger(500_000, [
      ['2026-04-05', 1_000_000],
      ['2026-04-05', 200_000],
      ['2026-05-02', -400_000],
      ['2026-06-10', 300_000],
    ]);
    const spec = valid(ledgerChart(d));
    assert.equal(spec.kind, 'line');
    assert.equal(spec.total, d.closing);
    assert.deepEqual(spec.categories, ['Opening', '5-Apr-26', '2-May-26', '10-Jun-26']);
    assert.deepEqual(spec.series[0].values, [500_000, 1_700_000, 1_300_000, 1_600_000]);
    assert.equal(spec.takeaway, '₹16.0 K Dr on 10-Jun-26, up ₹11.0 K since 1-Apr-26');
    assert.equal(spec.label, 'last');
  });

  test('a Cr account reads on its own side (Cr up), the tooltip keeps Dr/Cr exact', () => {
    const d = ledger(-500_000, [
      ['2026-04-05', -1_000_000],
      ['2026-05-02', 400_000],
    ]);
    const spec = valid(ledgerChart(d));
    assert.equal(spec.total, -d.closing, 'natural (Cr) side');
    const f = spec.valueFormat;
    assert.ok(typeof f === 'object');
    assert.equal(f.full(spec.total), '11,000.00 Cr');
    assert.match(spec.takeaway, /^₹11\.0 K Cr on 2-May-26, up ₹6\.0 K since/);
  });

  test('fewer than 3 points → none; truncated → the month-end balances, or none without them', () => {
    assert.equal(ledgerChart(ledger(0, [['2026-04-05', 100]])), null);
    const big = ledger(0, [
      ['2026-04-05', 100_000],
      ['2026-05-05', 100_000],
      ['2026-06-05', 100_000],
    ], true);
    assert.equal(ledgerChart(big), null);
    const m = monthly(0, [100_000, 100_000, 100_000, 50_000]);
    const spec = valid(ledgerChart({ ...big, closing: m.closing }, m));
    assert.equal(spec.title, 'Balance by month');
    assert.equal(spec.total, m.closing);
  });
});

describe('reports.monthlySummary (detail)', () => {
  test('income / expense: net movement columns; total = the period\'s net movement on its natural side', () => {
    const d = monthly(0, [-700_000, -800_000, 100_000, -900_000], true);
    const spec = valid(monthlySummaryChart(d));
    assert.equal(spec.kind, 'column');
    assert.equal(spec.total, d.totals.credit - d.totals.debit, 'Cr natural (sales)');
    assert.equal(spec.series[0].name, 'Net credit');
  });

  test('asset / liability (or no flag): a line of month-end balances ending on the closing; Enter → month', () => {
    const got: DrillRange[] = [];
    for (const flag of [false, undefined]) {
      const d = monthly(1_000_000, [200_000, -100_000, 300_000], flag);
      const spec = valid(monthlySummaryChart(d, { activate: (r) => got.push(r) }));
      assert.equal(spec.kind, 'line');
      assert.equal(spec.total, d.closing);
      spec.activate?.(0);
      spec.activate?.(2);
    }
    assert.deepEqual(got.slice(0, 1), [{ from: '2026-05-01', to: '2026-05-31' }], 'the opening point opens nothing');
  });
});

// ───────────────────────────── Group summary ─────────────────────────────

describe('reports.groupSummary — Closing balance by account (detail)', () => {
  function group(nature: string, members: ReadonlyArray<[string, number]>): GroupSummaryResult {
    const rows = members.map(([name, closing], i) => tb(`l:${i + 1}`, 'ledger', name, 0, null, closing));
    const closing = rows.reduce((a, r) => a + r.closing, 0);
    return { from: '2026-04-01', to: '2026-10-10', group: { id: 5, name: 'Sundry Creditors', path: ['Current Liabilities', 'Sundry Creditors'], nature, isNominal: false }, basis: 'trialBalance', rows, totals: { opening: 0, debit: 0, credit: 0, closing } };
  }

  test('a Cr group on its natural side; graph total = the group closing; a Dr member is slot 2', () => {
    const d = group('liabilities', [
      ['Ravi Paints', -2_000_000],
      ['Mehta Steel', -500_000],
      ['Kiran Tools', 100_000],
    ]);
    const spec = valid(groupSummaryChart(d));
    assert.equal(natureSign('liabilities'), -1);
    assert.equal(spec.total, -d.totals.closing);
    assert.deepEqual(spec.series[0].values, [2_000_000, 500_000, -100_000]);
    assert.equal(inlineBars(spec, 3), true);
    assert.equal(spec.takeaway, 'Ravi Paints is the largest at ₹20.0 K');
  });

  test('a Dr group, all on its side: the share; fewer than 3 members → none', () => {
    const d = group('assets', [
      ['A', 600_000],
      ['B', 300_000],
      ['C', 100_000],
    ]);
    assert.equal(valid(groupSummaryChart(d)).takeaway, 'A holds 60 % of Sundry Creditors');
    assert.equal(groupSummaryChart(group('assets', [['A', 1], ['B', 2]])), null);
  });
});

// ───────────────────────────── Cash flow ─────────────────────────────

describe('reports.cashFlow — Net cash flow by month', () => {
  function flow(net: readonly number[]): CashFlowResult {
    const months = monthsOf('2026-04-01', net.length).map((m, i) => ({ month: m, from: `${m}-01`, to: lastDay(m), inflow: Math.max(0, net[i]) + 1000, outflow: Math.max(0, -net[i]) + 1000, net: net[i] }));
    const totals = { inflow: months.reduce((a, m) => a + m.inflow, 0), outflow: months.reduce((a, m) => a + m.outflow, 0), net: net.reduce((a, b) => a + b, 0) };
    return { from: '2026-04-01', to: months[months.length - 1].to, opening: 100_000, closing: 100_000 + totals.net, months, groups: [], totals };
  }

  test('graph total = the period\'s net flow; In ↑ / Out ↓; takeaway; Enter → month', () => {
    const d = flow([1_200_000, -300_000, 500_000, -100_000]);
    const got: DrillRange[] = [];
    const spec = valid(cashFlowChart(d, { activate: (r) => got.push(r) }));
    assert.equal(spec.total, d.totals.net);
    assert.equal(spec.total, d.closing - d.opening);
    assert.deepEqual(spec.axisCaptions, { up: 'In ↑', down: 'Out ↓' });
    assert.equal(spec.takeaway, 'Net outflow in 2 of 4 months; best Apr (₹12.0 K in)');
    spec.activate?.(1);
    assert.deepEqual(got, [{ from: '2026-05-01', to: '2026-05-31' }]);
    assert.equal(valid(cashFlowChart(flow([-100_000, -50_000, -70_000]))).takeaway, 'Net outflow in all 3 months; smallest in May (₹500)');
    assert.equal(cashFlowChart(flow([100, 0])), null);
  });
});

// ───────────────────────────── Cost centres ─────────────────────────────

describe('reports.costCentres — Net by cost centre', () => {
  const cc = (key: string, kind: CostCentreRow['kind'], name: string, level: number, parentKey: string | null, net: number, hasChildren = false): CostCentreRow => ({
    key,
    kind,
    id: Number(key.split(':')[1]),
    name,
    level,
    parentKey,
    hasChildren,
    debit: Math.max(0, net),
    credit: Math.max(0, -net),
    net,
  });
  const d: CostCentresResult = {
    from: '2026-04-01',
    to: '2026-10-10',
    rows: [
      cc('cat:1', 'category', 'Primary Cost Category', 0, null, 1_000_000, true),
      cc('cc:1', 'centre', 'Shop', 1, 'cat:1', 600_000, true),
      cc('cc:4', 'centre', 'Shop counter', 2, 'cc:1', 200_000),
      cc('cc:2', 'centre', 'Godown', 1, 'cat:1', 300_000),
      cc('cc:3', 'centre', 'Delivery', 1, 'cat:1', 100_000),
      cc('cat:2', 'category', 'Projects', 0, null, 50_000, true),
      cc('cc:5', 'centre', 'Site A', 1, 'cat:2', 50_000),
    ],
    centre: null,
  };

  test('the first category\'s centres; graph total = the category\'s net; inline with ≤ 7', () => {
    const spec = valid(costCentresChart(d));
    assert.equal(spec.total, d.rows[0].net);
    assert.deepEqual(spec.categories, ['Shop', 'Godown', 'Delivery']);
    assert.equal(inlineBars(spec, costCentresOf(d).length), true);
    assert.equal(spec.takeaway, 'Shop holds 60 % of Primary Cost Category');
  });

  test('a given category with fewer than 3 centres → none', () => {
    assert.equal(costCentresChart(d, 2), null);
    assert.equal(costCentresChart({ ...d, rows: [] }), null);
  });
});

// ───────────────────────────── Trial Balance stat ─────────────────────────────

describe('reports.trialBalance — the check, not a graph', () => {
  test('"Agrees ✓" when balanced; "Differs by ₹x" (danger) otherwise; never a visible total', () => {
    const ok = trialBalanceStat({ balanced: true, unbalancedBy: 0 });
    assert.equal(ok.value, 'Agrees ✓');
    assert.equal(ok.tone, undefined);
    const bad = trialBalanceStat({ balanced: false, unbalancedBy: -32 });
    assert.equal(bad.value, 'Differs by ₹0.32');
    assert.equal(bad.tone, 'danger');
    const totals = [1_23_45_600, 1_23_45_568];
    assert.equal(statRepeatsTotal([ok.amount], totals), false);
    assert.equal(statRepeatsTotal([bad.amount], totals), false);
    assert.equal(statTotalAllowed('reports.trialBalance'), false, 'not allow-listed: it must never repeat a total');
  });
});

describe('folds and speed', () => {
  test('foldMonthRows: ranges follow the folded categories', () => {
    const rows = monthsOf('2026-04-01', 15).map((m) => ({ month: m, from: `${m}-01`, to: lastDay(m) }));
    const f = foldMonthRows(rows, rows.map(() => 1));
    assert.equal(f.grain, 'quarter');
    assert.equal(f.ranges.length, f.categories.length);
    assert.deepEqual(f.ranges[0], { from: '2026-04-01', to: '2026-06-30' });
    assert.deepEqual(f.ranges[f.ranges.length - 1], { from: '2027-04-01', to: '2027-06-30' });
    assert.equal(f.values.reduce((a, b) => a + b, 0), 15);
  });

  test('every builder on 10,000 rows stays under 50 ms', () => {
    const many = Array.from({ length: 10_000 }, (_, i): [string, number] => [`2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, (i % 7) * 1000 - 2500]);
    many.sort((a, b) => a[0].localeCompare(b[0]));
    const big = ledger(0, many);
    const bank = cashBank(Array.from({ length: 10_000 }, (_, i): [string, number] => [`B${i}`, i * 10 - 400]));
    // Best of five runs each: the first warms the JIT, and a busy machine (parallel test files) only
    // ever adds time — the builder's own cost is the fastest run.
    const best = (run: () => unknown): number => {
      let ms = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        run();
        ms = Math.min(ms, performance.now() - t0);
      }
      return ms;
    };
    for (const [name, run] of [
      ['ledgerChart', () => ledgerChart(big)],
      ['cashBankChart', () => cashBankChart(bank)],
    ] as const) {
      const ms = best(run);
      assert.ok(ms < 50, `${name}: ${ms.toFixed(1)} ms`);
    }
  });
});
