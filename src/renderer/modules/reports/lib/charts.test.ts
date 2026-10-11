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
  StatementLine,
  TbRow,
} from '../../../../shared/types/reports.ts';
import { statRepeatsTotal, specProblems, drawnTotal, inlineBars, markColor } from '../../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../../ui/lib/chartSpec.ts';
import { statTotalAllowed } from '../../../app/lib/chartCatalogue.ts';
import { tbTotals } from './model.ts';
import {
  assetHeads,
  balanceSheetChart,
  CASH_AND_BANK_LABEL,
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
  trialBalanceBarRows,
  trialBalanceChart,
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

  test('takeaway: a month with no result (a whole-year period\'s months still ahead) is neither "profit" nor "loss"', () => {
    // FY 2026-27 on 10-Oct: Nov–Mar have not happened — the takeaway never claims "Profit in all 12 months".
    const year = trend([500_000, 200_000, 900_000, 100_000, 300_000, 400_000, 50_000, 0, 0, 0, 0, 0]);
    assert.equal(profitTrendChart(year)?.takeaway, 'Profit in all 7 months; best Jun (₹9.0 K)');
    assert.equal(profitTrendChart(trend([500_000, -200_000, 900_000, 0, 0]))?.takeaway, 'Loss in 1 of 3 months; best Jun (₹9.0 K)');
    assert.equal(profitTrendChart(trend([-500_000, -200_000, -900_000, 0]))?.takeaway, 'Loss in all 3 months; smallest in May (₹2.0 K)');
  });

  test('gates: no month with a result, Compare mode, stock not valued monthly with purchases', () => {
    // 2.1.1 D2: a time series draws from one month with a result (a young company's first month).
    assert.equal(valid(profitTrendChart(trend([100, 200]))).total, 300, '2 months draw');
    assert.equal(valid(profitTrendChart(trend([-4_000]))).categories.length, 1, 'one month draws');
    assert.equal(valid(profitTrendChart(trend([-4_000]))).xKind, 'time');
    assert.equal(profitTrendChart(trend([0, 0])), null, 'no month with a result: no graph');
    assert.equal(profitTrendChart(null), null);
    assert.equal(profitTrendChart(trend(SEVEN), { compare: true }), null, 'Compare mode');
    assert.equal(profitTrendGate(trend(SEVEN), true), 'compare');
    const unvalued = trend(SEVEN, { integrated: false, purchases: 23_688_000 });
    assert.equal(profitTrendChart(unvalued), null, 'purchases without monthly stock values');
    assert.equal(profitTrendGate(unvalued, false), 'stock');
    // A service business (no purchases) keeps its graph without integrated stock.
    valid(profitTrendChart(trend(SEVEN, { integrated: false })));
    assert.equal(profitTrendGate(trend(SEVEN, { integrated: false }), false), null);
    // Three months, two with a figure: a time series needs only one (2.1.1 D2).
    assert.equal(valid(profitTrendChart(trend([0, 100_000, -50_000]))).total, 50_000);
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

  test('a complete last month is not "so far"; one month with sales draws, none → no graph (2.1.1 D2)', () => {
    assert.equal(valid(registerChart(register('sales', SALES))).partialLast, false);
    assert.equal(valid(registerChart(register('sales', [100, 0, 200]))).total, 300);
    assert.equal(valid(registerChart(register('sales', [100, 200]))).total, 300);
    const one = valid(registerChart(register('sales', [0, 0, 4_500])));
    assert.equal(one.xKind, 'time');
    assert.equal(one.total, 4_500, 'one month with sales draws');
    assert.equal(registerChart(register('sales', [0, 0, 0])), null, 'no sales: no graph');
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

  test('a whole-year period on a working date inside it stops at that month — drawn "so far", no empty future months', () => {
    // FY 2026-27 chosen from the period presets on 10-Oct: the register lists Apr–Mar, Nov–Mar still empty.
    const r = register('sales', [...SALES, 0, 0, 0, 0, 0]);
    assert.equal(r.to, '2027-03-31');
    const spec = valid(registerChart(r, { workingDate: '2026-10-10' }));
    assert.deepEqual(spec.categories, ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    assert.equal(spec.partialLast, true, 'October is still running');
    assert.equal(spec.takeaway, 'Best month Jun ₹87.4 K · Oct so far ₹42.3 K');
    assert.equal(spec.total, r.totals.taxable, 'graph total = table total');
    // A post-dated voucher in a later month keeps the whole period (the table's total must still be drawn).
    const later = register('sales', [...SALES, 0, 0, 1_000, 0, 0]);
    const all = valid(registerChart(later, { workingDate: '2026-10-10' }));
    assert.equal(all.categories.length, 12);
    assert.equal(all.total, later.totals.taxable);
    assert.equal(all.partialLast, false);
    // A period that ends before the working date is unchanged.
    assert.deepEqual(valid(registerChart(register('sales', SALES), { workingDate: '2026-12-01' })).categories.length, 7);
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

  test('no overdraft: the largest share; 2 ledgers draw, 1 does not (2.1.1 D2)', () => {
    const d = cashBank([
      ['Cash', 3_000_000],
      ['HDFC Bank', 6_000_000],
      ['SBI Current', 1_000_000],
    ]);
    assert.equal(valid(cashBankChart(d)).takeaway, 'HDFC Bank holds 60 % of cash and bank');
    const two = cashBank([
      ['Cash', 3_000_000],
      ['HDFC Bank', 6_000_000],
    ]);
    assert.equal(valid(cashBankChart(two)).total, two.totals.closing, 'two ledgers: a graph');
    assert.equal(cashBankChart(cashBank([['Cash', 3_000_000]])), null, 'one ledger: no graph');
    assert.equal(
      cashBankChart(
        cashBank([
          ['Cash', 3_000_000],
          ['HDFC Bank', 0],
        ]),
      ),
      null,
      'one non-zero balance: no graph',
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
    return { month: m, from: `${m}-01`, to: lastDay(m), debit: Math.max(0, net[i]), credit: Math.max(0, -net[i]), closing: bal, count: net[i] === 0 ? 0 : 1 };
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

  test('fewer than 2 points → none (2.1.1 D2); truncated → the month-end balances, or none without them', () => {
    assert.equal(ledgerChart(ledger(0, [])), null, 'the opening alone is one point');
    const one = valid(ledgerChart(ledger(0, [['2026-04-05', 100]])));
    assert.deepEqual(one.series[0].values, [0, 100], 'opening + one voucher: a line of two points');
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

describe('reports.monthlySummary — always columns by month (2.1.1 D1)', () => {
  const withNature = (d: MonthlySummaryResult, nature: 'assets' | 'liabilities' | 'income' | 'expenses'): MonthlySummaryResult => ({ ...d, subject: { ...d.subject, nature } });

  test('income / expense: net movement columns; total = the period\'s net movement on its natural side', () => {
    const d = monthly(0, [-700_000, -800_000, 100_000, -900_000], true);
    const spec = valid(monthlySummaryChart(d));
    assert.equal(spec.kind, 'column');
    assert.equal(spec.xKind, 'time');
    assert.equal(spec.total, d.totals.credit - d.totals.debit, 'Cr natural (sales)');
    assert.deepEqual(spec.series[0].values, [700_000, 800_000, -100_000, 900_000]);
    assert.equal(spec.series[0].name, 'Net credit');
    assert.equal(spec.title, 'Net movement by month');
    assert.equal(spec.takeaway, 'Highest in Jul ₹9.0 K');
    // A Dr (expense) subject reads Dr up.
    const e = valid(monthlySummaryChart(monthly(0, [200_000, 300_000], true)));
    assert.equal(e.series[0].name, 'Net debit');
    assert.equal(e.total, 500_000);
  });

  test('asset / liability (or no flag): month-end closing balance as columns, each = that row\'s Closing; Enter → month', () => {
    const got: DrillRange[] = [];
    for (const flag of [false, undefined]) {
      const d = monthly(1_000_000, [200_000, -100_000, 300_000], flag);
      const spec = valid(monthlySummaryChart(d, { activate: (r) => got.push(r) }));
      assert.equal(spec.kind, 'column', 'never a line any more');
      assert.equal(spec.xKind, 'time');
      assert.equal(spec.color, 'polarity');
      assert.deepEqual(spec.axisCaptions, { up: 'Dr ↑', down: 'Cr ↓' });
      assert.equal(spec.title, 'Closing balance by month');
      assert.deepEqual(spec.categories, ['Apr', 'May', 'Jun']);
      assert.deepEqual(spec.series[0].values, d.rows.map((r) => r.closing), 'each column is the row\'s Closing');
      assert.equal(spec.series[0].values[spec.series[0].values.length - 1], d.closing, 'the last column is the Grand Total closing');
      assert.equal(spec.takeaway, 'Closing ₹14.0 K Dr at the end of Jun');
      spec.activate?.(0);
      spec.activate?.(2);
    }
    assert.deepEqual(got.slice(0, 2), [
      { from: '2026-04-01', to: '2026-04-30' },
      { from: '2026-06-01', to: '2026-06-30' },
    ], 'Enter on a column = Enter on that month\'s row');
  });

  test('colour by meaning: a month on the other side (a bank overdrawn, a customer in credit) is slot 2, said in words', () => {
    // A bank (assets, natural Dr) overdrawn in May.
    const bank = withNature(monthly(100_000, [50_000, -400_000, 600_000], false), 'assets');
    const spec = valid(monthlySummaryChart(bank));
    assert.deepEqual(spec.series[0].values, [150_000, -250_000, 350_000]);
    assert.deepEqual([0, 1, 2].map((i) => markColor(spec, i)), [1, 2, 1]);
    assert.equal(spec.takeaway, 'Closing ₹3.5 K Dr at the end of Jun · Cr in 1 of 3 months');
    // A supplier (liabilities, natural Cr) — Cr up; a month we paid ahead (Dr) is slot 2. Its closing at the
    // end is Cr even though the ending heuristic alone would not know the nature.
    const supplier = withNature(monthly(-500_000, [-200_000, 900_000, -100_000], false), 'liabilities');
    const s2 = valid(monthlySummaryChart(supplier));
    assert.deepEqual(s2.axisCaptions, { up: 'Cr ↑', down: 'Dr ↓' });
    assert.deepEqual(s2.series[0].values, [700_000, -200_000, -100_000], 'natural side up: Cr positive');
    assert.deepEqual([0, 1, 2].map((i) => markColor(s2, i)), [1, 2, 2], 'the subject\'s nature decides, not where it ended');
    assert.equal(s2.takeaway, 'Closing ₹1.0 K Dr at the end of Jun · Dr in 2 of 3 months');
    // The tooltip words come from the captions: absolute value + "Cr" / "Dr", never a bare minus.
    assert.ok(s2.series[0].values.every((v) => v === null || Number.isInteger(v)));
  });

  test('young company: one month with a non-zero value draws; nothing at all → none', () => {
    const one = valid(monthlySummaryChart(monthly(0, [0, 0, 450_000], true)));
    assert.equal(one.total, 450_000);
    const bal = valid(monthlySummaryChart(monthly(0, [0, 0, 450_000], false)));
    assert.deepEqual(bal.series[0].values, [0, 0, 450_000]);
    assert.equal(monthlySummaryChart(monthly(0, [0, 0, 0], true)), null, 'nothing moved: no graph');
    assert.equal(monthlySummaryChart(monthly(0, [0, 0], false)), null, 'zero balance throughout: no graph');
    assert.equal(monthlySummaryChart(null), null);
    // A single month (books begin this month) on its own.
    assert.equal(valid(monthlySummaryChart(monthly(0, [120_000], true))).categories.length, 1);
  });

  test('the running month is "so far" and future months of a whole-year period are not drawn', () => {
    // FY 2026-27 (Apr–Mar) on 10-Jun: Jul–Mar have not happened.
    const year = monthly(0, [300_000, 500_000, 200_000, 0, 0, 0, 0, 0, 0, 0, 0, 0], true);
    const spec = valid(monthlySummaryChart(year, { workingDate: '2026-06-10' }));
    assert.deepEqual(spec.categories, ['Apr', 'May', 'Jun']);
    assert.equal(spec.partialLast, true);
    assert.equal(markColor(spec, 2), 'partial');
    assert.equal(spec.total, 1_000_000, 'Σ = the table\'s net movement (future months are zero)');
    assert.equal(spec.takeaway, 'Highest in May ₹5.0 K · Jun so far ₹2.0 K');
    // Balances: the running month is "so far" too, and keeps slot 2 when on the other side.
    const bank = withNature(monthly(0, [300_000, 500_000, -900_000, 0, 0, 0, 0, 0, 0, 0, 0, 0], false), 'assets');
    const b = valid(monthlySummaryChart(bank, { workingDate: '2026-06-10' }));
    assert.deepEqual(b.series[0].values, [300_000, 800_000, -100_000]);
    assert.equal(b.partialLast, true);
    assert.equal(markColor(b, 2), 2, 'overdrawn so far: the problem colour');
    assert.equal(b.takeaway, 'Closing ₹1.0 K Cr in Jun so far · Cr in 1 of 3 months');
    // A post-dated entry after the working date keeps the whole period.
    const post = monthly(0, [300_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100_000], true);
    assert.equal(valid(monthlySummaryChart(post, { workingDate: '2026-06-10' })).categories.length, 12);
    // A month-end working date is not "so far".
    assert.equal(valid(monthlySummaryChart(year, { workingDate: '2026-06-30' })).partialLast, false);
  });

  test('takeaways in words: a running month that moved the other way says "net credit/debit", never a bare minus; one column needs no "N of M"', () => {
    // Sales (Cr natural) on 11-May: April sold ₹1,000, May so far only a ₹300 return (Dr).
    const sales = withNature(monthly(0, [-100_000, 30_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], true), 'income');
    const s = valid(monthlySummaryChart(sales, { workingDate: '2026-05-11' }));
    assert.deepEqual(s.series[0].values, [100_000, -30_000]);
    assert.equal(s.takeaway, 'Highest in Apr ₹1.0 K · May so far ₹300 net debit');
    assert.ok(!/-₹|−₹/.test(s.takeaway), `no bare minus: "${s.takeaway}"`);
    // A customer who paid an advance in the company's first month (in credit, one column): the head says Cr.
    const advance = withNature(monthly(0, [-500_000], false), 'assets');
    const a = valid(monthlySummaryChart(advance));
    assert.equal(markColor(a, 0), 2);
    assert.equal(a.takeaway, 'Closing ₹5.0 K Cr at the end of Apr');
    // Two of two months on the other side read naturally.
    const two = valid(monthlySummaryChart(withNature(monthly(0, [-500_000, 100_000], false), 'assets')));
    assert.equal(two.takeaway, 'Closing ₹4.0 K Cr at the end of May · Cr in 2 of 2 months');
  });

  test('a long period folds into quarters: movement Σ kept, balance = the quarter-end closing', () => {
    const nets = Array.from({ length: 15 }, (_, i) => (i + 1) * 10_000);
    const mov = monthly(0, nets, true);
    const m = valid(monthlySummaryChart(mov));
    assert.equal(m.title, 'Net movement by quarter');
    assert.equal(m.total, mov.totals.debit - mov.totals.credit);
    const bal = monthly(0, nets, false);
    const b = valid(monthlySummaryChart(bal));
    assert.equal(b.title, 'Closing balance by quarter');
    assert.equal(b.series[0].values[b.series[0].values.length - 1], bal.closing);
    assert.deepEqual(b.series[0].values[0], bal.rows[2].closing, 'Q1 = the closing at the end of June');
  });

  test('a truncated ledger still draws its month-end balances as a line, dated (never "on Jun 26")', () => {
    const d = monthly(1_000_000, [200_000, -100_000, 300_000], false);
    const big = ledger(1_000_000, [['2026-04-05', 1], ['2026-05-05', 1], ['2026-06-05', 1]], true);
    const ls = valid(ledgerChart({ ...big, closing: d.closing }, d));
    assert.deepEqual(ls.categories, ['Opening', 'Apr 26', 'May 26', 'Jun 26']);
    assert.equal(ls.takeaway, '₹14.0 K Dr on 30-Jun-26, up ₹4.0 K since 1-Apr-26');
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

  test('a Dr group, all on its side: the share; 2 members draw, 1 does not (2.1.1 D2)', () => {
    const d = group('assets', [
      ['A', 600_000],
      ['B', 300_000],
      ['C', 100_000],
    ]);
    assert.equal(valid(groupSummaryChart(d)).takeaway, 'A holds 60 % of Sundry Creditors');
    assert.equal(valid(groupSummaryChart(group('assets', [['A', 1], ['B', 2]]))).total, 3);
    assert.equal(groupSummaryChart(group('assets', [['A', 1]])), null);
    assert.equal(groupSummaryChart(group('assets', [['A', 1], ['B', 0]])), null);
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
    // 2.1.1 D2: one month with a flow draws; none does not.
    assert.equal(valid(cashFlowChart(flow([100, 0]))).total, 100);
    assert.equal(valid(cashFlowChart(flow([100, 0]))).xKind, 'time');
    assert.equal(cashFlowChart(flow([0, 0])), null);
    // Months without movement (still ahead in a whole-year period) count neither way.
    assert.equal(valid(cashFlowChart(flow([1_200_000, 300_000, 500_000, 0, 0]))).takeaway, 'More in than out in all 3 months; best Apr (₹12.0 K in)');
    assert.equal(valid(cashFlowChart(flow([-100_000, -50_000, -70_000, 0]))).takeaway, 'Net outflow in all 3 months; smallest in May (₹500)');
    assert.equal(valid(cashFlowChart(flow([1_200_000, -300_000, 500_000, 0]))).takeaway, 'Net outflow in 1 of 3 months; best Apr (₹12.0 K in)');
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

describe('reports.trialBalance — the check (the stat)', () => {
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
    // (V6) Under the "Opening balances do not agree" banner the totals agree only through the difference
    // line: a bare "Agrees ✓" beside it reads as a contradiction to the owner.
    const withDiff = trialBalanceStat({ balanced: true, unbalancedBy: 0, openingDifference: -67_750_000 });
    assert.doesNotMatch(withDiff.value, /✓/);
    assert.equal(withDiff.value, 'Agrees only with the opening difference');
    assert.equal(withDiff.amount, 0);
    assert.equal(trialBalanceStat({ balanced: true, unbalancedBy: 0, openingDifference: 0 }).value, 'Agrees ✓');
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

// ───────────────────────────── 2.1.2: Balance Sheet and Trial Balance ─────────────────────────────

/** A Balance Sheet line (asset side, side-natural amount). */
function bsLine(key: string, name: string, amount: number, o: Partial<StatementLine> = {}): StatementLine {
  return { key, kind: 'group', id: null, name, level: 0, parentKey: null, hasChildren: false, amount, compare: null, ...o };
}

/**
 * The asset side of the seeded shop of 15-balance-sheet.jpg, opened up: Current Assets ₹6,24,946.00 =
 * Stock-in-Hand 3,94,000 (closing stock) + Sundry Debtors 1,80,946 + Cash-in-Hand 20,000 + Bank Accounts
 * 30,000; then the Profit & Loss A/c (a loss) 3,40,800.12. Asset side total = 9,65,746.12, of which the
 * business owns 6,24,946.00 (the accumulated loss is not owned).
 */
function shopAssets(): StatementLine[] {
  return [
    bsLine('g:5', 'Current Assets', 62_494_600, { hasChildren: true }),
    bsLine('g:9', 'Stock-in-Hand', 39_400_000, { level: 1, parentKey: 'g:5', hasChildren: true }),
    bsLine('stock:closing', 'Closing Stock', 39_400_000, { kind: 'stock', level: 2, parentKey: 'g:9' }),
    bsLine('g:12', 'Sundry Debtors', 18_094_600, { level: 1, parentKey: 'g:5', hasChildren: true }),
    bsLine('l:40', 'Asha Retail', 18_094_600, { kind: 'ledger', level: 2, parentKey: 'g:12' }),
    bsLine('g:13', 'Cash-in-Hand', 2_000_000, { level: 1, parentKey: 'g:5', hasChildren: true }),
    bsLine('g:14', 'Bank Accounts', 3_000_000, { level: 1, parentKey: 'g:5', hasChildren: true }),
    bsLine('pl', 'Profit & Loss A/c', 34_080_012, { kind: 'profit_loss', hasChildren: true }),
    bsLine('pl:current', 'Current Period', 34_080_012, { kind: 'pl_part', level: 1, parentKey: 'pl' }),
  ];
}
const sumTop = (lines: readonly StatementLine[]): number => lines.filter((l) => l.level === 0).reduce((a, l) => a + l.amount, 0);
/** The asset side total minus the lines that are not owned (the Profit & Loss A/c carried there, the opening difference). */
const sumOwned = (lines: readonly StatementLine[]): number => lines.filter((l) => l.level === 0 && l.kind !== 'profit_loss' && l.kind !== 'difference').reduce((a, l) => a + l.amount, 0);

describe('reports.balanceSheet — What you own (2.1.2)', () => {
  test('heads: Current Assets opened into its lines, Cash-in-Hand + Bank Accounts as "Cash & bank"; the accumulated loss is not a head; Σ heads = the asset side total − that line', () => {
    const assets = shopAssets();
    const heads = assetHeads(assets);
    assert.deepEqual(
      heads.map((h) => [h.name, h.amount]),
      [
        ['Stock-in-Hand', 39_400_000],
        ['Sundry Debtors', 18_094_600],
        [CASH_AND_BANK_LABEL, 5_000_000],
      ],
    );
    assert.equal(heads.reduce((a, h) => a + h.amount, 0), sumTop(assets) - 34_080_012, '= 9,65,746.12 − 3,40,800.12');
    assert.equal(heads.reduce((a, h) => a + h.amount, 0), sumOwned(assets), '= 6,24,946.00');
    assert.equal(heads[2].line, null, 'the merged head opens nothing');
    assert.equal(heads[0].line?.key, 'g:9');
  });

  test('one share bar; graph total = the asset side total − the lines not owned; the largest head named in words', () => {
    const assets = shopAssets();
    const spec = valid(balanceSheetChart({ assets }));
    assert.equal(spec.kind, 'share');
    assert.equal(spec.title, 'What you own');
    assert.equal(spec.total, sumOwned(assets));
    assert.equal(spec.total, 62_494_600);
    assert.deepEqual(spec.categories, ['Stock-in-Hand', 'Sundry Debtors', 'Cash & bank']);
    // 3,94,000 of 6,24,946 = 63.0 % → 63 %.
    assert.equal(spec.takeaway, 'Stock-in-Hand is 63 % of what you own (₹3.94 L of ₹6.25 L)');
    assert.equal(spec.color ?? 'series', 'series', 'no problem colour: nothing negative');
    assert.ok(!/[−-]\s?₹|[−-]\d/.test(spec.takeaway), 'no bare minus');
  });

  test('more than four heads: the largest three named, the rest in "Other" (the kit\'s share bar), Σ kept', () => {
    const assets = [
      bsLine('g:1', 'Fixed Assets', 50_00_000_00, { hasChildren: true }),
      bsLine('g:2', 'Investments', 5_00_000_00),
      ...shopAssets(),
    ];
    const spec = valid(balanceSheetChart({ assets }));
    assert.equal(spec.categories.length, 4);
    assert.equal(spec.categories[3], 'Other');
    assert.equal(spec.categories[0], 'Fixed Assets');
    assert.equal(spec.total, sumOwned(assets));
  });

  test('an accumulated loss and a debit difference in opening balances are not things the business owns: neither is a head; total = the real asset heads', () => {
    const assets = [
      bsLine('g:1', 'Fixed Assets', 2_00_000_00, { hasChildren: true }),
      bsLine('g:5', 'Current Assets', 1_50_000_00, { hasChildren: true }),
      bsLine('g:9', 'Stock-in-Hand', 1_00_000_00, { level: 1, parentKey: 'g:5' }),
      bsLine('g:12', 'Sundry Debtors', 50_000_00, { level: 1, parentKey: 'g:5' }),
      bsLine('pl', 'Profit & Loss A/c', 9_00_000_00, { kind: 'profit_loss', hasChildren: true }),
      bsLine('pl:current', 'Current Period', 9_00_000_00, { kind: 'pl_part', level: 1, parentKey: 'pl' }),
      bsLine('diff', 'Difference in opening balances', 4_00_000_00, { kind: 'difference' }),
    ];
    const heads = assetHeads(assets);
    assert.deepEqual(heads.map((h) => h.name), ['Fixed Assets', 'Stock-in-Hand', 'Sundry Debtors']);
    const spec = valid(balanceSheetChart({ assets }));
    assert.ok(!spec.categories.includes('Profit & Loss A/c'), 'the loss is not owned (even as the largest line)');
    assert.ok(!spec.categories.includes('Difference in opening balances'), 'the opening difference is not owned');
    assert.ok(!spec.categories.includes('Other'), 'nothing folded: the two lines are left out, not hidden in Other');
    assert.equal(spec.total, 3_50_000_00, '= Fixed Assets + Stock-in-Hand + Sundry Debtors');
    assert.equal(spec.total, sumTop(assets) - 9_00_000_00 - 4_00_000_00, '= the asset side total − those lines');
    assert.equal(spec.takeaway, 'Fixed Assets is 57 % of what you own (₹2.00 L of ₹3.50 L)');
    // Only those lines: a loss with no real heads beside it draws nothing.
    assert.equal(balanceSheetChart({ assets: [bsLine('g:1', 'Fixed Assets', 1000), assets[4], assets[6]] }), null);
  });

  test('a head in credit is left out of the share and said in words; the total is the side total + that amount', () => {
    const assets = [
      bsLine('g:5', 'Current Assets', 39_400_000 - 1_000_000 + 5_000_000, { hasChildren: true }),
      bsLine('g:9', 'Stock-in-Hand', 39_400_000, { level: 1, parentKey: 'g:5' }),
      bsLine('g:12', 'Sundry Debtors', -1_000_000, { level: 1, parentKey: 'g:5' }),
      bsLine('g:14', 'Bank Accounts', 5_000_000, { level: 1, parentKey: 'g:5' }),
    ];
    const spec = valid(balanceSheetChart({ assets }));
    assert.deepEqual(spec.categories, ['Stock-in-Hand', 'Bank Accounts']);
    assert.equal(spec.total, sumTop(assets) + 1_000_000);
    assert.equal(spec.takeaway, 'Stock-in-Hand is 89 % of what you own · Sundry Debtors (in credit) left out');
    assert.ok(spec.takeaway.length <= 90);
  });

  test('Enter on a segment opens that head\'s line; "Other" and "Cash & bank" open nothing', () => {
    const opened: string[] = [];
    const spec = valid(balanceSheetChart({ assets: shopAssets() }, (l) => opened.push(l.key)));
    spec.activate?.(0);
    spec.activate?.(2);
    assert.deepEqual(opened, ['g:9'], 'Stock-in-Hand opens; "Cash & bank" (index 2) opens nothing');
  });

  test('gates: fewer than two heads with an amount → no graph (2.1.1 D2); no data → none', () => {
    assert.equal(balanceSheetChart(null), null);
    assert.equal(balanceSheetChart({ assets: [] }), null);
    assert.equal(balanceSheetChart({ assets: [bsLine('g:5', 'Current Assets', 100, { hasChildren: true }), bsLine('l:1', 'Cash', 100, { kind: 'ledger', level: 1, parentKey: 'g:5' })] }), null);
  });
});

/** A top-level Trial Balance row (and its children). */
function tbRow(key: string, name: string, closing: number, level = 0, parentKey: string | null = null): TbRow {
  return { key, kind: 'group', id: null, name, level, parentKey, hasChildren: false, opening: 0, debit: Math.max(0, closing), credit: Math.max(0, -closing), closing };
}

describe('reports.trialBalance — Closing balances, table-only (2.1.2)', () => {
  /** Groups view of a small shop: Dr 6,24,946 + 3,40,800.12 = Cr 2,88,246.12 + 6,77,500 (agrees). */
  const rows = [
    tbRow('g:3', 'Current Liabilities', -28_824_612),
    tbRow('l:9', 'Sundry Creditors', -28_824_612, 1, 'g:3'),
    tbRow('g:5', 'Current Assets', 62_494_600),
    tbRow('l:1', 'Profit & Loss A/c', 34_080_012),
    tbRow('diff', 'Difference in opening balances', -67_750_000),
  ];

  test('bars on the top-level rows, Dr slot 1 / Cr slot 2 in words; total = closing Dr − Cr totals (0 when it agrees)', () => {
    const spec = valid(trialBalanceChart({ rows }));
    assert.deepEqual(spec.categories, ['Current Liabilities', 'Current Assets', 'Profit & Loss A/c', 'Difference in opening balances']);
    const t = tbTotals(rows);
    assert.equal(spec.total, t.closingDebit - t.closingCredit);
    assert.equal(spec.total, 0, 'the Trial Balance agrees');
    assert.equal(markColor(spec, 0), 2, 'a Cr balance in slot 2');
    assert.equal(markColor(spec, 1), 1, 'a Dr balance in slot 1');
    assert.equal(spec.takeaway, 'Largest Dr: Current Assets ₹6.25 L · largest Cr: Difference in opening balances ₹6.78 L');
    const f = spec.valueFormat;
    assert.ok(f && typeof f === 'object');
    assert.equal(f.full(-28_824_612), '2,88,246.12 Cr');
    assert.equal(f.tick(62_494_600), '₹6.25 L Dr');
    assert.ok(!/-/.test(f.tick(-28_824_612)), 'no bare minus');
    assert.equal(inlineBars(spec, trialBalanceBarRows(rows).length), true, 'drawn in the table');
    assert.equal(spec.inlineOnly, true, 'table-only: never a strip');
  });

  test('a normal company\'s 12 top-level groups draw inline in the table (table-only, ≤ 20 rows)', () => {
    const names = ['Capital Account', 'Loans (Liability)', 'Current Liabilities', 'Fixed Assets', 'Investments', 'Current Assets', 'Sales Accounts', 'Purchase Accounts', 'Direct Expenses', 'Indirect Expenses', 'Indirect Incomes', 'Opening Stock'];
    const twelve = names.map((n, i) => tbRow(`g:${i}`, n, (i % 3 === 0 ? -1 : 1) * (i + 1) * 1_000_00));
    const children = [tbRow('l:1', 'Asha Retail', 5_000_00, 1, 'g:5'), tbRow('l:2', 'Bank', 1_000_00, 1, 'g:5')];
    const tb = [...twelve, ...children];
    const spec = valid(trialBalanceChart({ rows: tb }));
    assert.deepEqual(spec.categories, names, 'the level-0 rows only, in table order');
    assert.equal(spec.total, twelve.reduce((a, r) => a + r.closing, 0));
    assert.equal(spec.label, 'none', 'tips are for ≤ 7 rows');
    assert.equal(inlineBars(spec, trialBalanceBarRows(tb).length), true, '12 groups: bars under Closing Dr | Closing Cr');
    assert.deepEqual(specProblems(spec), []);
  });

  test('more than 20 top-level rows (a long Ledger-wise list): no graph at all — the Trial Balance is a check, never a strip', () => {
    const many = Array.from({ length: 21 }, (_, i) => tbRow(`l:${i}`, `Ledger ${i}`, i % 2 ? 1000 : -1000));
    assert.equal(trialBalanceChart({ rows: many }), null);
    const twenty = valid(trialBalanceChart({ rows: many.slice(0, 20) }));
    assert.equal(twenty.categories.length, 20);
    assert.equal(inlineBars(twenty, 20), true);
    assert.equal(trialBalanceChart({ rows: many.slice(0, 8) })?.categories.length, 8, '8 rows: drawn (the ≤ 7 rule is for strips)');
  });

  test('gates: one balance is a sentence (2.1.1 D2); no data → none', () => {
    assert.equal(trialBalanceChart(null), null);
    assert.equal(trialBalanceChart({ rows: [tbRow('g:1', 'Capital Account', -1000), tbRow('g:2', 'Fixed Assets', 0)] }), null);
  });

  test('the stat still answers the check (no stat repeats a total)', () => {
    assert.equal(trialBalanceStat({ balanced: true, unbalancedBy: 0 }).value, 'Agrees ✓');
    assert.equal(statTotalAllowed('reports.trialBalance'), false);
  });

  test('both builders on 10,000 rows stay under 50 ms', () => {
    const lines: StatementLine[] = [bsLine('g:5', 'Current Assets', 0, { hasChildren: true })];
    for (let i = 0; i < 10_000; i++) lines.push(bsLine(`l:${i}`, `Head ${i}`, (i % 9) * 1000 + 1, { kind: 'ledger', level: 1, parentKey: 'g:5' }));
    lines[0].amount = lines.slice(1).reduce((a, l) => a + l.amount, 0);
    const tbRows = Array.from({ length: 10_000 }, (_, i) => tbRow(`l:${i}`, `L${i}`, i - 5000, i < 5 ? 0 : 1, i < 5 ? null : 'g:0'));
    for (const [name, run] of [
      ['balanceSheetChart', () => balanceSheetChart({ assets: lines })],
      ['trialBalanceChart', () => trialBalanceChart({ rows: tbRows })],
    ] as const) {
      let ms = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        run();
        ms = Math.min(ms, performance.now() - t0);
      }
      assert.ok(ms < 50, `${name}: ${ms.toFixed(1)} ms`);
    }
    assert.equal(balanceSheetChart({ assets: lines })?.total, lines[0].amount);
  });
});
