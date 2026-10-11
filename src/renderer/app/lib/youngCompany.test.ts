/**
 * 2.1.1 D4(b) — "a young company sees its graphs". The owner installed 2.1 on a company with a month or
 * two of entries and most reports showed no graph (the 2.1 minimum was three months / three categories).
 * This test walks EVERY graph row of the catalogue (`app/lib/chartCatalogue.ts`) and feeds its builder a
 * young-company fixture — books beginning 1-Sep-26, working date 11-Oct-26, entries in one or two
 * months, two customers / items / banks at most — and asserts a valid spec comes back (2.1.1 D2: a time
 * series draws from one non-zero period, categories from two, a line from two points; meters unchanged).
 *
 * Fixtures carry only the fields each builder reads (`fx` casts them to the result type); every builder's
 * own module test holds the full-shape "graph total = table total" checks.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BankSummaryRow, PdcRow } from '../../../shared/types/banking.ts';
import type { DashboardMonth, DashboardSummary } from '../../../shared/types/dashboard.ts';
import type { AgeingResult, LedgerBillsResult, StatementResult } from '../../../shared/types/outstanding.ts';
import type {
  CashBankResult,
  CashFlowResult,
  CostCentresResult,
  GroupSummaryResult,
  LedgerReportResult,
  MonthlySummaryResult,
  ProfitTrendResult,
  RegisterResult,
} from '../../../shared/types/reports.ts';
import { enoughData, specProblems } from '../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../ui/lib/chartSpec.ts';
import { graphRows } from './chartCatalogue.ts';
import { bankBalancesChart, pdcChart } from '../../modules/banking/lib/charts.ts';
import { leafMeter } from '../../modules/cheques/lib/charts.ts';
import { homeSalesGraph, trendSpec } from '../../modules/dashboard/lib/model.ts';
import { billsPendingChart, budgetVarianceChart } from '../../modules/documents/lib/charts.ts';
import { ledgerChart as forexLedgerChart, outstandingChart as forexOutstandingChart, revaluationChart } from '../../modules/forex/lib/charts.ts';
import { boeChart, exceptionsChart, hsnChart, itcChart, rateChart } from '../../modules/gst/lib/registerCharts.ts';
import { cashLedgerChart, creditLedgerChart, gstr1Chart, gstr3bMeter, gstr9Chart, setoffMeter } from '../../modules/gst/lib/returnCharts.ts';
import { reconChart, supplierChart } from '../../modules/gstrecon/lib/charts.ts';
import { jobWorkChart, productionChart } from '../../modules/mfg/lib/charts.ts';
import { ageingChart, partiesChart, partyChart, statementChart } from '../../modules/outstanding/lib/charts.ts';
import { tenderChart } from '../../modules/pos/lib/charts.ts';
import { balanceSheetChart, cashBankChart, cashFlowChart, costCentresChart, groupSummaryChart, ledgerChart, monthlySummaryChart, profitTrendChart, registerChart, trialBalanceChart } from '../../modules/reports/lib/charts.ts';
import { dayBookChart } from '../../modules/vouchers/lib/charts.ts';
import { godownsChart, movementChart, profitabilityChart, stockAgeingChart, stockItemChart, stockSummaryChart } from '../../modules/stock/lib/charts.ts';
import { challansChart, computationChart, outstandingChart as tdsOutstandingChart, receivableChart, returnChart } from '../../modules/tds/lib/charts.ts';

/** A fixture with only the fields the builder reads, as the builder's input type. */
function fx<T>(o: unknown): T {
  return o as T;
}

// ───────────────────────────── The young company ─────────────────────────────

const BOOKS_FROM = '2026-09-01';
const TODAY = '2026-10-11';
/** Its two months: September (complete) and October (running). */
const SEP = { month: '2026-09', from: '2026-09-01', to: '2026-09-30' };
const OCT = { month: '2026-10', from: '2026-10-01', to: TODAY };
const tax = (igst: number) => ({ igst, cgst: 0, sgst: 0, cess: 0 });

