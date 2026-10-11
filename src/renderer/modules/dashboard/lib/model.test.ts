import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DashboardAgeingBucket, DashboardSummary } from '../../../../shared/types/dashboard.ts';
import {
  ageingSpec,
  balanceRange,
  buildAlerts,
  cardLines,
  cashBankCaption,
  changeText,
  compactSigned,
  deltaPercent,
  DRILL,
  dueText,
  exportTable,
  flowKpi,
  gstDueLine,
  gstItems,
  HOME_ALERTS_SHOWN,
  HOME_GRAPH_TITLE,
  HOME_PANEL,
  homeAlerts,
  homeFigures,
  homeSalesDrill,
  homeSalesGraph,
  isVoucherTarget,
  plural,
  setupLine,
  shortMonth,
  parseStartPrefs,
  signedKpi,
  startCardMode,
  canShowStartCard,
  startProgress,
  startSteps,
  toggleTicked,
  summaryInput,
  homeSummaryInput,
  trendCardText,
  trendChart,
  trendSpec,
} from './model.ts';
import { assertSpec, drawnTotal, enoughData, markColor } from '../../../ui/lib/chartSpec.ts';

const range = (from: string, to: string) => ({ from, to });
const buckets = (amounts: number[]): DashboardAgeingBucket[] =>
  ['Not due', '1–30 days', '31–60 days', '61–90 days', '91–180 days', '> 180 days'].map((label, i) => ({
    index: i,
    label,
    minDays: [null, 1, 31, 61, 91, 181][i],
    maxDays: [0, 30, 60, 90, 180, null][i],
    amount: amounts[i] ?? 0,
  }));

/** The testkit books of the core module (src/core/modules/dashboard/testkit.ts), as the route returns them. */
function sample(over: Partial<DashboardSummary> = {}): DashboardSummary {
  const flow = { today: 30_000, mtd: 130_000, ytd: 480_000, period: 480_000, lastYear: { today: 60_000, mtd: 100_000, ytd: 100_000, period: 100_000 } };
  return {
    asOf: '2026-10-08',
    today: '2026-10-08',
    booksFrom: '2025-04-01',
    ranges: {
      today: range('2026-10-08', '2026-10-08'),
      mtd: range('2026-10-01', '2026-10-08'),
      ytd: range('2026-04-01', '2026-10-08'),
      period: range('2026-04-01', '2026-10-08'),
      lastYear: { today: range('2025-10-08', '2025-10-08'), mtd: range('2025-10-01', '2025-10-08'), ytd: range('2025-04-01', '2025-10-08'), period: range('2025-04-01', '2025-10-08') },
    },
    features: { inventory: true, integrated: true, gst: true, billWise: true, einvoice: false, ewayBill: false },
    hasVouchers: true,
    setup: { profileComplete: true, featuresReviewed: true, invoicePrintingSet: true, hasOwnLedgers: true, hasItems: true, hasSales: true, backupFolderSet: true, numberingSet: true, hasReceipts: true },
    sales: flow,
    purchases: { today: 0, mtd: 300_000, ytd: 875_000, period: 875_000, lastYear: { today: 0, mtd: 250_000, ytd: 250_000, period: 250_000 } },
    grossProfit: { method: 'stock_valuation', sales: 480_000, purchases: 875_000, directIncomes: 0, directExpenses: 0, openingStock: 1_454_000, closingStock: 1_989_000, costOfSales: 340_000, amount: 140_000, marginPercent: 29.17 },
    receivables: {
      total: 500_800, overdue: 339_400, overdueBillCount: 2, overduePartyCount: 2, notDue: 161_400, advance: 0, onAccount: 0, partyCount: 3,
      ageing: buckets([161_400, 295_000, 0, 0, 44_400, 0]),
      dueSoon: { days: 7, until: '2026-10-15', amount: 126_000, count: 1 },
    },
    payables: {
      total: 667_500, overdue: 225_000, overdueBillCount: 1, overduePartyCount: 1, notDue: 442_500, advance: 0, onAccount: 0, partyCount: 2,
      ageing: buckets([442_500, 0, 0, 0, 225_000, 0]),
      dueSoon: { days: 7, until: '2026-10-15', amount: 88_500, count: 1 },
    },
    cashBank: { cashTotal: 610_200, cash: [{ ledgerId: 1, name: 'Cash', balance: 610_200, isOverdraft: false, accountTail: null }], bankTotal: 2_987_500, banks: [{ ledgerId: 27, name: 'HDFC Bank', balance: 2_987_500, isOverdraft: false, accountTail: '5678' }] },
    gst: { period: '102026', label: 'Oct 2026', from: '2026-10-01', to: '2026-10-31', dueDate: '2026-11-20', dueForm: 'GSTR-3B', filingFrequency: 'monthly', outputTax: 7_800, reverseChargeTax: 0, inputTax: 54_000, netPayable: 0, creditCarriedForward: 46_200, documentCount: 4 },
    gstDue: null,
    topCustomers: [{ ledgerId: 19, name: 'Bangalore Retail', amount: 250_000, invoiceCount: 1, sharePercent: 52.08 }],
    topItems: [{ itemId: 2, name: 'Mixer Grinder', unit: 'Nos', qty: 16, amount: 380_000, sharePercent: 79.17 }],
    trend: Array.from({ length: 12 }, (_, i) => {
      const month = i < 2 ? `2025-${String(11 + i)}` : `2026-${String(i - 1).padStart(2, '0')}`;
      const sales = { '2026-04': 100_000, '2026-09': 250_000, '2026-10': 130_000 }[month] ?? 0;
      const purchases = { '2026-04': 500_000, '2026-08': 75_000, '2026-10': 300_000 }[month] ?? 0;
      return { month, from: `${month}-01`, to: `${month}-28`, sales, purchases };
    }),
    lowStock: { count: 2, items: [{ itemId: 4, name: 'Steel Tumbler', unit: 'Nos', onHand: 3, reorderLevel: 10, shortfall: 7 }, { itemId: 2, name: 'Mixer Grinder', unit: 'Nos', onHand: 57, reorderLevel: 60, shortfall: 3 }] },
    compliance: { einvoicePending: null, ewayPending: null, from: '2026-04-01', to: '2026-10-08' },
    recentVouchers: [],
    postDated: { count: 2, inflow: 44_400, outflow: 225_000, rows: [
      { id: 20, date: '2026-10-20', number: '2', typeName: 'Receipt', baseType: 'receipt', partyName: 'Acme Traders', amount: 44_400, direction: 'in', bankLedgerId: 27, bankName: 'HDFC Bank', instrumentNo: '123456' },
    ] },
    backup: { lastBackupAt: null, daysSince: null },
    cached: false,
    elapsedMs: 12,
    ...over,
  };
}

test('deltaPercent / changeText: 1 decimal, null without a base', () => {
  assert.equal(deltaPercent(480_000, 100_000), 380); // (4,800 − 1,000) ÷ 1,000
  assert.equal(deltaPercent(90, 120), -25);
  assert.equal(deltaPercent(1, 3), -66.7);
  assert.equal(deltaPercent(5, 0), null);
  assert.equal(deltaPercent(50, -100), 150); // a loss turning into a profit
  assert.equal(changeText(12.5), '+12.5%');
  assert.equal(changeText(-3), '−3.0%');
  assert.equal(changeText(0), 'no change');
  assert.equal(changeText(null), null);
});

test('plural, shortMonth, dueText', () => {
  assert.equal(plural(1, 'bill'), '1 bill');
  assert.equal(plural(12345, 'bill'), '12,345 bills');
  assert.equal(plural(2, 'party', 'parties'), '2 parties');
  assert.equal(shortMonth('2026-10'), 'Oct 26');
  assert.equal(dueText('2026-10-08', '2026-10-08'), 'Due today');
  assert.equal(dueText('2026-10-09', '2026-10-08'), 'Due tomorrow');
  assert.equal(dueText('2026-10-11', '2026-10-08'), 'Due in 3 days');
  assert.equal(dueText('2026-10-07', '2026-10-08'), '1 day overdue');
  assert.equal(dueText('2026-09-15', '2026-10-08'), '23 days overdue');
});

