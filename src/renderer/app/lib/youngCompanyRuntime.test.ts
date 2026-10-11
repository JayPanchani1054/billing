/**
 * 2.1.1 — "is anything not showing a graph?" on a REAL young company. youngCompany.test.ts feeds every
 * builder of the catalogue a hand-made fixture; this file builds the company the owner has — books from
 * 1-Apr, entries in the running month only (phase 1), then in the last two months (phase 2), two
 * customers, one supplier, one bank, two items, GST on — through runtime.dispatch exactly as Electron
 * main does, reads every report the way its screen does (same route, same input: the default period is
 * the financial year to the working date) and asserts the screen's builder returns a drawable graph.
 *
 * A row that deliberately draws nothing for this company says why (one bank, one bucket… is a sentence,
 * not a comparison — 2.1.1 D2; a meter's two parts).
 *
 * Test-only: imports the core harness at runtime (as accounts/lib/coreContract.test.ts does).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { makeGstin, testPan, TEST_PAN } from '../../../core/testing/fixtures.ts';
import { P, startRuntime } from '../../../core/testing/e2e/harness.ts';
import type { E2E } from '../../../core/testing/e2e/harness.ts';
import { DEFAULT_AGEING_BUCKETS } from '../../../shared/types/outstanding.ts';
import { enoughData, specProblems } from '../../ui/lib/chartSpec.ts';
import type { ChartSpec } from '../../ui/lib/chartSpec.ts';
import { bankBalancesChart, pdcChart } from '../../modules/banking/lib/charts.ts';
import { ageingSpec, homeSalesGraph, homeSummaryInput, summaryInput, trendSpec } from '../../modules/dashboard/lib/model.ts';
import { initialFy, initialPeriodKey } from '../../modules/gst/lib/periods.ts';
import { exceptionsChart, hsnChart, itcChart, rateChart } from '../../modules/gst/lib/registerCharts.ts';
import { cashLedgerChart, creditLedgerChart, gstr3bMeter, gstr9Chart, setoffMeter } from '../../modules/gst/lib/returnCharts.ts';
import { ageingChart, partyChart, statementChart } from '../../modules/outstanding/lib/charts.ts';
import { cashBankChart, cashFlowChart, groupSummaryChart, ledgerChart, monthlySummaryChart, profitTrendChart, registerChart } from '../../modules/reports/lib/charts.ts';
import { godownsChart, movementChart, profitabilityChart, stockAgeingChart, stockItemChart, stockSummaryChart } from '../../modules/stock/lib/charts.ts';
import { AGEING_PRESETS } from '../../modules/stock/lib/model.ts';
import { leafMeter, meterBook } from '../../modules/cheques/lib/charts.ts';
import { ledgerChart as forexLedgerChart, outstandingChart as forexOutstandingChart } from '../../modules/forex/lib/charts.ts';
import { productionChart } from '../../modules/mfg/lib/charts.ts';
import { tenderChart } from '../../modules/pos/lib/charts.ts';
import { challansChart, computationChart, outstandingChart as tdsOutstandingChart, returnChart } from '../../modules/tds/lib/charts.ts';
import { chequePaymentInput, exportInvoiceInput, PARITY, seedParityMasters } from '../../../core/testing/e2e/parityFlow.ts';
import type { ApiCall, ParityMasters } from '../../../core/testing/e2e/parityFlow.ts';

const TODAY = '2026-10-11';
const BOOKS_FROM = '2026-04-01';
/** The default period of every report (workingContext.defaultPeriod): the financial year to the working date. */
const PERIOD = { from: BOOKS_FROM, to: TODAY };

type Arg<F extends (...a: never[]) => unknown> = NonNullable<Parameters<F>[0]>;
interface Row {
  id: number;
  name: string;
}

interface World {
  types: Record<string, number>;
  groups: Record<string, number>;
  asha: number;
  kumar: number;
  ravi: number;
  bank: number;
  cash: number;
  sales: number;
  primer: number;
  brush: number;
}