/** Two months of a ledger / group: September with entries, October quiet so far (or the reverse). */
function monthly(isNominal: boolean, nature: 'assets' | 'income', sep: number, oct: number): MonthlySummaryResult {
  const rows = [
    { ...SEP, debit: Math.max(0, sep), credit: Math.max(0, -sep), closing: sep, count: sep === 0 ? 0 : 1 },
    { ...OCT, debit: Math.max(0, oct), credit: Math.max(0, -oct), closing: sep + oct, count: oct === 0 ? 0 : 1 },
  ];
  return {
    from: BOOKS_FROM,
    to: '2027-03-31',
    subject: { kind: 'ledger', id: 7, name: 'Young Ledger', isNominal, nature },
    opening: 0,
    rows,
    totals: { debit: rows.reduce((a, r) => a + r.debit, 0), credit: rows.reduce((a, r) => a + r.credit, 0) },
    closing: sep + oct,
  };
}

const bank = (id: number, name: string, balance: number): BankSummaryRow =>
  fx<BankSummaryRow>({ id, name, isOd: false, balanceAsPerBooks: balance, balanceAsPerBank: balance, unreconciled: { count: 0, depositsCount: 0, deposits: 0, issuedCount: 0, issued: 0 }, statementLines: { unmatched: 0, matched: 0, ignored: 0, created: 0 } });

const pdc = (kind: PdcRow['kind'], amount: number, daysToMaturity: number): PdcRow => fx<PdcRow>({ kind, amount, daysToMaturity, matured: false, date: '2026-10-20' });

const dashMonth = (month: string, sales: number, purchases: number): DashboardMonth => fx<DashboardMonth>({ month, from: `${month}-01`, to: `${month}-28`, sales, purchases });

/** The last twelve months of the Dashboard trend: only Sep and Oct 2026 have entries (the books begin in Sep). */
const TREND: DashboardMonth[] = Array.from({ length: 12 }, (_, i) => {
  const m = ((10 + i) % 12) + 1; // Nov 25 … Oct 26
  const month = `${m >= 11 ? 2025 : 2026}-${String(m).padStart(2, '0')}`;
  return dashMonth(month, month === '2026-09' ? 4_50_000_00 : month === '2026-10' ? 1_20_000_00 : 0, month === '2026-09' ? 3_00_000_00 : 0);
});

const SUMMARY = fx<DashboardSummary>({
  asOf: TODAY,
  booksFrom: BOOKS_FROM,
  trend: TREND,
  sales: { mtd: 1_20_000_00, lastYear: { mtd: 0 } },
  ranges: { lastYear: { mtd: { from: '2025-10-01', to: '2025-10-11' } } },
});

// ───────────────────────────── One young fixture per graph row ─────────────────────────────