test('flowKpi: period value, delta vs the same period last year, captions', () => {
  const k = flowKpi(sample().sales);
  assert.equal(k.value, 480_000);
  assert.equal(k.delta, 380);
  assert.equal(k.caption, 'Today ₹300 · This month ₹1.3 K');
  assert.equal(k.comparison, 'Same period last year ₹1.0 K');
  const fresh = flowKpi({ ...sample().sales, lastYear: { today: 0, mtd: 0, ytd: 0, period: 0 } });
  assert.equal(fresh.delta, null);
  assert.equal(fresh.comparison, 'Nothing in the same period last year');
});

test('trendChart: Sales is the measured series, Purchases grey context (D29); takeaway in one sentence', () => {
  const c = trendChart(sample().trend);
  assert.equal(c.categories.length, 12);
  assert.equal(c.categories[0], 'Nov 25');
  assert.equal(c.categories[11], 'Oct 26');
  assert.deepEqual(c.series.map((x) => [x.name, x.slot]), [['Sales', 1], ['Purchases', 'other']]);
  assert.equal(c.series[0].values[10], 250_000);
  assert.equal(c.empty, false);
  assert.equal(c.description, 'Best month Sep 2026 ₹2.5 K · 12 months: sales ₹4.8 K, purchases ₹8.8 K');
  const none = trendChart(sample().trend.map((m) => ({ ...m, sales: 0, purchases: 0 })));
  assert.equal(none.empty, true);
  assert.equal(trendSpec(sample().trend.map((m) => ({ ...m, sales: 0, purchases: 0 }))), null, 'nothing to draw: no graph');
});

test('trendSpec: a valid line spec — Sales slot 1 with Purchases as context, Enter opens the month', () => {
  const opened: number[] = [];
  const spec = trendSpec(sample().trend, (i) => opened.push(i));
  assert.ok(spec);
  assertSpec(spec);
  assert.equal(spec.kind, 'line');
  assert.equal(spec.title, 'Sales and purchases — last 12 months');
  assert.equal(spec.series[1].slot, 'other');
  assert.equal(markColor(spec, 3, 1), 'other', 'Purchases is never a second colour');
  assert.equal(spec.total, drawnTotal(spec));
  assert.ok(spec.takeaway.length <= 90);
  spec.activate?.(10);
  assert.deepEqual(opened, [10]);
});

test('trend: months after the balances date have no mark (never a fall to zero) and stay out of the takeaway', () => {
  // A whole-year period (Apr–Mar) on 8-Oct: the core trend runs to March; Nov–Mar have not happened.
  const year = Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    const month = `${m >= 4 ? 2026 : 2027}-${String(m).padStart(2, '0')}`;
    return { month, from: `${month}-01`, to: `${month}-28`, sales: m === 9 ? 250_000 : m === 10 ? 130_000 : m === 4 ? 100_000 : 0, purchases: m === 4 ? 500_000 : 0 };
  });
  const c = trendChart(year, '2026-10-08');
  assert.deepEqual(c.series[0].values.slice(6), [130_000, null, null, null, null, null], 'Oct drawn, Nov–Mar no mark');
  assert.deepEqual(c.series[1].values.slice(7), [null, null, null, null, null]);
  assert.equal(c.description, 'Best month Sep 2026 ₹2.5 K · 7 months: sales ₹4.8 K, purchases ₹5.0 K');
  const spec = trendSpec(year, undefined, '2026-10-08');
  assert.ok(spec);
  assertSpec(spec);
  assert.equal(spec.total, 130_000, 'a line\'s drawn total is its last drawn point (Oct), not a trailing 0');
  // Without a balances date every month is drawn (the 2.0 behaviour), and nothing in the past: no graph.
  assert.equal(trendChart(year).series[0].values[11], 0);
  assert.equal(trendSpec(year.map((m) => (m.month <= '2026-10' ? { ...m, sales: 0, purchases: 0 } : { ...m, sales: 5 })), undefined, '2026-10-08'), null);
});

test('trend card: too little to draw (two months into a whole-year period) never says "no sales or purchases"', () => {
  // A whole-year period (Apr–Mar) on 10-May: only Apr and May have happened — a line needs three points, so no graph,
  // but the card's one sentence must still tell the truth about those two months.
  const year = Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    const month = `${m >= 4 ? 2026 : 2027}-${String(m).padStart(2, '0')}`;
    return { month, from: `${month}-01`, to: `${month}-28`, sales: m === 4 ? 100_000 : m === 5 ? 50_000 : 0, purchases: m === 4 ? 30_000 : 0 };
  });
  assert.equal(trendSpec(year, undefined, '2026-05-10'), null, 'two months: no graph');
  const text = trendCardText(year, '2026-05-10');
  assert.doesNotMatch(text, /^No sales/);
  assert.equal(text, trendChart(year, '2026-05-10').description);
  assert.match(text, /2 months: sales ₹1\.5 K, purchases ₹300$/);
  // Nothing at all: the empty sentence; a drawable trend: the graph's own takeaway.
  assert.equal(trendCardText(year.map((m) => ({ ...m, sales: 0, purchases: 0 })), '2026-05-10'), 'No sales or purchases in the last 12 months');
  assert.equal(trendCardText(sample().trend), trendSpec(sample().trend)?.takeaway);
});

test('ageingSpec: ordinal columns, "Not due" grey, total = Σ buckets, takeaway names its base', () => {
  const r = sample().receivables;
  const spec = ageingSpec(r.ageing);
  assert.ok(spec);
  assertSpec(spec);
  assert.equal(spec.color, 'ordinal');
  assert.equal(spec.greyBefore, 1);
  assert.deepEqual(spec.categories, ['Not due', '1–30 days', '31–60 days', '61–90 days', '91–180 days', '> 180 days']);
  assert.equal(spec.total, r.ageing.reduce((t, b) => t + b.amount, 0));
  assert.equal(spec.total, r.notDue + r.overdue, 'the bills outstanding');
  assert.equal(markColor(spec, 0), 'other');
  assert.equal(markColor(spec, 5), 'o5', 'the oldest bucket is the darkest');
  assert.equal(spec.takeaway, 'Of ₹5.0 K in unpaid bills, ₹444 is over 90 days');
  // More than five overdue buckets fold into the oldest (Σ kept); fewer than three non-zero: no graph.
  const seven = [...r.ageing, { index: 6, label: '> 365 days', minDays: 366, maxDays: null, amount: 1_000 }];
  const folded = ageingSpec(seven.map((b, i) => (i === 5 ? { ...b, maxDays: 365 } : b)));
  assert.ok(folded);
  assertSpec(folded);
  assert.equal(folded.categories.length, 6);
  assert.equal(folded.categories[5], 'Over 180 days');
  assert.equal(folded.total, spec.total + 1_000);
  assert.equal(ageingSpec(buckets([500, 0, 0, 0, 0, 0])), null);
  assert.equal(ageingSpec(buckets([0, 0, 0, 0, 0, 0])), null);
  const fresh = ageingSpec(buckets([100, 200, 300, 0, 0, 0]));
  assert.equal(fresh?.takeaway, 'Of ₹6 in unpaid bills, ₹5 is overdue');
});