async function seed(e: E2E, booksFrom = BOOKS_FROM): Promise<World> {
  const s = await e.call<{ dataDir: string }>('app.state');
  await e.call('app.dataDir.set', { path: s.dataDir, mode: 'use' });
  await e.call('app.company.create', {
    name: 'Young Paints E2E',
    stateCode: '27',
    gstRegistrationType: 'regular',
    gstin: makeGstin('27'),
    pan: TEST_PAN,
    booksFrom,
    fyStartMonth: 4,
    features: { inventory: true, multipleGodowns: false, batches: false, billWise: true, costCentres: false, orderProcessing: false, einvoice: false, ewayBill: false, gst: true },
  });
  const groups: Record<string, number> = {};
  for (const g of (await e.call<{ rows: Row[] }>('accounts.group.list', {})).rows) groups[g.name] = g.id;
  const types: Record<string, number> = {};
  for (const t of (await e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {})).rows) {
    if (t.isPredefined && types[t.baseType] === undefined) types[t.baseType] = t.id;
  }
  const ledgers = (await e.call<{ rows: Row[] }>('accounts.ledger.list', {})).rows;
  const cash = ledgers.find((l) => l.name === 'Cash')?.id;
  const sales = ledgers.find((l) => /^Sales/.test(l.name))?.id;
  assert.ok(cash, 'the predefined Cash ledger');
  const party = async (name: string, group: string, n: number) =>
    (await e.call<Row>('accounts.ledger.save', { name, groupId: groups[group], gstin: makeGstin('27', testPan(n)), stateCode: '27', registrationType: 'regular' })).id;
  const asha = await party('Asha Retail', 'Sundry Debtors', 2);
  const kumar = await party('Kumar Builders', 'Sundry Debtors', 3);
  const ravi = await party('Ravi Paints', 'Sundry Creditors', 4);
  const bank = (await e.call<Row>('accounts.ledger.save', { name: 'HDFC Bank', groupId: groups['Bank Accounts'] })).id;
  const nos = (await e.call<{ rows: Array<{ id: number; symbol: string }> }>('inventory.unit.list', {})).rows.find((u) => u.symbol === 'Nos');
  assert.ok(nos);
  const item = async (name: string, rate: number, hsn: string, opening: number) =>
    (
      await e.call<{ item: Row }>('inventory.item.save', {
        name,
        unitId: nos.id,
        gstApplicable: true,
        taxability: 'taxable',
        gstRate: rate,
        hsnSac: hsn,
        ...(opening > 0 ? { openings: [{ qty: opening, rate: 200 }] } : {}),
      })
    ).item.id;
  const primer = await item('Wood Primer 1L', 18, '3208', 40);
  const brush = await item('Paint Brush 2in', 12, '9603', 0);
  return { types, groups, asha, kumar, ravi, bank, cash, sales: sales ?? 0, primer, brush };
}

/** A month of a young shop: two sales, a purchase, a receipt into the bank and a payment out of it. */
async function month(e: E2E, w: World, ym: string, k: number): Promise<void> {
  const d = (n: number) => `${ym}-${String(n).padStart(2, '0')}`;
  const save = (input: Record<string, unknown>) => e.call('vouchers.save', { acknowledgeWarnings: true, ...input });
  await save({ voucherTypeId: w.types.purchase, date: d(2), mode: 'item_invoice', partyLedgerId: w.ravi, referenceNo: `RP/${ym}`, referenceDate: d(2), items: [{ itemId: w.primer, qty: 20, rate: 200 }, { itemId: w.brush, qty: 50, rate: 30 }] });
  await save({ voucherTypeId: w.types.sales, date: d(3), mode: 'item_invoice', partyLedgerId: w.asha, items: [{ itemId: w.primer, qty: 10 * k, rate: 300 }] });
  await save({ voucherTypeId: w.types.sales, date: d(6), mode: 'item_invoice', partyLedgerId: w.kumar, items: [{ itemId: w.brush, qty: 20, rate: 50 }] });
  // A counter sale for cash: the shop's cash drawer has a balance (Cash/Bank Books compares it with the bank).
  await save({ voucherTypeId: w.types.sales, date: d(7), mode: 'item_invoice', partyLedgerId: w.cash, items: [{ itemId: w.brush, qty: 5, rate: 60 }] });
  await save({
    voucherTypeId: w.types.receipt,
    date: d(8),
    mode: 'ledger',
    ledgers: [
      { ledgerId: w.bank, amount: P(2_000), instrument: { type: 'neft', number: `UTR${ym}` } },
      { ledgerId: w.asha, amount: -P(2_000) },
    ],
  });
  await save({
    voucherTypeId: w.types.payment,
    date: d(9),
    mode: 'ledger',
    ledgers: [
      { ledgerId: w.ravi, amount: P(1_000) },
      { ledgerId: w.bank, amount: -P(1_000), instrument: { type: 'neft', number: `PAY${ym}` } },
    ],
  });
}