/** Catalogue row (`id` or `id#view`) → its builder on the young company. */
const YOUNG: Readonly<Record<string, () => unknown>> = {
  'app.gateway': () => homeSalesGraph(SUMMARY),
  'dashboard.home': () => trendSpec(TREND, undefined, TODAY),
  // Reports: the P&L, registers and cash flow over Sep–Oct; a ledger with two vouchers.
  'reports.profitLoss': () =>
    profitTrendChart(
      fx<ProfitTrendResult>({ from: BOOKS_FROM, to: TODAY, inventoryIntegrated: true, months: [{ ...SEP, sales: 4_50_000_00, purchases: 3_00_000_00, grossProfit: 1_50_000_00, netProfit: 90_000_00 }, { ...OCT, sales: 1_20_000_00, purchases: 0, grossProfit: 40_000_00, netProfit: -10_000_00 }], netProfit: 80_000_00 }),
    ),
  'reports.cashBank': () =>
    cashBankChart(fx<CashBankResult>({ from: BOOKS_FROM, to: TODAY, rows: [{ kind: 'group', name: 'Cash-in-Hand', closing: 20_000_00 }, { kind: 'ledger', name: 'Cash', closing: 20_000_00 }, { kind: 'group', name: 'Bank Accounts', closing: 1_80_000_00 }, { kind: 'ledger', name: 'HDFC Bank', closing: 1_80_000_00 }], totals: { opening: 0, debit: 0, credit: 0, closing: 2_00_000_00 } })),
  'reports.register#months': () =>
    registerChart(
      fx<RegisterResult>({ from: '2026-04-01', to: '2027-03-31', baseType: 'sales', title: 'Sales Register', months: [{ ...SEP, count: 0, cancelled: 0, taxable: 0, amount: 0 }, { ...OCT, count: 3, cancelled: 0, taxable: 1_20_000_00, amount: 1_41_600_00 }] }),
      { workingDate: TODAY },
    ),
  'reports.ledger': () => ledgerChart(fx<LedgerReportResult>({ from: BOOKS_FROM, to: TODAY, opening: 0, closing: 59_000_00, truncated: false, rows: [{ date: '2026-10-03', balance: 1_18_000_00 }, { date: '2026-10-09', balance: 59_000_00 }] })),
  'reports.monthlySummary': () => monthlySummaryChart(monthly(false, 'assets', 0, 59_000_00), { workingDate: TODAY }),
  'reports.groupSummary#summary': () =>
    groupSummaryChart(fx<GroupSummaryResult>({ from: BOOKS_FROM, to: TODAY, group: { id: 3, name: 'Sundry Debtors', path: ['Current Assets', 'Sundry Debtors'], nature: 'assets', isNominal: false }, rows: [{ level: 0, name: 'Asha Retail', closing: 59_000_00 }, { level: 0, name: 'Kumar Builders', closing: 23_600_00 }] })),
  // 2.1.2: the Balance Sheet (stock, a debtor, the bank) and the Trial Balance's five groups.
  'reports.balanceSheet': () =>
    balanceSheetChart(
      fx({
        assets: [
          { key: 'g:5', kind: 'group', name: 'Current Assets', level: 0, parentKey: null, hasChildren: true, amount: 2_59_000_00 },
          { key: 'g:9', kind: 'group', name: 'Stock-in-Hand', level: 1, parentKey: 'g:5', hasChildren: true, amount: 80_000_00 },
          { key: 'g:12', kind: 'group', name: 'Sundry Debtors', level: 1, parentKey: 'g:5', hasChildren: true, amount: 59_000_00 },
          { key: 'g:14', kind: 'group', name: 'Bank Accounts', level: 1, parentKey: 'g:5', hasChildren: true, amount: 1_20_000_00 },
        ],
      }),
    ),
  'reports.trialBalance': () =>
    trialBalanceChart(
      fx({
        rows: [
          { key: 'g:1', name: 'Capital Account', level: 0, closing: -2_00_000_00 },
          { key: 'g:5', name: 'Current Assets', level: 0, closing: 2_59_000_00 },
          { key: 'g:3', name: 'Current Liabilities', level: 0, closing: -59_000_00 },
          { key: 'g:10', name: 'Sales Accounts', level: 0, closing: -1_20_000_00 },
          { key: 'g:11', name: 'Purchase Accounts', level: 0, closing: 1_20_000_00 },
        ],
      }),
    ),
  'reports.cashFlow': () => cashFlowChart(fx<CashFlowResult>({ from: BOOKS_FROM, to: TODAY, months: [{ ...SEP, net: 0 }, { ...OCT, net: 59_000_00 }] })),
  'reports.costCentres': () =>
    costCentresChart(
      fx<CostCentresResult>({
        rows: [
          { key: 'cat:1', kind: 'category', id: 1, name: 'Branches', level: 0, parentKey: null, net: 30_000_00 },
          { key: 'cc:1', kind: 'centre', id: 1, name: 'Shop', level: 1, parentKey: 'cat:1', net: 20_000_00 },
          { key: 'cc:2', kind: 'centre', id: 2, name: 'Godown', level: 1, parentKey: 'cat:1', net: 10_000_00 },
        ],
      }),
    ),
  // Outstanding: two bills, one not due and one 1–30 days late; a party with a credit limit; its statement.
  'outstanding.receivables#ageing': () => ageingChart(ageingOf('receivable')),
  'outstanding.payables#ageing': () => ageingChart(ageingOf('payable')),
  'outstanding.receivables#parties': () =>
    partiesChart(fx({ side: 'receivable', rows: [{ ledgerId: 1, ledgerName: 'Asha Retail', pending: 59_000_00 }, { ledgerId: 2, ledgerName: 'Kumar Builders', pending: 23_600_00 }] })),
  'outstanding.payables#parties': () =>
    partiesChart(fx({ side: 'payable', rows: [{ ledgerId: 3, ledgerName: 'Ravi Paints', pending: 1_18_000_00 }, { ledgerId: 4, ledgerName: 'Mehta Steel', pending: -10_000_00 }] })),
  'outstanding.party': () => partyChart(fx<Pick<LedgerBillsResult, 'ledger' | 'balance'>>({ ledger: { side: 'receivable', creditLimit: 1_00_000_00 }, balance: 59_000_00 })),
  'outstanding.statement': () =>
    statementChart(fx<Pick<StatementResult, 'from' | 'to' | 'openingBalance' | 'closingBalance' | 'transactions'>>({ from: BOOKS_FROM, to: TODAY, openingBalance: 0, closingBalance: 59_000_00, transactions: [{ date: '2026-10-03', balance: 59_000_00 }] })),
  // Stock: two items, bought in Sep and Oct.
  'stock.summary': () => stockSummaryChart(fx({ valuesShown: true, rows: [{ key: 'g:1', parentKey: null, name: 'Paints', closing: { value: 80_000_00 } }, { key: 'g:2', parentKey: null, name: 'Tools', closing: { value: 20_000_00 } }] })),
  'stock.ageing': () =>
    stockAgeingChart(fx({ rows: [{}, {}], buckets: [{ label: '0–30 days', fromDays: 0, toDays: 30 }, { label: '31–60 days', fromDays: 31, toDays: 60 }, { label: '61–90 days', fromDays: 61, toDays: 90 }, { label: 'Over 90 days', fromDays: 91, toDays: null }], totals: { buckets: [60_000_00, 40_000_00, 0, 0] } })),
  'stock.item': () => stockItemChart(fx({ item: { isService: false, unit: 'Nos' }, from: BOOKS_FROM, to: TODAY, opening: { qty: 0 }, closing: { qty: 8 }, rows: [{ date: '2026-09-12', closing: { qty: 10 } }, { date: '2026-10-05', closing: { qty: 8 } }] })),
  'stock.profitability': () => profitabilityChart(fx({ rows: [{ name: 'Wood Primer 1L', grossProfit: 12_000_00 }, { name: 'Brush 2in', grossProfit: 1_500_00 }] })),
  'stock.categories': () => stockSummaryChart(fx({ valuesShown: true, rows: [{ key: 'c:1', parentKey: null, name: 'Interior', closing: { value: 80_000_00 } }, { key: 'c:none', parentKey: null, name: 'Not categorised', closing: { value: 20_000_00 } }] }), 'category'),
  'stock.godowns': () => godownsChart(fx({ rows: [{ kind: 'godown', parentKey: null, name: 'Main Location', value: 90_000_00 }, { kind: 'godown', parentKey: null, name: 'Back Room', value: 10_000_00 }] })),
  'stock.movement': () => movementChart(fx({ outward: { rows: [{ partyName: 'Asha Retail', value: 50_000_00 }, { partyName: 'Kumar Builders', value: 20_000_00 }] }, inward: { rows: [] } }), 'outward'),
  // GST: one month of returns, two rates, two HSN codes, two suppliers.
  'gst.gstr1': () => gstr1Chart([{ title: 'B2B invoices', taxable: 4_00_000_00 }, { title: 'B2C others', taxable: 50_000_00 }]),
  'gst.gstr3b': () => gstr3bMeter(fx({ payment: { rows: [{ liability: 21_600_00, rcmLiability: 0, paidIgst: 9_000_00, paidCgst: 0, paidSgst: 0, paidCess: 0, cash: 12_600_00 }] } })),
  'gst.gstr9': () =>
    gstr9Chart(
      fx({ months: [{ period: '092026', label: 'Sep 2026', outwardTax: tax(81_000_00), itc: tax(54_000_00) }, { period: '102026', label: 'Oct 2026', outwardTax: tax(0), itc: tax(0) }, ...['112026', '122026', '012027', '022027', '032027'].map((period) => ({ period, label: period, outwardTax: tax(0), itc: tax(0) }))] }),
    ),
  'gst.setoff': () => setoffMeter(fx({ cash: [{ available: 5_000_00, total: 12_600_00 }], cashTotal: 12_600_00 })),
  'gst.ledger.cash': () => cashLedgerChart(fx({ from: BOOKS_FROM, totals: { opening: 0 }, transactions: [{ date: '2026-10-07', kind: 'deposit', igst: 12_600_00, cgst: 0, sgst: 0, cess: 0 }] })),
  'gst.ledger.credit': () => creditLedgerChart(fx({ from: BOOKS_FROM, rows: [{ opening: 0, closing: 54_000_00 }], transactions: [{ date: '2026-09-20', igst: 54_000_00, cgst: 0, sgst: 0, cess: 0 }] })),
  'gst.register': () => rateChart(fx({ kind: 'sales', rateTotals: [{ rate: 18, taxable: 4_00_000_00 }, { rate: 12, taxable: 50_000_00 }] })),
  'gst.hsn': () => hsnChart(fx({ direction: 'outward', rows: [{ hsn: '3208', description: 'Paints', taxable: 4_00_000_00 }, { hsn: '9603', description: 'Brushes', taxable: 50_000_00 }] })),
  'gst.itc': () => itcChart(fx({ rows: [{ partyName: 'Ravi Paints', eligible: tax(36_000_00) }, { partyName: 'Mehta Steel', eligible: tax(18_000_00) }] })),
  'gst.exceptions': () => exceptionsChart(fx([{ code: 'hsn_missing', severity: 'error' }, { code: 'gstin_missing', severity: 'warning' }])),
  'gst.boe#reconcile': () => boeChart(fx({ counts: { matched: 3, mismatch: 1, missing_in_books: 0, missing_in_portal: 0 }, rows: [] })),
  'gstrecon.home#purchases': () => reconChart(fx({ source: 'gstr2b', run: { counts: { matched: 8, partial: 1 } } })),
  'gstrecon.home#gstr1': () => reconChart(fx({ source: 'gstr1', run: { counts: { matched: 12, missing_in_portal: 2 } } })),
  'gstrecon.home#suppliers': () => supplierChart(fx([{ gstin: '27AAAAA0000A1Z5', name: 'Ravi Paints', taxDifference: -1_800_00 }, { gstin: '27BBBBB0000B1Z5', name: 'Mehta Steel', taxDifference: 900_00 }])),
  // Banking: a cash-and-two-banks shop's two banks; two post-dated cheques in different weeks.
  'banking.summary': () => bankBalancesChart([bank(1, 'HDFC Bank', 1_80_000_00), bank(2, 'SBI Current', 40_000_00)]),
  'banking.pdc': () => pdcChart({ rows: [pdc('receivable', 59_000_00, 5), pdc('payable', 23_600_00, 12)] }),
  'cheques.register': () => leafMeter(fx({ totals: { leaves: 25, unused: 22 } }), '000501–000525'),
  // TDS: two sections deducted in October; one challan; a quarter half covered.
  'tds.computation': () => computationChart(fx({ rows: [{ section: '194C', balance: 2_000_00 }, { section: '194J(b)', balance: 5_000_00 }] })),
  'tds.outstanding': () => tdsOutstandingChart(fx({ rows: [{ period: '2026-10', balance: 7_000_00, status: 'due' }] })),
  'tds.challans': () => challansChart(fx({ rows: [{ depositDate: '2026-10-07', total: 3_000_00, late: false }], totals: {} }), '2026-04-01', '2027-03-31'),
  'tds.receivable': () => receivableChart(fx({ rows: [{ partyName: 'Asha Retail', status: 'mismatch', difference: -1_000_00 }, { partyName: 'Kumar Builders', status: 'books_only', difference: -500_00 }] })),
  'tds.return': () => returnChart(fx({ totals: { tax: 7_000_00, deposited: 3_000_00 } })),
  // Forex: one export customer with two bills; two parties restated; a foreign ledger with one voucher.
  'forex.outstanding': () => forexOutstandingChart(fx({ parties: [{ bills: [{ overdueDays: null, amount: 4_00_000_00, revaluedAmount: 4_10_000_00 }, { overdueDays: 12, amount: 1_00_000_00, revaluedAmount: null }] }] }), 'receivable'),
  'forex.revaluation': () => revaluationChart(fx({ lines: [{ ledgerId: 1, ledgerName: 'Global Imports', adjustment: 5_000_00 }, { ledgerId: 2, ledgerName: 'Euro Traders', adjustment: -2_000_00 }] })),
  'forex.ledger': () => forexLedgerChart(fx({ from: BOOKS_FROM, openingForex: 0, currency: { isoCode: 'USD', symbol: '$', decimalPlaces: 2, formalName: 'US Dollar' }, rows: [{ date: '2026-10-02', forexBalance: 5_000_00 }] })),
  // Documents, manufacturing, POS.
  'documents.billsPending': () => billsPendingChart(fx([{ ageDays: 3, pendingValue: 20_000_00 }, { ageDays: 25, pendingValue: 10_000_00 }]), 'sales'),
  'documents.budget.variance': () =>
    budgetVarianceChart(fx([{ name: 'Rent', variance: 0, variancePct: 0, overBudget: false, inTotal: true }, { name: 'Salaries', variance: 5_000_00, variancePct: 10, overBudget: true, inTotal: true }, { name: 'Power', variance: -1_000_00, variancePct: -5, overBudget: false, inTotal: true }])),
  'mfg.production': () => productionChart(fx({ from: '2026-04-01', to: '2027-03-31', rows: [{ date: '2026-10-04', productValue: 30_000_00 }] }), '2026-10'),
  'mfg.jobWork.pending': () => jobWorkChart(fx({ rows: [{ status: 'ok', pendingValue: 20_000_00 }, { status: 'due_soon', pendingValue: 5_000_00 }] }), 'out', false),
  'vouchers.daybook': () =>
    dayBookChart(
      fx([
        { id: 1, baseType: 'sales', typeName: 'Sales', debit: 59_000_00, credit: 0, isCancelled: false, isOptional: false },
        { id: 2, baseType: 'receipt', typeName: 'Receipt', debit: 0, credit: 20_000_00, isCancelled: false, isOptional: false },
      ]),
    ),
  'pos.summary': () => tenderChart(fx({ byTender: [{ modeId: 1, name: 'Cash', net: 12_000_00 }, { modeId: 2, name: 'UPI', net: 8_000_00 }] })),
};