test('alerts: most serious first, plain-English, each drills to its screen', () => {
  const alerts = buildAlerts(sample());
  assert.deepEqual(
    alerts.map((a) => [a.id, a.tone]),
    [
      ['receivables-overdue', 'danger'], // ₹444 is over 90 days old
      ['backup', 'danger'], // never backed up, with vouchers
      ['payables-overdue', 'warning'],
      ['low-stock', 'warning'],
      ['payables-due-soon', 'info'],
    ],
  );
  const rec = alerts[0];
  assert.equal(rec.title, '₹3.4 K overdue from customers');
  assert.equal(rec.body, '2 bills from 2 customers are past the due date — ₹444 is over 90 days old.');
  assert.deepEqual(rec.target, { screen: 'outstanding.receivables', params: { view: 'bills', overdueOnly: true } });
  const low = alerts.find((a) => a.id === 'low-stock');
  assert.equal(low?.title, '2 items below reorder level');
  assert.equal(low?.body, 'Steel Tumbler, Mixer Grinder.');
  assert.deepEqual(low?.target, { screen: 'stock.reorder' });
  const soon = alerts.find((a) => a.id === 'payables-due-soon');
  assert.equal(soon?.body, '1 supplier bill falls due by 15-Oct-2026.');
});

test('alerts: GST, compliance, overdraft, negative cash, post-dated cheques, stale backup; all clear', () => {
  const s = sample({
    gst: { ...sample().gst!, netPayable: 43_800, dueDate: '2026-10-11' },
    compliance: { einvoicePending: 3, ewayPending: 1, from: '2026-04-01', to: '2026-10-08' },
    cashBank: { cashTotal: -5_000, cash: [], bankTotal: -100, banks: [{ ledgerId: 9, name: 'SBI', balance: -100, isOverdraft: false, accountTail: null }, { ledgerId: 10, name: 'SBI OD', balance: -900, isOverdraft: true, accountTail: null }] },
    postDated: { count: 1, inflow: 44_400, outflow: 0, rows: [{ id: 20, date: '2026-10-12', number: '2', typeName: 'Receipt', baseType: 'receipt', partyName: 'Acme Traders', amount: 44_400, direction: 'in', bankLedgerId: 27, bankName: 'HDFC Bank', instrumentNo: '1' }] },
    backup: { lastBackupAt: '2026-09-28T04:30:00.000Z', daysSince: 10 },
  });
  const byId = new Map(buildAlerts(s).map((a) => [a.id, a]));
  assert.equal(byId.get('gst-due')?.tone, 'warning'); // 3 days before the due date
  // (V6) Home shows the title alone (the body is the tooltip): the title says when, as 2.0's visible body did.
  assert.equal(byId.get('gst-due')?.title, 'GST of ₹438 for Oct 2026 · due in 3 days');
  assert.equal(byId.get('gst-due')?.body, 'Estimated cash payment after input credit. GSTR-3B is due by 11-Oct-2026 (due in 3 days).');
  assert.deepEqual(byId.get('gst-due')?.target, { screen: 'gst.gstr3b', params: { period: '102026' } });
  assert.equal(byId.get('einvoice-pending')?.title, '3 invoices without an e-Invoice');
  assert.equal(byId.get('eway-pending')?.title, '1 invoice without an e-Way Bill');
  assert.deepEqual(byId.get('eway-pending')?.target, { screen: 'gst.ewaybill', params: { from: '2026-04-01', to: '2026-10-08' } });
  assert.equal(byId.get('cash-negative')?.tone, 'danger');
  assert.equal(byId.get('cash-negative')?.body, 'The cash books show ₹ 50.00 Cr — a payment may have been entered twice or a receipt is missing.');
  assert.ok(byId.has('bank-overdrawn-9'));
  assert.ok(!byId.has('bank-overdrawn-10'), 'an OD account in use is not an alert');
  assert.equal(byId.get('pdc-week')?.body, 'Next: Acme Traders ₹ 444.00 on 12-Oct-2026.');
  assert.equal(byId.get('backup')?.title, 'Last backup was 10 days ago');

  const calm = sample({
    receivables: { ...sample().receivables, overdue: 0, overdueBillCount: 0, overduePartyCount: 0 },
    payables: { ...sample().payables, overdue: 0, overdueBillCount: 0, dueSoon: { days: 7, until: '2026-10-15', amount: 0, count: 0 } },
    lowStock: { count: 0, items: [] },
    postDated: { count: 0, inflow: 0, outflow: 0, rows: [] },
    backup: { lastBackupAt: '2026-10-07T04:30:00.000Z', daysSince: 1 },
  });
  assert.deepEqual(buildAlerts(calm), []);
});

test('drill targets use the canonical screen ids', () => {
  assert.deepEqual(DRILL.salesRegister(range('2026-10-01', '2026-10-31')), { screen: 'reports.register', params: { baseType: 'sales', from: '2026-10-01', to: '2026-10-31' } });
  assert.deepEqual(DRILL.ledger(5), { screen: 'reports.ledger', params: { ledgerId: 5 } });
  assert.deepEqual(DRILL.voucher(7), { screen: 'vouchers.view', params: { id: 7 } });
  assert.deepEqual(DRILL.dayBook(range('2026-10-08', '2026-10-08')), { screen: 'vouchers.daybook', params: { from: '2026-10-08', to: '2026-10-08' } });
  assert.deepEqual(DRILL.stockItem(4), { screen: 'stock.item', params: { itemId: 4 } });
  assert.deepEqual(DRILL.brs(27), { screen: 'banking.brs', params: { ledgerId: 27 } });
});

test('exportTable: every figure, last year alongside, no bare minus on balances', () => {
  const s = sample({
    grossProfit: { ...sample().grossProfit!, amount: -395_000, marginPercent: -82.29 },
    cashBank: { ...sample().cashBank, banks: [{ ledgerId: 9, name: 'SBI', balance: -100, isOverdraft: false, accountTail: null }] },
  });
  const t = exportTable(s);
  assert.deepEqual(t.columns.map((c) => c.kind), ['text', 'amount', 'amount', 'percent']);
  assert.deepEqual(t.rows[0], ['Sales — this period', 480_000, 100_000, 380]);
  assert.deepEqual(t.rows[4], ['Purchases — this period', 875_000, 250_000, 250]);
  const label = (prefix: string) => t.rows.find((r) => String(r[0]).startsWith(prefix));
  assert.deepEqual(label('Gross loss'), ['Gross loss — this period', 395_000, null, null]);
  assert.deepEqual(label('SBI'), ['SBI (overdrawn, Cr)', 100, null, null]);
  assert.deepEqual(label('GST payable'), ['GST payable (estimate) — due 20-Nov-2026', 0, null, null]);
  assert.deepEqual(label('Top customer'), ['Top customer: Bangalore Retail', 250_000, null, 52.08]);
  for (const r of t.rows.slice(8)) if (typeof r[1] === 'number') assert.ok(r[1] >= 0, `${String(r[0])} is negative`);
});

test('summaryInput: balances as on the working date, or the period end when the period ends earlier', () => {
  assert.deepEqual(summaryInput('2026-10-08', '2026-04-01', '2026-10-08'), { asOf: '2026-10-08', from: '2026-04-01', to: '2026-10-08' });
  // Last quarter: the balances the Receivables / Cash-Bank screens show as on 30-Sep.
  assert.deepEqual(summaryInput('2026-10-08', '2026-07-01', '2026-09-30'), { asOf: '2026-09-30', from: '2026-07-01', to: '2026-09-30' });
  // A period running past the working date (the whole year): never future balances.
  assert.deepEqual(summaryInput('2026-10-08', '2026-04-01', '2027-03-31'), { asOf: '2026-10-08', from: '2026-04-01', to: '2027-03-31' });
  // Balance drill-downs end on asOf (the Cash/Bank Books closing = the tile).
  assert.deepEqual(balanceRange(sample()), { from: '2026-04-01', to: '2026-10-08' });
  const future = sample({ asOf: '2026-10-08', ranges: { ...sample().ranges, period: range('2026-11-01', '2026-11-30') } });
  assert.deepEqual(balanceRange(future), { from: '2026-10-01', to: '2026-10-08' }); // never from > to
});