/** What the screen shows: `reportGraph(spec)` (ui/lazyChart.tsx) draws the strip exactly when the spec passes `enoughData`. */
function draws(key: string, spec: ChartSpec | null | undefined): ChartSpec {
  assert.ok(spec, `${key}: the builder returned no graph for a young company`);
  assert.deepEqual(specProblems(spec), [], key);
  assert.ok(enoughData(spec), `${key}: enoughData`);
  return spec;
}

/** Every report graph the young company's screens draw, read as each screen reads it. */
async function walk(e: E2E, w: World, phase: string): Promise<Map<string, ChartSpec | null>> {
  const out = new Map<string, ChartSpec | null>();
  const put = (k: string, s: ChartSpec | null | undefined) => out.set(k, s ?? null);
  const { from, to } = PERIOD;

  // Home and the full Dashboard.
  const home = await e.call<Arg<typeof homeSalesGraph>>('dashboard.summary', homeSummaryInput(TODAY, from, to));
  const g = homeSalesGraph(home);
  assert.ok(g, `${phase} app.gateway: Home's sales graph`);
  assert.ok(g.values.some((v) => v > 0));
  const dash = await e.call<Arg<typeof homeSalesGraph>>('dashboard.summary', summaryInput(TODAY, from, to));
  put('dashboard.home', trendSpec(dash.trend, undefined, dash.asOf));
  put('dashboard.home:ageing card', ageingSpec(dash.receivables.ageing));

  // Reports.
  put('reports.profitLoss', profitTrendChart(await e.call('reports.profitTrend', { from, to })));
  put('reports.cashBank', cashBankChart(await e.call('reports.cashBank', { from, to })));
  put('reports.register#months', registerChart(await e.call('reports.register', { baseType: 'sales', from, to, includeVouchers: false }), { workingDate: TODAY }));
  put('reports.register#months:purchase', registerChart(await e.call('reports.register', { baseType: 'purchase', from, to, includeVouchers: false }), { workingDate: TODAY }));
  put('reports.register#months:receipt', registerChart(await e.call('reports.register', { baseType: 'receipt', from, to, includeVouchers: false }), { workingDate: TODAY }));
  for (const [name, id] of [
    ['customer', w.asha],
    ['bank', w.bank],
    ['cash', w.cash],
    ['sales', w.sales],
  ] as const) {
    const led = await e.call<Arg<typeof ledgerChart>>('reports.ledger', { ledgerId: id, from, to });
    put(`reports.ledger:${name}`, ledgerChart(led, null));
    put(`reports.monthlySummary:${name}`, monthlySummaryChart(await e.call('reports.monthlySummary', { ledgerId: id, from, to }), { workingDate: TODAY }));
  }
  for (const grp of ['Sundry Debtors', 'Sundry Creditors', 'Sales Accounts', 'Bank Accounts', 'Current Assets']) {
    put(`reports.monthlySummary:group ${grp}`, monthlySummaryChart(await e.call('reports.monthlySummary', { groupId: w.groups[grp], from, to }), { workingDate: TODAY }));
    put(`reports.groupSummary#summary:${grp}`, groupSummaryChart(await e.call('reports.groupSummary', { groupId: w.groups[grp], from, to, showZero: false, basis: 'trialBalance' })));
  }
  put('reports.cashFlow', cashFlowChart(await e.call('reports.cashFlow', { from, to })));

  // Outstanding.
  const base = { asOf: to, nonBillWise: 'fifo' };
  put('outstanding.receivables#ageing', ageingChart(await e.call('outstanding.ageing', { ...base, side: 'receivable', buckets: [...DEFAULT_AGEING_BUCKETS], basis: 'due_date' })));
  put('outstanding.payables#ageing', ageingChart(await e.call('outstanding.ageing', { ...base, side: 'payable', buckets: [...DEFAULT_AGEING_BUCKETS], basis: 'due_date' })));
  put('outstanding.party', partyChart(await e.call('outstanding.ledgerBills', { ledgerId: w.asha, asOf: to, nonBillWise: 'fifo' })));
  put('outstanding.statement', statementChart(await e.call('outstanding.statement', { ledgerId: w.asha, from, to })));

  // Stock.
  put('stock.summary', stockSummaryChart(await e.call('stock.summary', { from, to, showValues: true, showZero: false }), 'group'));
  put('stock.categories', stockSummaryChart(await e.call('stock.categorySummary', { from, to, showValues: true, showZero: false }), 'category'));
  put('stock.ageing', stockAgeingChart(await e.call('stock.ageing', { asOf: to, buckets: AGEING_PRESETS[0].buckets })));
  put('stock.item', stockItemChart(await e.call('stock.itemVouchers', { itemId: w.primer, from, to })));
  put('stock.item:new', stockItemChart(await e.call('stock.itemVouchers', { itemId: w.brush, from, to })));
  put('stock.profitability', profitabilityChart(await e.call('stock.profitability', { from, to })));
  put('stock.godowns', godownsChart(await e.call('stock.godownSummary', { asOf: to, showZero: false })));
  put('stock.movement', movementChart(await e.call('stock.movement', { from, to, itemId: w.primer }), 'outward'));

  // GST.
  const periods = await e.call<NonNullable<Parameters<typeof initialPeriodKey>[0]>>('gst.periods', {});
  const key = initialPeriodKey(periods);
  assert.equal(key, '092026', 'GSTR-3B and the set-off open on the return due on 11-Oct: September');
  put('gst.gstr3b', gstr3bMeter(await e.call('gst.gstr3b.summary', { period: key })));
  const fy = initialFy(periods, TODAY);
  assert.ok(fy);
  put('gst.gstr9', gstr9Chart(await e.call('gst.gstr9.summary', { fy })));
  const zero = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  put('gst.setoff', setoffMeter(await e.call('gst.setoff.compute', { period: key, penalty: zero, others: zero })));
  put('gst.ledger.cash', cashLedgerChart(await e.call('gst.ledger.cash', { from, to })));
  put('gst.ledger.credit', creditLedgerChart(await e.call('gst.ledger.credit', { from, to })));
  put('gst.register', rateChart(await e.call('gst.register', { from, to, kind: 'sales' })));
  put('gst.hsn', hsnChart(await e.call('gst.hsnSummary', { from, to, direction: 'outward' })));
  put('gst.itc', itcChart(await e.call('gst.itc', { from, to })));
  put('gst.exceptions', exceptionsChart((await e.call<{ issues: Arg<typeof exceptionsChart> }>('gst.exceptions', { from, to })).issues));

  // Banking.
  put('banking.summary', bankBalancesChart(await e.call('banking.summary', { asOf: to })));
  put('banking.pdc', pdcChart(await e.call('banking.pdc', { asOf: to })));
  return out;
}