/** Two months of bills: one not yet due, one 1–30 days late. */
function ageingOf(side: AgeingResult['side']): AgeingResult {
  const amounts = [59_000_00, 23_600_00, 0, 0, 0, 0];
  return fx<AgeingResult>({
    side,
    asOf: TODAY,
    basis: 'due_date',
    buckets: [
      { index: 0, label: 'Not due', minDays: null, maxDays: null },
      { index: 1, label: '1–30 days', minDays: 1, maxDays: 30 },
      { index: 2, label: '31–60 days', minDays: 31, maxDays: 60 },
      { index: 3, label: '61–90 days', minDays: 61, maxDays: 90 },
      { index: 4, label: '91–180 days', minDays: 91, maxDays: 180 },
      { index: 5, label: '> 180 days', minDays: 181, maxDays: null },
    ],
    rows: [],
    totals: { amounts, advance: 0, onAccount: 0, total: amounts.reduce((a, b) => a + b, 0) },
  });
}

const rowKey = (r: { id: string; view?: string }): string => (r.view ? `${r.id}#${r.view}` : r.id);

describe('2.1.1 D4(b): every graph of the catalogue draws for a young company (a month or two of entries)', () => {
  test('the walk covers every graph row of the catalogue, and nothing else', () => {
    const keys = graphRows().map(rowKey);
    assert.deepEqual([...keys].sort(), Object.keys(YOUNG).sort());
  });

  for (const row of graphRows()) {
    const key = rowKey(row);
    test(`${key} (${row.form}${row.graphClass === 'detail' ? ', detail' : ''}) draws`, () => {
      const build = YOUNG[key];
      assert.ok(build, `no young fixture for ${key}`);
      const out = build();
      assert.ok(out, `${key}: no graph for a young company`);
      if (row.form === 'mini') {
        // Home's MiniColumns: plain months and values, not a ChartSpec.
        const g = out as { months: readonly string[]; values: readonly number[]; total: number };
        assert.ok(g.values.some((v) => v !== 0), `${key}: a sale to draw`);
        assert.equal(g.total, g.values.reduce((a, b) => a + b, 0));
        return;
      }
      const spec = out as ChartSpec;
      assert.deepEqual(specProblems(spec), [], key);
      assert.ok(enoughData(spec), key);
      const kind = row.form === 'line' && spec.kind === 'column' ? 'column' : row.form;
      assert.equal(spec.kind, kind, `${key}: the catalogue's form`);
    });
  }

  test('the time series draw from ONE month — the young company\'s first', () => {
    const one = (spec: unknown) => {
      const s = spec as ChartSpec | null;
      assert.ok(s);
      assert.equal(s.xKind, 'time');
      return s.series[0].values.filter((v) => v !== null && v !== 0).length;
    };
    assert.equal(one(YOUNG['reports.register#months']()), 1);
    assert.equal(one(YOUNG['reports.cashFlow']()), 1);
    assert.equal(one(YOUNG['mfg.production']()), 1);
    assert.equal(one(YOUNG['tds.outstanding']()), 1);
    assert.equal(one(YOUNG['tds.challans']()), 1);
    assert.equal(one(YOUNG['gst.gstr9']()), 1);
    assert.equal(one(monthlySummaryChart(monthly(true, 'income', -4_50_000_00, 0), { workingDate: TODAY })), 1);
    assert.equal(one(monthlySummaryChart(monthly(false, 'assets', 0, 59_000_00), { workingDate: TODAY })), 1);
    // Home: the books' first month alone, with a sale.
    const first = homeSalesGraph(fx<DashboardSummary>({ ...SUMMARY, booksFrom: '2026-10-01', trend: TREND }));
    assert.deepEqual(first?.months, ['Oct']);
    // The full Dashboard with one month of sales: its last 12 months are all past (zeros before the books
    // begin), so it stays a line that draws from that one month (the one-point → columns case is in model.test.ts).
    const dash = trendSpec(TREND.map((m) => (m.month === '2026-10' ? m : { ...m, sales: 0, purchases: 0 })), undefined, TODAY);
    assert.ok(dash);
    assert.equal(dash.kind, 'line');
    assert.equal(dash.total, 1_20_000_00, 'the line ends on October');
  });

  test('categories still need two: one bank, one item, one rate is a sentence, not a graph', () => {
    assert.equal(bankBalancesChart([bank(1, 'HDFC Bank', 1_80_000_00)]), null);
    assert.equal(rateChart(fx({ kind: 'sales', rateTotals: [{ rate: 18, taxable: 4_00_000_00 }] })), null);
    assert.equal(profitabilityChart(fx({ rows: [{ name: 'Wood Primer 1L', grossProfit: 12_000_00 }] })), null);
    assert.equal(ageingChart(fx<AgeingResult>({ ...ageingOf('receivable'), totals: { amounts: [59_000_00, 0, 0, 0, 0, 0], advance: 0, onAccount: 0, total: 59_000_00 } })), null);
  });
});