test('homeSummaryInput: Home asks for the 12 months up to its balances date, whatever the period end', () => {
  // The whole year (or this quarter) as the period: the trend would end in March, cutting off last
  // year's months — and in April / May Home would have no graph at all.
  assert.deepEqual(homeSummaryInput('2026-10-08', '2026-04-01', '2027-03-31'), { asOf: '2026-10-08', from: '2026-04-01', to: '2027-03-31', trendTo: '2026-10-08' });
  assert.deepEqual(homeSummaryInput('2027-04-10', '2027-04-01', '2028-03-31'), { asOf: '2027-04-10', from: '2027-04-01', to: '2028-03-31', trendTo: '2027-04-10' });
  // Always up to the balances date — also when the period ends in that month: the running month is drawn only
  // up to it, the "so far" figure its label states (a sale dated after the working date is not in it).
  assert.deepEqual(homeSummaryInput('2026-10-08', '2026-04-01', '2026-10-08'), { ...summaryInput('2026-10-08', '2026-04-01', '2026-10-08'), trendTo: '2026-10-08' });
  assert.deepEqual(homeSummaryInput('2026-10-08', '2026-04-01', '2026-10-31'), { ...summaryInput('2026-10-08', '2026-04-01', '2026-10-31'), trendTo: '2026-10-08' });
  // A past period: balances (and the graph) as on its end.
  assert.deepEqual(homeSummaryInput('2026-10-08', '2026-07-01', '2026-09-30'), { asOf: '2026-09-30', from: '2026-07-01', to: '2026-09-30', trendTo: '2026-09-30' });
});

test('no bare minus on KPI tiles and captions', () => {
  assert.deepEqual(signedKpi('Cash & bank', 123_400, 'Cash & bank (overdrawn)'), { label: 'Cash & bank', value: 123_400 });
  assert.deepEqual(signedKpi('Cash & bank', -123_400, 'Cash & bank (overdrawn)'), { label: 'Cash & bank (overdrawn)', value: 123_400 });
  assert.deepEqual(signedKpi('Receivables', 0, 'Advances from customers'), { label: 'Receivables', value: 0 });
  assert.equal(compactSigned(-150_000, 'overdrawn'), '₹1.5 K overdrawn');
  assert.equal(compactSigned(150_000, 'overdrawn'), '₹1.5 K');
  assert.equal(cashBankCaption(sample().cashBank), 'Cash ₹6.1 K · Bank ₹29.9 K'); // 6,102 · 29,875
  assert.equal(cashBankCaption({ ...sample().cashBank, cashTotal: -5_000, bankTotal: -250_000 }), 'Cash ₹50 negative · Bank ₹2.5 K overdrawn');
  const f = flowKpi({ ...sample().sales, today: -20_000 });
  assert.equal(f.caption, 'Today ₹200 net returns · This month ₹1.3 K');
});

test('flowKpi: a past period end labels "today" and "this month" with the date', () => {
  const k = flowKpi(sample().sales, '2026-09-30', '2026-10-08');
  assert.equal(k.caption, 'On 30-Sep-2026 ₹300 · Sep 2026 to date ₹1.3 K');
  assert.equal(flowKpi(sample().sales, '2026-10-08', '2026-10-08').caption, 'Today ₹300 · This month ₹1.3 K');
});

test("GST: last month's return comes first on the card and in the alerts", () => {
  const due = { ...sample().gst!, period: '092026', label: 'Sep 2026', from: '2026-09-01', to: '2026-09-30', dueDate: '2026-10-20', outputTax: 45_000, inputTax: 0, netPayable: 45_000, creditCarriedForward: 0, documentCount: 1 };
  const s = sample({ gstDue: due, gst: { ...sample().gst!, netPayable: 10_000 } });
  const a = buildAlerts(s).find((x) => x.id === 'gst-due');
  assert.equal(a?.title, 'GST of ₹450 for Sep 2026 · due in 12 days');
  assert.equal(a?.tone, 'info'); // 12 days ahead
  assert.equal(a?.body, 'Estimated cash payment after input credit. GSTR-3B is due by 20-Oct-2026 (due in 12 days).');
  assert.deepEqual(a?.target, { screen: 'gst.gstr3b', params: { period: '092026' } });
  assert.equal(gstDueLine(due, '2026-10-08'), 'GSTR-3B due by 20-Oct-2026 (due in 12 days)');
  assert.equal(gstDueLine(due, '2026-10-20'), 'GSTR-3B due by 20-Oct-2026 (due today)');
  assert.deepEqual(gstItems(due).map((i) => [i.key, i.label, i.value]), [
    ['out', 'Tax on sales', 45_000],
    ['in', 'Input tax credit', 0],
    ['pay', 'To pay in cash', 45_000],
  ]);
  // Current month: credit left, nothing to pay.
  assert.deepEqual(gstItems(sample().gst!).map((i) => [i.label, i.value]), [
    ['Tax on sales', 7_800],
    ['Input tax credit', 54_000],
    ['Nothing to pay in cash', 0],
    ['Credit carried forward', 46_200],
  ]);
  // Last month settled from credit: the current month's payable is the alert.
  const settled = buildAlerts(sample({ gstDue: { ...due, netPayable: 0 }, gst: { ...sample().gst!, netPayable: 10_000 } })).find((x) => x.id === 'gst-due');
  assert.equal(settled?.title, 'GST of ₹100 for Oct 2026 · due in 43 days');
  // Export lists both months.
  const rows = exportTable(s).rows.map((r) => String(r[0]));
  assert.ok(rows.includes('GST payable — Sep 2026 — due 20-Oct-2026'));
  assert.ok(rows.includes('GST payable (estimate) — due 20-Nov-2026'));
});

const ALL = { manageCompany: true, createMasters: true, createVouchers: true, importData: true, inventory: true } as const;
const NOTHING_DONE = { profileComplete: false, featuresReviewed: false, invoicePrintingSet: false, hasOwnLedgers: false, hasItems: false, hasSales: false, backupFolderSet: false, numberingSet: false, hasReceipts: false };

test('getting started: one list — company details, features, number series, printing, ledgers, items, sale, payment, backups (+ XML data import while empty)', () => {
  const all = startSteps({ ...ALL, setup: NOTHING_DONE, hasVouchers: false });
  assert.deepEqual(all.map((x) => x.id), ['profile', 'features', 'numbering', 'printing', 'ledgers', 'items', 'sale', 'payment', 'backup', 'xmlImport']);
  const by = new Map(all.map((x) => [x.id, x]));
  assert.deepEqual(by.get('profile')?.target, { screen: 'company.profile' });
  assert.deepEqual(by.get('features')?.target, { screen: 'company.features' });
  assert.deepEqual(by.get('printing')?.target, { screen: 'print.settings' });
  assert.equal(by.get('printing')?.title, 'Choose what prints on your invoice');
  // 2.0: the invoice number series (Invoice Numbering screen) and the first payment received (F6 Receipt).
  assert.deepEqual(by.get('numbering')?.target, { screen: 'accounts.numbering' });
  assert.equal(by.get('numbering')?.title, 'Set your invoice number series');
  assert.equal(by.get('payment')?.target, 'receipt-voucher');
  assert.equal(by.get('payment')?.shortcut, 'F6');
  assert.equal(by.get('payment')?.title, 'Record a payment');
  // "Create ledger" opens Ledger Creation under Sundry Debtors (customers first; "Under" stays editable).
  assert.deepEqual(by.get('ledgers')?.target, { screen: 'accounts.ledger.form', params: { groupCode: 'SUNDRY_DEBTORS' } });
  assert.deepEqual(by.get('backup')?.target, { screen: 'company.config', params: { tab: 'backup' } });
  assert.equal(by.get('sale')?.target, 'sales-voucher');
  assert.equal(by.get('sale')?.shortcut, 'F8');
  assert.deepEqual(by.get('xmlImport')?.target, { screen: 'data.xmlImport' });
  assert.equal(by.get('xmlImport')?.optional, true);
  assert.ok(all.every((x) => !x.done));
  assert.deepEqual(startProgress(all), { done: 0, total: 9, complete: false }, 'XML data import is optional, not counted');
  // Once there are vouchers the XML data import step goes; the rest stay until done.
  assert.ok(!startSteps({ ...ALL, setup: NOTHING_DONE, hasVouchers: true }).some((x) => x.id === 'xmlImport'));
});