/**
 * The graphs this company does NOT get, per phase, and why — every one a deliberate rule of the kit (2.1.1 D2:
 * one category is a sentence, not a comparison; a meter needs both parts) or no data at all. The test pins
 * the exact set: anything else that returns no graph fails, and so does a listed case that starts drawing
 * (then this list is out of date).
 */
const ONE_OF = 'a sentence, not a comparison (2.1.1 D2: categories need two)';
const SAME: Readonly<Record<string, string>> = {
  'reports.groupSummary#summary:Sundry Creditors': `one supplier — ${ONE_OF}`,
  'reports.groupSummary#summary:Sales Accounts': `one sales ledger — ${ONE_OF}`,
  'reports.groupSummary#summary:Bank Accounts': `one bank — ${ONE_OF}`,
  'outstanding.party': 'a meter against the credit limit: no limit is set for this customer',
  'stock.categories': 'no stock categories: everything is "Not categorised" — one bar',
  'stock.godowns': `one godown (Main Location) — ${ONE_OF}`,
  'stock.movement': `one buyer of this item — ${ONE_OF}`,
  'gst.setoff': 'a meter: needs cash already in the GST cash ledger',
  'gst.ledger.cash': 'no deposit in the GST cash ledger yet (a line needs two points)',
  'gst.itc': `one supplier — ${ONE_OF}`,
  'gst.exceptions': 'no two kinds of GST problem (none at all is the success state)',
  'banking.summary': `one bank — ${ONE_OF}`,
  'banking.pdc': 'no post-dated cheques',
};
const EXPECTED_NONE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  oct: {
    ...SAME,
    'dashboard.home:ageing card': `every unpaid bill is 1–30 days old — ${ONE_OF}`,
    'outstanding.receivables#ageing': `every unpaid bill is 1–30 days old — ${ONE_OF}`,
    'outstanding.payables#ageing': `every unpaid bill is 1–30 days old — ${ONE_OF}`,
    'gst.gstr3b': 'the return period it opens on is September: nothing to file yet (a meter needs both parts)',
  },
  sepOct: SAME,
};

