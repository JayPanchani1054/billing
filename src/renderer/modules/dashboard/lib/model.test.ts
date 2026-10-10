import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DashboardAgeingBucket, DashboardSummary } from '../../../../shared/types/dashboard.ts';
import {
  ageingBars,
  balanceRange,
  buildAlerts,
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
  plural,
  shortMonth,
  parseStartPrefs,
  signedKpi,
  startCardMode,
  canShowStartCard,
  startProgress,
  startSteps,
  toggleTicked,
  summaryInput,
  trendChart,
} from './model.ts';

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
    setup: { profileComplete: true, featuresReviewed: true, invoicePrintingSet: true, hasOwnLedgers: true, hasItems: true, hasSales: true, backupFolderSet: true },
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

test('trendChart: fixed series slots, month labels, accessible takeaway', () => {
  const c = trendChart(sample().trend);
  assert.equal(c.categories.length, 12);
  assert.equal(c.categories[0], 'Nov 25');
  assert.equal(c.categories[11], 'Oct 26');
  assert.deepEqual(c.series.map((s) => [s.name, s.slot]), [['Sales', 1], ['Purchases', 2]]);
  assert.equal(c.series[0].values[10], 250_000);
  assert.equal(c.empty, false);
  assert.equal(c.description, 'Sales peaked in Sep 2026 at ₹ 2,500.00. 12-month sales ₹4.8 K, purchases ₹8.8 K.');
  const none = trendChart(sample().trend.map((m) => ({ ...m, sales: 0, purchases: 0 })));
  assert.equal(none.empty, true);
  assert.equal(none.description, 'No sales or purchases in the last 12 months.');
});

test('ageingBars: lengths relative to the largest bucket, credits drawn as 0, overdue flag', () => {
  const bars = ageingBars(buckets([161_400, 295_000, 0, -1_000, 44_400, 0]));
  assert.deepEqual(bars.map((b) => b.percent), [54.7, 100, 0, 0, 15.1, 0]); // 161,400 ÷ 295,000 = 54.7%; 44,400 ÷ 295,000 = 15.1%
  assert.deepEqual(bars.map((b) => b.overdue), [false, true, true, true, true, true]);
  assert.equal(bars[3].amount, -1_000);
  assert.deepEqual(ageingBars(buckets([0, 0])).map((b) => b.percent), [0, 0, 0, 0, 0, 0]);
  // A tiny bucket still shows a sliver.
  assert.equal(ageingBars(buckets([1, 10_000_000]))[0].percent, 1);
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
  assert.equal(byId.get('gst-due')?.title, 'GST of ₹438 for Oct 2026');
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
  assert.equal(a?.title, 'GST of ₹450 for Sep 2026');
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
  assert.equal(settled?.title, 'GST of ₹100 for Oct 2026');
  // Export lists both months.
  const rows = exportTable(s).rows.map((r) => String(r[0]));
  assert.ok(rows.includes('GST payable — Sep 2026 — due 20-Oct-2026'));
  assert.ok(rows.includes('GST payable (estimate) — due 20-Nov-2026'));
});

const ALL = { manageCompany: true, createMasters: true, createVouchers: true, importData: true, inventory: true } as const;
const NOTHING_DONE = { profileComplete: false, featuresReviewed: false, invoicePrintingSet: false, hasOwnLedgers: false, hasItems: false, hasSales: false, backupFolderSet: false };