test('getting started: by permission and by what the user may open', () => {
  assert.deepEqual(startSteps({ ...ALL, manageCompany: false, importData: false, inventory: false }).map((x) => x.id), ['ledgers', 'sale', 'payment']);
  assert.deepEqual(startSteps({ manageCompany: false, createMasters: false, createVouchers: false, importData: false, inventory: true }), []);
  // A screen the user cannot open (no permission / feature off) is left out.
  const blocked = new Set(['print.settings', 'data.xmlImport']);
  assert.deepEqual(startSteps({ ...ALL, canOpen: (id) => !blocked.has(id) }).map((x) => x.id), ['profile', 'features', 'numbering', 'ledgers', 'items', 'sale', 'payment', 'backup']);
  // The Invoice Numbering screen not registered (or not allowed): its step is left out, nothing else.
  assert.deepEqual(
    startSteps({ ...ALL, canOpen: (id) => id !== 'accounts.numbering' }).map((x) => x.id),
    ['profile', 'features', 'printing', 'ledgers', 'items', 'sale', 'payment', 'backup', 'xmlImport'],
  );
});

test('getting started: done from the books, or ticked by hand — never by clicking the step', () => {
  const setup = { ...NOTHING_DONE, profileComplete: true, hasOwnLedgers: true, hasSales: true };
  const steps = startSteps({ ...ALL, setup, hasVouchers: true, ticked: ['features', 'nonsense'] });
  const done = steps.filter((x) => x.done).map((x) => x.id);
  assert.deepEqual(done, ['profile', 'features', 'ledgers', 'sale']);
  assert.equal(steps.find((x) => x.id === 'features')?.doneFromBooks, false);
  assert.equal(steps.find((x) => x.id === 'profile')?.doneFromBooks, true);
  assert.deepEqual(startProgress(steps), { done: 4, total: 9, complete: false });
  // 2.0 steps are done from the books too (a changed Sales series, a receipt).
  const more = startSteps({ ...ALL, setup: { ...NOTHING_DONE, numberingSet: true, hasReceipts: true }, hasVouchers: true });
  assert.deepEqual(more.filter((x) => x.doneFromBooks).map((x) => x.id), ['numbering', 'payment']);
  // While the summary loads nothing is done (no flash of "done").
  assert.ok(startSteps({ ...ALL, ticked: [] }).every((x) => !x.done));
});

test('getting started card: stays after the first voucher until all done or hidden', () => {
  const some = startSteps({ ...ALL, setup: { ...NOTHING_DONE, hasSales: true }, hasVouchers: true });
  assert.equal(startCardMode(some, { hidden: false, hasVouchers: true }), 'steps', 'regression: it vanished at the first voucher');
  assert.equal(startCardMode(some, { hidden: true, hasVouchers: true }), null);
  const allDone = startSteps({ ...ALL, setup: { profileComplete: true, featuresReviewed: true, invoicePrintingSet: true, hasOwnLedgers: true, hasItems: true, hasSales: true, backupFolderSet: true, numberingSet: true, hasReceipts: true }, hasVouchers: true });
  assert.equal(startCardMode(allDone, { hidden: false, hasVouchers: true }), null);
  // Nothing the user can do: an empty note while the books are empty, nothing afterwards.
  assert.equal(startCardMode([], { hidden: false, hasVouchers: false }), 'empty');
  assert.equal(startCardMode([], { hidden: false, hasVouchers: true }), null);
  // Only the optional XML data import step: shown while the books are empty.
  const xmlOnly = startSteps({ manageCompany: false, createMasters: false, createVouchers: false, importData: true, inventory: false, hasVouchers: false });
  assert.equal(startCardMode(xmlOnly, { hidden: false, hasVouchers: false }), 'steps');
});

test('getting started prefs: per company, tolerant of junk', () => {
  assert.deepEqual(parseStartPrefs(null), { hidden: false, ticked: [] });
  assert.deepEqual(parseStartPrefs('{not json'), { hidden: false, ticked: [] });
  assert.deepEqual(parseStartPrefs('{"hidden":true,"ticked":["features",3]}'), { hidden: true, ticked: ['features'] });
  const p = toggleTicked({ hidden: false, ticked: ['features'] }, 'printing', true);
  assert.deepEqual(p.ticked, ['features', 'printing']);
  assert.deepEqual(toggleTicked(p, 'features', false).ticked, ['printing']);
});

test('alerts respect what the viewer may open (backup alert for a role without Backup)', () => {
  const noBackup = buildAlerts(sample(), { canOpen: (id) => id !== 'data.backup' });
  const backup = noBackup.find((a) => a.id === 'backup');
  assert.equal(backup?.target, null, 'not clickable');
  assert.equal(backup?.body, 'Ask the company owner to take a backup and keep a copy on another drive or a pen drive.');
  assert.deepEqual(noBackup.find((a) => a.id === 'low-stock')?.target, { screen: 'stock.reorder' });
  const stale = buildAlerts(sample({ backup: { lastBackupAt: '2026-09-28T04:30:00.000Z', daysSince: 10 } }), { canOpen: (id) => id !== 'data.backup' }).find((a) => a.id === 'backup');
  assert.equal(stale?.body, 'Ask the company owner to back up — at least once a week.');
  // Any other screen the viewer cannot open: the alert stays, without a target.
  const noStock = buildAlerts(sample(), { canOpen: (id) => id !== 'stock.reorder' });
  assert.equal(noStock.find((a) => a.id === 'low-stock')?.target, null);
  assert.equal(noStock.find((a) => a.id === 'backup')?.body, 'Take a backup now and keep a copy on another drive or a pen drive.');
});

test('exportTable: net advances are labelled, not negative', () => {
  const s = sample({ receivables: { ...sample().receivables, total: -10_000 }, payables: { ...sample().payables, total: -2_000 } });
  const t = exportTable(s);
  assert.ok(t.rows.some((r) => r[0] === 'Receivables (net advance from customers)' && r[1] === 10_000));
  assert.ok(t.rows.some((r) => r[0] === 'Payables (net advance to suppliers)' && r[1] === 2_000));
  for (const r of t.rows.slice(8)) if (typeof r[1] === 'number') assert.ok(r[1] >= 0, `${String(r[0])} is negative`);
});

test('"Show Get started" undoes Hide — offered only while hidden and the card would show', async () => {
  const some = startSteps({ ...ALL, setup: { ...NOTHING_DONE, hasSales: true }, hasVouchers: true });
  assert.equal(canShowStartCard(some, { hidden: true, hasVouchers: true }), true);
  assert.equal(canShowStartCard(some, { hidden: false, hasVouchers: true }), false, 'already showing');
  const allDone = startSteps({ ...ALL, setup: { profileComplete: true, featuresReviewed: true, invoicePrintingSet: true, hasOwnLedgers: true, hasItems: true, hasSales: true, backupFolderSet: true, numberingSet: true, hasReceipts: true }, hasVouchers: true });
  assert.equal(canShowStartCard(allDone, { hidden: true, hasVouchers: true }), false, 'nothing would show');
  // Wired on the full dashboard (Alt+S, kept registered while offered); Home's Setup line hides with ×.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../DashboardScreen.tsx', import.meta.url), 'utf8');
  // (V6) It brings back what Home and the Dashboard now call "Setup" — the same word (2.0: "Show Get started").
  assert.match(src, /key: 'Alt\+S', label: 'Show setup', icon: 'eye', onClick: start\.show, hidden: !start\.canShow/);
  const parts = fs.readFileSync(new URL('../components.tsx', import.meta.url), 'utf8');
  assert.match(parts, /aria-label="Hide setup" onClick=\{hide\}/);
});