describe('2.1.1: a real young company (books from 1-Apr, entries in the last month or two) sees its graphs', () => {
  let e: E2E;
  let w: World;
  const seen: Record<string, Map<string, ChartSpec | null>> = {};

  before(async () => {
    e = startRuntime(TODAY);
    w = await seed(e);
  });
  after(async () => {
    await e.close();
  });

  it('phase 1 — entries in October only', async () => {
    await month(e, w, '2026-10', 1);
    seen.oct = await walk(e, w, 'Oct');
  });

  it('phase 2 — entries in September and October', async () => {
    await month(e, w, '2026-09', 2);
    seen.sepOct = await walk(e, w, 'Sep+Oct');
  });

  for (const phase of ['oct', 'sepOct']) {
    it(`${phase}: every graph its screen builds draws, except the listed ones`, () => {
      const m = seen[phase];
      assert.ok(m && m.size > 40, `${phase}: the walk ran`);
      const none: string[] = [];
      for (const [k, spec] of m) {
        if (spec) draws(`${phase} ${k}`, spec);
        else none.push(k);
      }
      assert.deepEqual(none.sort(), Object.keys(EXPECTED_NONE[phase]).sort());
    });
  }

  it('Monthly Summary on real books: columns from the first month with an amount, tied to the table', async () => {
    const { from, to } = PERIOD;
    // A customer (an asset): each column = that month's Closing; Apr…Oct (the running month "so far").
    const ms = await e.call<Arg<typeof monthlySummaryChart>>('reports.monthlySummary', { ledgerId: w.asha, from, to });
    const spec = draws('customer', monthlySummaryChart(ms, { workingDate: TODAY }));
    assert.equal(spec.kind, 'column');
    assert.equal(spec.title, 'Closing balance by month');
    assert.deepEqual(spec.categories, ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    assert.deepEqual(spec.series[0].values, ms.rows.slice(0, 7).map((r) => r.closing));
    assert.equal(spec.partialLast, true);
    assert.deepEqual(
      spec.series[0].values.map((v) => v !== 0),
      [false, false, false, false, false, true, true],
      'nothing before September: the young company draws from its first month',
    );
    // Sales (income): net movement per month on the credit side, Σ = the table's net movement.
    const sales = await e.call<Arg<typeof monthlySummaryChart>>('reports.monthlySummary', { ledgerId: w.sales, from, to });
    const mv = draws('sales', monthlySummaryChart(sales, { workingDate: TODAY }));
    assert.equal(mv.title, 'Net movement by month');
    assert.equal(mv.total, sales.totals.credit - sales.totals.debit);
    assert.ok(mv.total > 0);
  });
});

/**
 * The owner's case at its youngest: books beginning on the 1st of THIS month (the period the reports open on
 * starts there too) and a week of entries. Home, the Dashboard trend and the by-month reports draw their one
 * month; the running balances draw from the opening and the first entry.
 */
describe('2.1.1: books beginning this month — the first week already draws', () => {
  let e: E2E;
  let w: World;
  const from = '2026-10-01';

  before(async () => {
    e = startRuntime(TODAY);
    w = await seed(e, from);
    await month(e, w, '2026-10', 1);
  });
  after(async () => {
    await e.close();
  });

  it('Home, the Dashboard trend and the by-month graphs show October alone', async () => {
    const home = await e.call<Arg<typeof homeSalesGraph>>('dashboard.summary', homeSummaryInput(TODAY, from, TODAY));
    const g = homeSalesGraph(home);
    assert.ok(g);
    assert.deepEqual(g.months, ['Oct']);
    assert.ok(g.values[0] > 0);
    const dash = await e.call<Arg<typeof homeSalesGraph>>('dashboard.summary', summaryInput(TODAY, from, TODAY));
    draws('dashboard trend', trendSpec(dash.trend, undefined, dash.asOf));
    const one = (k: string, spec: ChartSpec | null | undefined) => {
      const s = draws(k, spec);
      assert.deepEqual(s.categories, ['Oct'], k);
      assert.equal(s.partialLast ?? false, true, `${k}: October is still running — "so far"`);
    };
    one('monthly summary (customer)', monthlySummaryChart(await e.call('reports.monthlySummary', { ledgerId: w.asha, from, to: TODAY }), { workingDate: TODAY }));
    one('monthly summary (Sales Accounts)', monthlySummaryChart(await e.call('reports.monthlySummary', { groupId: w.groups['Sales Accounts'], from, to: TODAY }), { workingDate: TODAY }));
    one('sales register', registerChart(await e.call('reports.register', { baseType: 'sales', from, to: TODAY, includeVouchers: false }), { workingDate: TODAY }));
    draws('profit & loss', profitTrendChart(await e.call('reports.profitTrend', { from, to: TODAY })));
    draws('cash flow', cashFlowChart(await e.call('reports.cashFlow', { from, to: TODAY })));
    draws('ledger (customer)', ledgerChart(await e.call('reports.ledger', { ledgerId: w.asha, from, to: TODAY }), null));
    draws('statement (customer)', statementChart(await e.call('outstanding.statement', { ledgerId: w.asha, from, to: TODAY })));
    draws('stock item', stockItemChart(await e.call('stock.itemVouchers', { itemId: w.primer, from, to: TODAY })));
  });
});

/**
 * The add-on modules (F11: TDS, multiple currencies, cheque printing, manufacturing, POS) on a company whose
 * first entries are this month — the parity masters (parityFlow.ts) and one of each flow, all dated today.
 */
describe('2.1.1: the add-on modules of a young company (first entries this month) draw their graphs', () => {
  let e: E2E;
  let m: ParityMasters;
  const got = new Map<string, ChartSpec | null>();

  before(async () => {
    e = startRuntime(TODAY);
    const s = await e.call<{ dataDir: string }>('app.state');
    await e.call('app.dataDir.set', { path: s.dataDir, mode: 'use' });
    await e.call('app.company.create', {
      name: 'Young Works E2E',
      stateCode: PARITY.company.stateCode,
      gstRegistrationType: 'regular',
      gstin: PARITY.company.gstin,
      pan: PARITY.company.pan,
      booksFrom: BOOKS_FROM,
      fyStartMonth: 4,
      features: { inventory: true, multipleGodowns: false, batches: false, billWise: true, costCentres: false, orderProcessing: false, einvoice: false, ewayBill: false, gst: true },
    });
    await e.call('company.features.save', Object.fromEntries(PARITY.features.map((k) => [k, true])));
    const call: ApiCall = <R>(route: string, input?: unknown) => e.call<R>(route, input);
    m = await seedParityMasters(call, TODAY);
    // POS: one bill paid part UPI, part cash.
    const ctx = await e.call<{ saleVoucherTypeId: number; walkIn: { id: number } | null; companyStateCode: string | null; tenderModes: Array<{ id: number; kind: string }> }>('pos.context', {});
    const cash = ctx.tenderModes.find((t) => t.kind === 'cash')?.id;
    await e.call('vouchers.save', {
      voucherTypeId: ctx.saleVoucherTypeId,
      date: TODAY,
      mode: 'item_invoice',
      partyLedgerId: ctx.walkIn?.id,
      placeOfSupply: ctx.companyStateCode ?? undefined,
      items: [{ itemId: m.item, qty: 1, rate: 100 }],
      posBill: { tenders: [{ modeId: cash, amount: PARITY.pos.cash }, { modeId: m.upiMode, amount: PARITY.pos.upi }], cashTendered: PARITY.pos.tendered },
    });
    // A contractor's bill with TDS (194C), the export invoice in US$, a Manufacturing Journal, a cheque.
    await e.call('vouchers.save', { voucherTypeId: m.types.purchase, date: TODAY, mode: 'accounting_invoice', partyLedgerId: m.supplier, referenceNo: PARITY.tds.supplierInvoiceNo, ledgers: [{ ledgerId: m.expense, amount: PARITY.tds.amount }] });
    await e.call('vouchers.save', exportInvoiceInput(m, TODAY));
    const mj = (await e.call<Array<{ id: number; class: string }>>('mfg.journal.types', {})).find((t) => t.class === 'manufacturing');
    assert.ok(mj);
    await e.call('vouchers.save', {
      voucherTypeId: mj.id,
      date: TODAY,
      mode: 'inventory',
      stockJournal: { bomId: m.bom, lines: [{ role: 'product', itemId: m.kit, qty: PARITY.kit.qty }, { role: 'component', itemId: m.item, qty: PARITY.kit.consumed }] },
    });
    await e.call('vouchers.save', chequePaymentInput(m, TODAY));

    // Read each screen's data as the screen does (default period: the financial year to today).
    const { from, to } = PERIOD;
    got.set('pos.summary (Day)', tenderChart(await e.call('pos.summary', { from: TODAY, to: TODAY })));
    got.set('pos.summary (Period)', tenderChart(await e.call('pos.summary', { from, to })));
    got.set('mfg.production', productionChart(await e.call('mfg.production.register', { from, to }), TODAY.slice(0, 7)));
    got.set('tds.computation', computationChart(await e.call('tds.computation', { from, to, kind: 'tds' })));
    got.set('tds.outstanding', tdsOutstandingChart(await e.call('tds.outstanding', { asOf: to, kind: 'tds', includeSettled: false })));
    got.set('tds.challans', challansChart(await e.call('tds.challans', { from, to, kind: 'tds' }), from, to));
    got.set('tds.return', returnChart(await e.call('tds.return.data', { form: '26Q', fyStart: 2026, quarter: 2 })));
    got.set('forex.ledger', forexLedgerChart(await e.call('forex.ledger', { ledgerId: m.overseas, from, to })));
    got.set('forex.outstanding', forexOutstandingChart(await e.call('forex.outstanding', { asOf: to, kind: 'receivable' }), 'receivable'));
    // The register opens on the bank's leaves (no book chosen): its only book is the meter's (meterBook).
    const books = await e.call<Arg<typeof meterBook>>('cheques.book.list', { bankLedgerId: m.bank });
    assert.equal(books.length, 1);
    const register = await e.call<Arg<typeof leafMeter>>('cheques.register', { bankLedgerId: m.bank, status: 'all', asOf: to });
    got.set('cheques.register', leafMeter(register, meterBook(books, null, register.totals)));
    const chosen = await e.call<Arg<typeof leafMeter>>('cheques.register', { bankLedgerId: m.bank, bookId: books[0].id, status: 'all', asOf: to });
    got.set('cheques.register (the book chosen)', leafMeter(chosen, meterBook(books, books[0].id, chosen.totals)));
  });
  after(async () => {
    await e.close();
  });

  /** The graphs this company does not get here, and why (exact: see EXPECTED_NONE above). */
  const NONE: Readonly<Record<string, string>> = {
    'tds.computation': 'one TDS section — a sentence, not a comparison',
    'tds.challans': 'no challan deposited yet',
    'tds.return': 'a meter: no challan yet (quarter 2 of 2026-27 has no deduction either)',
    'forex.outstanding': 'one bill, not yet due — one age bucket',
  };

  it('every add-on graph draws, or is a listed no-graph case', () => {
    assert.equal(got.size, 11, 'the walk ran');
    const none: string[] = [];
    for (const [k, spec] of got) {
      if (spec) draws(k, spec);
      else none.push(k);
    }
    assert.deepEqual(none.sort(), Object.keys(NONE).sort());
  });
});