test('getting started: one list — company details, features, printing, ledgers, items, sale, backups (+ XML data import while empty)', () => {
  const all = startSteps({ ...ALL, setup: NOTHING_DONE, hasVouchers: false });
  assert.deepEqual(all.map((x) => x.id), ['profile', 'features', 'printing', 'ledgers', 'items', 'sale', 'backup', 'xmlImport']);
  const by = new Map(all.map((x) => [x.id, x]));
  assert.deepEqual(by.get('profile')?.target, { screen: 'company.profile' });
  assert.deepEqual(by.get('features')?.target, { screen: 'company.features' });
  assert.deepEqual(by.get('printing')?.target, { screen: 'print.settings' });
  // "Create ledger" opens Ledger Creation under Sundry Debtors (customers first; "Under" stays editable).
  assert.deepEqual(by.get('ledgers')?.target, { screen: 'accounts.ledger.form', params: { groupCode: 'SUNDRY_DEBTORS' } });
  assert.deepEqual(by.get('backup')?.target, { screen: 'company.config', params: { tab: 'backup' } });
  assert.equal(by.get('sale')?.target, 'sales-voucher');
  assert.equal(by.get('sale')?.shortcut, 'F8');
  assert.deepEqual(by.get('xmlImport')?.target, { screen: 'data.xmlImport' });
  assert.equal(by.get('xmlImport')?.optional, true);
  assert.ok(all.every((x) => !x.done));
  assert.deepEqual(startProgress(all), { done: 0, total: 7, complete: false }, 'XML data import is optional, not counted');
  // Once there are vouchers the XML data import step goes; the rest stay until done.
  assert.ok(!startSteps({ ...ALL, setup: NOTHING_DONE, hasVouchers: true }).some((x) => x.id === 'xmlImport'));
});

test('getting started: by permission and by what the user may open', () => {
  assert.deepEqual(startSteps({ ...ALL, manageCompany: false, importData: false, inventory: false }).map((x) => x.id), ['ledgers', 'sale']);
  assert.deepEqual(startSteps({ manageCompany: false, createMasters: false, createVouchers: false, importData: false, inventory: true }), []);
  // A screen the user cannot open (no permission / feature off) is left out.
  const blocked = new Set(['print.settings', 'data.xmlImport']);
  assert.deepEqual(startSteps({ ...ALL, canOpen: (id) => !blocked.has(id) }).map((x) => x.id), ['profile', 'features', 'ledgers', 'items', 'sale', 'backup']);
});

test('getting started: done from the books, or ticked by hand — never by clicking the step', () => {
  const setup = { ...NOTHING_DONE, profileComplete: true, hasOwnLedgers: true, hasSales: true };
  const steps = startSteps({ ...ALL, setup, hasVouchers: true, ticked: ['features', 'nonsense'] });
  const done = steps.filter((x) => x.done).map((x) => x.id);
  assert.deepEqual(done, ['profile', 'features', 'ledgers', 'sale']);
  assert.equal(steps.find((x) => x.id === 'features')?.doneFromBooks, false);
  assert.equal(steps.find((x) => x.id === 'profile')?.doneFromBooks, true);
  assert.deepEqual(startProgress(steps), { done: 4, total: 7, complete: false });
  // While the summary loads nothing is done (no flash of "done").
  assert.ok(startSteps({ ...ALL, ticked: [] }).every((x) => !x.done));
});

test('getting started card: stays after the first voucher until all done or hidden', () => {
  const some = startSteps({ ...ALL, setup: { ...NOTHING_DONE, hasSales: true }, hasVouchers: true });
  assert.equal(startCardMode(some, { hidden: false, hasVouchers: true }), 'steps', 'regression: it vanished at the first voucher');
  assert.equal(startCardMode(some, { hidden: true, hasVouchers: true }), null);
  const allDone = startSteps({ ...ALL, setup: { profileComplete: true, featuresReviewed: true, invoicePrintingSet: true, hasOwnLedgers: true, hasItems: true, hasSales: true, backupFolderSet: true }, hasVouchers: true });
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
  const allDone = startSteps({ ...ALL, setup: { profileComplete: true, featuresReviewed: true, invoicePrintingSet: true, hasOwnLedgers: true, hasItems: true, hasSales: true, backupFolderSet: true }, hasVouchers: true });
  assert.equal(canShowStartCard(allDone, { hidden: true, hasVouchers: true }), false, 'nothing would show');
  // Wired on the full dashboard (rail Alt+S) and the Gateway panel (a button: no hotkeys there).
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../DashboardScreen.tsx', import.meta.url), 'utf8');
  assert.match(src, /key: 'Alt\+S', label: 'Show Get started', icon: 'eye', onClick: start\.show, hidden: !start\.canShow/);
  assert.match(src, /start\.canShow \? \([\s\S]*Show Get started/);
});