test('Home figures (2.1): To collect, To pay, Cash & bank — each drills; captions only when they ask for action', () => {
  const s = sample();
  const figures = homeFigures(s);
  assert.deepEqual(figures.map((f) => f.label), ['To collect', 'To pay', 'Cash & bank'], 'three figures — "Sales this month" is the graph\'s header now');
  const [collect, pay, money] = figures;
  assert.equal(collect.value, 500_800);
  assert.equal(collect.caption, '₹3.4 K overdue');
  assert.equal(collect.tooltip, '₹3.4 K overdue from 2 customers · ₹1.6 K not yet due');
  assert.deepEqual(collect.target, { screen: 'outstanding.receivables' });
  assert.deepEqual(collect.covers, ['receivables-overdue']);
  assert.equal(pay.value, 667_500);
  assert.equal(pay.caption, '₹2.3 K overdue');
  assert.equal(pay.tooltip, '₹885 due in 7 days');
  assert.deepEqual(pay.target, { screen: 'outstanding.payables' });
  assert.equal(money.value, s.cashBank.cashTotal + s.cashBank.bankTotal);
  assert.equal(money.caption, null, 'nothing to act on: no caption');
  assert.equal(money.tooltip, cashBankCaption(s.cashBank), 'the cash / bank split moves to the tooltip');
  assert.deepEqual(money.target, DRILL.cashBank(balanceRange(s)));
  for (const f of figures) assert.ok(f.value >= 0, `${f.label} is never negative`);
});

test('Home figures: the To collect caption reconciles when more is overdue than is owed (advances, on account)', () => {
  const base = sample();
  // Bills 9,66,000 overdue 4,65,953; advances and on-account receipts 3,66,000 not matched → net 99,953.
  const s = sample({ receivables: { ...base.receivables, total: 9_995_300, overdue: 46_595_300, notDue: 0, advance: -30_000_000, onAccount: -6_600_000 } });
  const [collect] = homeFigures(s);
  assert.equal(collect.value, 9_995_300, 'To collect = net outstanding (bills + advances + on account)');
  // The words of Receivables' answer line (outstanding/lib/charts.ts): "not matched to bills".
  assert.equal(collect.caption, '₹4.66 L overdue · ₹3.66 L not matched to bills');
  // Overdue within what is owed: the plain caption — also with some advances not matched.
  assert.equal(homeFigures(sample())[0].caption, '₹3.4 K overdue');
  assert.equal(homeFigures(sample({ receivables: { ...base.receivables, advance: -10_000 } }))[0].caption, '₹3.4 K overdue');
});

test('Home figures: a caption keeps to one line at 1366 px — tracks sized to their content, empty ones collapsed (§1.3)', () => {
  const css = readFileSync(fileURLToPath(new URL('../dashboard.css', import.meta.url)), 'utf8');
  const rule = /\.bx-db__figures \{([^}]*)\}/.exec(css)?.[1] ?? '';
  // Five equal 1fr tracks (auto-fill) gave each figure ~189 px at 1366 px and wrapped the To collect caption.
  const m = /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\((\d+)px,\s*max-content\)\)/.exec(rule);
  assert.ok(m, `content-sized figure tracks: ${rule.trim()}`);
  assert.match(rule, /gap:\s*var\(--space-6\)/);
  const min = Number(m[1]);
  const gap = 24; // --space-6
  // The panel beside the Home menu (280 px), less its padding (24 px each side).
  const panel = (width: number) => width - 280 - 2 * 24;
  assert.ok(3 * min + 2 * gap <= panel(1024), 'the three figures stay on one row down to the smallest window (1024 px)');
  // At 1366 px the To collect figure grows to its longest caption (12 px type, ≤ 6.5 px a character) beside the other two.
  const base = sample();
  const longest = homeFigures(sample({ receivables: { ...base.receivables, total: 9_995_300, overdue: 46_595_300, notDue: 0, advance: -30_000_000, onAccount: -6_600_000 } }))[0].caption ?? '';
  assert.equal(longest, '₹4.66 L overdue · ₹3.66 L not matched to bills');
  assert.ok(longest.length * 6.5 <= panel(1366) - 2 * (min + gap), `${longest.length * 6.5} px does not fit`);
});

test('Home figures: negatives are relabelled; negative cash or an overdrawn bank is the one caption', () => {
  const base = sample();
  const s = sample({
    receivables: { ...base.receivables, total: -5_000, overdue: 0 },
    payables: { ...base.payables, total: -1_000, overdue: 0, dueSoon: { ...base.payables.dueSoon, count: 0, amount: 0 } },
    cashBank: { ...base.cashBank, cashTotal: -2_000, bankTotal: 0 },
  });
  const [collect, pay, money] = homeFigures(s);
  assert.deepEqual([collect.label, collect.value, collect.caption, collect.tooltip], ['Advances from customers', 5_000, null, 'Nothing overdue · 3 customers']);
  assert.deepEqual([pay.label, pay.value, pay.caption, pay.tooltip], ['Advances to suppliers', 1_000, null, 'Nothing due in 7 days']);
  assert.deepEqual([money.label, money.value, money.caption, money.covers], ['Cash & bank (overdrawn)', 2_000, 'Cash in hand is negative', ['cash-negative']]);
  const od = sample({ cashBank: { ...base.cashBank, banks: [{ ledgerId: 27, name: 'HDFC Bank', balance: -50_000, isOverdraft: false, accountTail: null }], bankTotal: -50_000 } });
  assert.deepEqual([homeFigures(od)[2].caption, homeFigures(od)[2].covers], ['HDFC Bank overdrawn', ['bank-overdrawn-27']]);
  // An OD / cash-credit account drawn is not "overdrawn".
  const cc = sample({ cashBank: { ...base.cashBank, banks: [{ ledgerId: 28, name: 'SBI CC', balance: -50_000, isOverdraft: true, accountTail: null }], bankTotal: -50_000 } });
  assert.equal(homeFigures(cc)[2].caption, null);
});

test('Home alerts: never repeat a figure\'s caption or the Setup line (D10)', () => {
  const s = sample({ cashBank: { ...sample().cashBank, cashTotal: -2_000 } });
  const all = buildAlerts(s).map((a) => a.id);
  assert.ok(['receivables-overdue', 'payables-overdue', 'cash-negative', 'backup'].every((id) => all.includes(id)));
  const home = homeAlerts(s).map((a) => a.id);
  assert.ok(!home.includes('receivables-overdue') && !home.includes('payables-overdue') && !home.includes('cash-negative'));
  assert.ok(home.includes('backup'), 'Setup not showing: the backup alert stays');
  assert.ok(!homeAlerts(s, { setupBackupOpen: true }).some((a) => a.id === 'backup'), 'the Setup line says it');
  assert.deepEqual(home, all.filter((id) => !['receivables-overdue', 'payables-overdue', 'cash-negative'].includes(id)), 'order kept');
  // Nothing overdue: no caption, so the alert (if any) is not dropped.
  const quiet = sample({ receivables: { ...sample().receivables, overdue: 0 } });
  assert.deepEqual(homeAlerts(quiet).filter((a) => a.id === 'receivables-overdue'), []);
  // An overdrawn bank named in the caption is not listed again.
  const od = sample({ cashBank: { ...sample().cashBank, banks: [{ ledgerId: 27, name: 'HDFC Bank', balance: -50_000, isOverdraft: false, accountTail: null }] } });
  assert.ok(buildAlerts(od).some((a) => a.id === 'bank-overdrawn-27'));
  assert.ok(!homeAlerts(od).some((a) => a.id === 'bank-overdrawn-27'));
  assert.equal(HOME_ALERTS_SHOWN, 3);
});

test('Home graph: months from the books-beginning month to the working-date month, emphasis on that month', () => {
  // Books begin Apr 2025, asOf 8-Oct-2026: the trend's twelve months (Nov 25 … Oct 26), Oct emphasised.
  const s = sample();
  const g = homeSalesGraph(s);
  assert.ok(g);
  assert.equal(g.title, HOME_GRAPH_TITLE);
  assert.equal(HOME_GRAPH_TITLE, 'Sales — last 12 months');
  assert.equal(g.months.length, 12);
  assert.deepEqual([g.months[0], g.months[11]], ['Nov', 'Oct']);
  assert.deepEqual(g.values, s.trend.map((t) => t.sales), 'drawn values are trend[i].sales');
  assert.equal(g.total, s.trend.reduce((t, m) => t + m.sales, 0));
  assert.equal(g.emphasis, 11);
  assert.equal(g.label, '₹1.3 K so far', 'the label is sales.mtd');
  assert.equal(g.takeaway, '₹1.3 K so far in Oct · ▲ 30 % vs 1–8 Oct 2025');
  // Books beginning in Jun 2026: Jun … Oct only.
  const young = homeSalesGraph(sample({ booksFrom: '2026-06-01' }));
  assert.deepEqual(young?.months, ['Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
  assert.equal(young?.emphasis, 4);
  // Fewer than three months: no graph (and so no Ctrl+J on Home).
  assert.equal(homeSalesGraph(sample({ booksFrom: '2026-09-01' })), null);
  assert.ok(homeSalesGraph(sample({ booksFrom: '2026-08-15' })), 'three months: a graph');
  // The working-date month absent from the series: nothing emphasised, no label.
  const shifted = homeSalesGraph(sample({ asOf: '2026-11-03', trend: sample().trend }));
  assert.equal(shifted?.emphasis, null);
  assert.equal(shifted?.label, '');
});

test('Home graph: the comparison names the same day range a year earlier', () => {
  const base = sample();
  const none = homeSalesGraph(sample({ sales: { ...base.sales, lastYear: { ...base.sales.lastYear, mtd: 0 } } }));
  assert.equal(none?.takeaway, '₹1.3 K so far in Oct · 1–8 Oct 2025: nothing');
  // A first-year company (books from 1-Apr-26): there are no books for 1–8 Oct 2025 to compare with, so the
  // header says nothing about them — never "1–8 Oct 2025: nothing", which reads as no sales last year.
  const first = homeSalesGraph(sample({ booksFrom: '2026-04-01', sales: { ...base.sales, lastYear: { ...base.sales.lastYear, mtd: 0 } } }));
  assert.equal(first?.takeaway, '₹1.3 K so far in Oct');
  const down = homeSalesGraph(sample({ sales: { ...base.sales, mtd: 50_000 } }));
  assert.equal(down?.takeaway, '₹500 so far in Oct · ▼ 50 % vs 1–8 Oct 2025');
  const same = homeSalesGraph(sample({ sales: { ...base.sales, mtd: 100_000 } }));
  assert.equal(same?.takeaway, '₹1.0 K so far in Oct · same as 1–8 Oct 2025');
  const oneDay = homeSalesGraph(sample({ ranges: { ...base.ranges, lastYear: { ...base.ranges.lastYear, mtd: { from: '2025-10-01', to: '2025-10-01' } } } }));
  assert.match(oneDay?.takeaway ?? '', /vs 1 Oct 2025$/);
  // A finished month (balances as on a month end) is not "so far".
  const ended = homeSalesGraph(sample({ asOf: '2026-10-31' }));
  assert.equal(ended?.label, '₹1.3 K');
  assert.equal(ended?.takeaway, '₹1.3 K in Oct · ▲ 30 % vs 1–8 Oct 2025');
  // Net returns are words, never a bare minus.
  assert.equal(homeSalesGraph(sample({ sales: { ...base.sales, mtd: -700 } }))?.label, '₹7 net returns so far');
});

test('Home graph (V6): nothing sold yet draws no graph', () => {
  // A fresh install in October: the books begin on 1-Apr, seven months, not one sale — an empty plot
  // with "₹0 so far" answers nothing (and Ctrl+J has nothing to fold): no graph, as for every report.
  const empty = sample().trend.map((t) => ({ ...t, sales: 0 }));
  assert.equal(homeSalesGraph(sample({ booksFrom: '2026-04-01', trend: empty, sales: { ...sample().sales, mtd: 0, lastYear: { ...sample().sales.lastYear, mtd: 0 } } })), null);
  // Returns only (net negative) are still something to show.
  assert.ok(homeSalesGraph(sample({ trend: empty.map((t, i) => (i === 11 ? { ...t, sales: -700 } : t)) })));
});

test('Home graph drill: the Sales Accounts monthly summary of the column\'s financial year, that month active', () => {
  assert.deepEqual(homeSalesDrill('2026-09', '2025-04-01', 41), { screen: 'reports.monthlySummary', params: { groupId: 41, from: '2026-04-01', to: '2027-03-31', month: '2026-09' } });
  assert.deepEqual(homeSalesDrill('2026-02', '2025-04-01', 41), { screen: 'reports.monthlySummary', params: { groupId: 41, from: '2025-04-01', to: '2026-03-31', month: '2026-02' } });
  // Never before the books begin; a January financial year.
  assert.deepEqual(homeSalesDrill('2026-09', '2026-06-15', 41).params, { groupId: 41, from: '2026-06-15', to: '2027-03-31', month: '2026-09' });
  assert.deepEqual(homeSalesDrill('2026-09', '2020-01-01', 41, 1).params, { groupId: 41, from: '2026-01-01', to: '2026-12-31', month: '2026-09' });
  // With Home's balances date: a column of its financial year opens the summary up to that date (the running
  // month's row then shows the "so far" figure its column draws); an earlier year's column is unchanged.
  assert.deepEqual(homeSalesDrill('2026-10', '2025-04-01', 41, 4, '2026-10-05').params, { groupId: 41, from: '2026-04-01', to: '2026-10-05', month: '2026-10' });
  assert.deepEqual(homeSalesDrill('2026-09', '2025-04-01', 41, 4, '2026-10-05').params, { groupId: 41, from: '2026-04-01', to: '2026-10-05', month: '2026-09' });
  assert.deepEqual(homeSalesDrill('2026-02', '2025-04-01', 41, 4, '2026-10-05').params, { groupId: 41, from: '2025-04-01', to: '2026-03-31', month: '2026-02' });
});

test('Home graph (seeded books, working date set back to 5-Oct with sales entered up to 11-Oct): the running column, its label and the takeaway say the same "so far" figure', () => {
  // dashboard.summary with Home's trendTo: October is cut at the balances date, so trend[last].sales = sales.mtd.
  const s = sample({ asOf: '2026-10-05', sales: { ...sample().sales, mtd: 2_360_000 } });
  const trend = s.trend.map((t) => (t.month === '2026-10' ? { ...t, to: '2026-10-05', sales: 2_360_000 } : t));
  const g = homeSalesGraph({ ...s, trend });
  assert.ok(g && g.emphasis !== null);
  assert.equal(g.values[g.emphasis], s.sales.mtd);
  assert.match(g.label, /^₹23\.6 K so far$/);
  assert.match(g.takeaway, /^₹23\.6 K so far in Oct/);
});

test('Setup line (D11): "Setup 4 of 9 · Next: …"; the backup step open keeps the backup alert off Home', () => {
  const steps = startSteps({ ...ALL, setup: { ...NOTHING_DONE, profileComplete: true, featuresReviewed: true, numberingSet: true, hasOwnLedgers: true }, hasVouchers: true });
  const line = setupLine(steps);
  assert.deepEqual([line.done, line.total], [4, 9]);
  assert.equal(line.next?.title, 'Choose what prints on your invoice');
  assert.equal(line.backupOpen, true);
  const backedUp = setupLine(startSteps({ ...ALL, setup: { ...NOTHING_DONE, backupFolderSet: true }, hasVouchers: true }));
  assert.equal(backedUp.backupOpen, false);
  // Only the optional XML import left: it is the next step.
  const xmlOnly = startSteps({ manageCompany: false, createMasters: false, createVouchers: false, importData: true, inventory: false, hasVouchers: false });
  assert.equal(setupLine(xmlOnly).next?.id, 'xmlImport');
  assert.deepEqual(HOME_PANEL, ['period', 'figures', 'graph', 'attention', 'setup', 'fullDashboard'], 'top to bottom (D10)');
  assert.equal(isVoucherTarget('receipt-voucher'), true);
  assert.equal(isVoucherTarget({ screen: 'print.settings' }), false);
});

test('Full Dashboard: the other cards as one line each, each with its link', () => {
  const s = sample({ gstDue: { ...sample().gst!, period: '092026', label: 'Sep 2026', netPayable: 1_333_440, dueDate: '2026-10-20' }, recentVouchers: [{ id: 9, date: '2026-10-08', number: '33', typeName: 'Sales', baseType: 'sales', partyName: 'Asha Retail', amount: 118_000, isCancelled: false, isOptional: false, isPostDated: false }] });
  const lines = cardLines(s);
  assert.deepEqual(lines.map((l) => l.id), ['cashBank', 'gst', 'topCustomer', 'topItem', 'lowStock', 'postDated', 'recent']);
  const by = new Map(lines.map((l) => [l.id, l]));
  assert.equal(by.get('cashBank')?.text, 'Cash ₹6.1 K · Bank ₹29.9 K');
  assert.equal(by.get('gst')?.text, 'Sep 2026: ₹13.3 K to pay in cash · GSTR-3B due by 20-Oct-2026 (due in 12 days)');
  assert.deepEqual(by.get('gst')?.target, DRILL.gstr3b('092026'));
  assert.equal(by.get('topCustomer')?.text, 'Bangalore Retail ₹2.5 K · 52 % of sales');
  assert.equal(by.get('lowStock')?.text, '2 items below the reorder level');
  assert.equal(by.get('postDated')?.text, 'To receive ₹444 · to pay ₹2.3 K');
  assert.equal(by.get('recent')?.text, 'Sales 33 · Asha Retail · ₹ 1,180.00');
  assert.deepEqual(by.get('recent')?.target, DRILL.dayBook({ from: '2026-10-08', to: '2026-10-08' }));
  const older = cardLines(sample({ recentVouchers: [{ id: 3, date: '2026-09-02', number: '7', typeName: 'Receipt', baseType: 'receipt', partyName: null, amount: 5_000, isCancelled: false, isOptional: false, isPostDated: false }] }));
  assert.deepEqual(older.find((l) => l.id === 'recent')?.target, DRILL.dayBook({ from: '2026-09-02', to: '2026-09-02' }), "the Day Book of the voucher's date, not today's");
  for (const l of lines) assert.ok(l.link.length > 0 && l.target.screen.length > 0, l.id);
  // Inventory off: no item lines; nothing post-dated, no vouchers: no line for them.
  const plain = cardLines(sample({ features: { ...sample().features, inventory: false }, postDated: { count: 0, inflow: 0, outflow: 0, rows: [] } }));
  assert.deepEqual(plain.map((l) => l.id), ['cashBank', 'gst', 'topCustomer']);
});

test('wiring: Home renders the 2.1 panel; the full Dashboard keeps every card behind "Show all cards"', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../DashboardScreen.tsx', import.meta.url), 'utf8');
  const home = src.slice(src.indexOf('function HomePanel('), src.indexOf('function FullDashboard('));
  for (const part of ['<HomeFigures ', '<HomeGraph ', '<HomeAlerts ', '<SetupLine ', 'Full dashboard', 'period.openDialog']) assert.ok(home.includes(part), `Home renders ${part}`);
  // …in the order of HOME_PANEL (D10): period · figures · graph · attention · Setup · Full dashboard.
  const at = ['period.openDialog', '<HomeFigures ', '<HomeGraph ', '<HomeAlerts ', '<SetupLine ', '>\n          Full dashboard'].map((p) => home.indexOf(p));
  assert.equal(at.length, HOME_PANEL.length);
  assert.deepEqual([...at].sort((x, y) => x - y), at, `Home panel order ${at.join(' < ')}`);
  assert.ok(at.every((i) => i >= 0));
  for (const gone of ['Show more insights', 'Change period', 'Refresh dashboard', 'Show Get started', 'Show setup', 'RecentVouchersCard']) assert.ok(!home.includes(gone), `Home no longer renders ${gone}`);
  const full = src.slice(src.indexOf('function FullDashboard('));
  for (const card of ['KpiRow', 'TrendCard', 'AlertsCard', 'AgeingCard', 'CashBankCard', 'GstCard', 'TopCustomersCard', 'TopItemsCard', 'LowStockCard', 'PostDatedCard', 'ModuleCards', 'RecentVouchersCard', 'CardLines', 'SetupLine']) {
    assert.ok(full.includes(`<${card} `) || full.includes(`<${card} />`), `full dashboard renders ${card}`);
  }
  assert.match(full, /setUiPrefs\(\{ dashboardAllCards: !allCards \}\)/, '"Show all cards" is remembered (pevqori.ui)');
  // Graph code: MiniColumns (by path) on Home, everything else only through LazyChart; never Chart.tsx.
  const parts = fs.readFileSync(new URL('../components.tsx', import.meta.url), 'utf8');
  assert.match(parts, /from '\.\.\/\.\.\/ui\/MiniColumns\.tsx'/);
  assert.match(parts, /from '\.\.\/\.\.\/ui\/lazyChart\.tsx'/);
  assert.ok(!/Chart\.tsx'/.test(parts.replace(/lazyChart\.tsx'/g, '')), 'no static import of the graph kit');
  // Ctrl+J comes from useGraphsToggle only (no key literal in the module).
  assert.ok(!/Ctrl\+J'/.test(parts) && !/Ctrl\+J'/.test(src));
  assert.match(parts, /useScreenActions\(g && toggle\.action \? \[toggle\.action\] : NO_ACTIONS\)/, 'Home registers Ctrl+J only while its graph exists');
  // The full Dashboard: Ctrl+J only while one of its graphs exists; folding keeps the focus (useGraphFold).
  assert.match(full, /\.\.\.\(hasGraph && graphs\.action \? \[graphs\.action\] : \[\]\)/);
  assert.match(full, /ref=\{fold\.toggleRef\}/);
  assert.match(full, /aria-live="polite"/);
  assert.ok(enoughData(trendSpec(sample().trend)!));
});

test("Home's graph is described by the strip's takeaway (SPEC-21 §4.4: aria-describedby on every interactive graph)", async () => {
  const fs = await import('node:fs');
  const parts = fs.readFileSync(new URL('../components.tsx', import.meta.url), 'utf8');
  assert.match(parts, /render: \(\{ describedBy \}\) => <MiniColumns [^>]*describedBy=\{describedBy\}/);
});
