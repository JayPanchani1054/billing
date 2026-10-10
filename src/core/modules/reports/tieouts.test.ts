/**
 * Second review pass (Chartered-Accountant lens): comparative periods of a company that started its
 * books mid-year, the Profit & Loss A/c as a primary line of its own (so a Capital Account drill-down
 * ties to the Balance Sheet), and Cash/Bank books hiding empty sub-groups. Figures are hand-computed
 * from the April books in testkit.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveGroup } from '../accounts/groups.ts';
import { summaryForCtx } from '../dashboard/summary.ts';
import { cancelVoucher } from '../vouchers/service.ts';
import { balanceSheet, profitLoss } from './financials.ts';
import { cashFlow, fundsFlow } from './flows.ts';
import { groupVouchers, monthlySummary } from './ledger.ts';
import { EXPECTED, makeBooks } from './testkit.ts';
import { cashBank, groupSummary, trialBalance } from './trialBalance.ts';

/** Books from 1-Oct-2026 with year-to-date results entered as opening balances. */
function midYear(today = '2027-03-31') {
  const b = makeBooks({ booksFrom: '2026-10-01', today, skipVouchers: true });
  // Sales Cr 50,00,000 and Office Rent Dr 10,00,000 earned/spent Apr–Sep; cash raised to 90,00,000.
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: -5_000_000, id: b.L.sales });
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 1_000_000, id: b.L.rent });
  b.t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 9_000_000, id: b.L.cash });
  return b;
}

test('mid-year books: a comparative period wholly before the books does not count the opening balances again', () => {
  const env = midYear().env();
  // Current: Oct 2026 – Mar 2027 contains the books beginning → 50,00,000 − 10,00,000 = 40,00,000.
  const py = profitLoss(env, { from: '2026-10-01', to: '2027-03-31', compareWith: 'previous_year' });
  assert.equal(py.figures.netProfit, 4_000_000);
  assert.deepEqual(py.compare, { from: '2025-10-01', to: '2026-03-31' });
  // Oct 2025 – Mar 2026: no books yet → nothing (it used to repeat the 40,00,000).
  assert.equal(py.compareFigures?.sales, 0);
  assert.equal(py.compareFigures?.indirectExpenses, 0);
  assert.equal(py.compareFigures?.netProfit, 0);
  // Jul – Sep 2026 (previous period of Oct – Dec) is also before the books: no sales.
  const pp = profitLoss(env, { from: '2026-10-01', to: '2026-12-31', compareWith: 'previous_period' });
  assert.deepEqual(pp.compare, { from: '2026-07-01', to: '2026-09-30' });
  assert.equal(pp.compareFigures?.sales, 0);
  assert.equal(pp.figures.sales, 5_000_000);
  // The whole financial year contains the books beginning → the openings count once.
  assert.equal(profitLoss(env, { from: '2026-04-01', to: '2027-03-31' }).figures.netProfit, 4_000_000);
  // A later period (Nov) does not get them either.
  assert.equal(profitLoss(env, { from: '2026-11-01', to: '2026-11-30' }).figures.sales, 0);
  // The Balance Sheet's current period agrees with the first P&L.
  const bs = balanceSheet(env, { asOf: '2027-03-31' });
  assert.equal(bs.profitLoss.currentPeriod, 4_000_000);
  assert.equal(bs.balanced, true);
});

/** April books, then 5-Apr-2027: ₹3,000 of last year's profit transferred to the owner's capital. */
function secondYear() {
  const b = makeBooks({ today: '2027-06-30' });
  b.post({
    voucherTypeId: b.t.ids.voucherTypes.journal,
    date: '2027-04-05',
    mode: 'ledger',
    ledgers: [
      { ledgerId: b.L.pl, amount: 300_000 },
      { ledgerId: b.L.capital, amount: -300_000 },
    ],
    narration: 'Profit transferred to capital',
  });
  return b;
}

test('Trial Balance: the Profit & Loss A/c is its own primary line, not part of Capital Account', () => {
  const b = secondYear();
  const env = b.env();
  const q2 = { from: '2027-04-01', to: '2027-06-30' };
  const capitalId = b.t.ids.groups.CAPITAL_ACCOUNT;
  for (const mode of ['groups', 'detailed', 'ledgers'] as const) {
    const tb = trialBalance(env, { ...q2, mode });
    assert.equal(tb.balanced, true, mode);
    const pl = tb.rows.find((r) => r.key === `l:${b.L.pl}`);
    // Opening Cr 6,66,667 (last year's profit) + Dr 3,00,000 transferred → closing Cr 3,66,667.
    assert.deepEqual(pl && [pl.level, pl.parentKey, pl.opening, pl.debit, pl.credit, pl.closing], [0, null, -EXPECTED.netProfit, 300_000, 0, -366_667], mode);
    assert.equal(tb.rows.filter((r) => r.key === `l:${b.L.pl}`).length, 1, mode);
    if (mode !== 'ledgers') {
      // Capital Account = Owner Capital only: Cr 3,90,00,000 + Cr 3,00,000 = Cr 3,93,00,000.
      const cap = tb.rows.find((r) => r.key === `g:${capitalId}`);
      assert.deepEqual(cap && [cap.opening, cap.credit, cap.closing], [-39_000_000, 300_000, -39_300_000], mode);
    }
  }
});

test('Capital Account drill-down ties to its Balance Sheet line; group vouchers and monthly summary leave the P&L A/c out', () => {
  const b = secondYear();
  const env = b.env();
  const capitalId = b.t.ids.groups.CAPITAL_ACCOUNT;
  const bs = balanceSheet(env, { asOf: '2027-06-30' });
  assert.equal(bs.balanced, true);
  const line = bs.liabilities.find((l) => l.key === `g:${capitalId}`);
  const gs = groupSummary(env, { groupId: capitalId, from: '2027-04-01', to: '2027-06-30' });
  assert.equal(line?.amount, 39_300_000);
  assert.equal(-gs.totals.closing, line?.amount);
  assert.equal(gs.rows.some((r) => r.id === b.L.pl && r.kind === 'ledger'), false);
  // Group Vouchers: the transfer touches Owner Capital (Cr 3,00,000) only, within Capital Account.
  const gv = groupVouchers(env, { groupId: capitalId, from: '2027-04-01', to: '2027-06-30' });
  assert.deepEqual([gv.opening, gv.totals.debit, gv.totals.credit, gv.closing, gv.rows.length], [-39_000_000, 0, 300_000, -39_300_000, 1]);
  assert.equal(gv.rows[0].particulars, 'Owner Capital');
  const ms = monthlySummary(env, { groupId: capitalId, from: '2027-04-01', to: '2027-06-30' });
  assert.deepEqual(ms.rows.map((r) => [r.month, r.debit, r.credit, r.closing]), [
    ['2027-04', 0, 300_000, -39_300_000],
    ['2027-05', 0, 0, -39_300_000],
    ['2027-06', 0, 0, -39_300_000],
  ]);
});

test('Cash/Bank books: a sub-group with no ledgers is hidden, and so is a parent left with nothing below it', () => {
  const b = makeBooks();
  const bankOd = b.t.ids.groups.BANK_OD;
  // An empty sub-group under Bank OD A/c (which has no ledgers of its own).
  saveGroup(b.t.ctx, { name: 'Cash Credit Accounts', parentId: bankOd });
  const cb = cashBank(b.env(), { from: '2026-04-01', to: '2026-04-30' });
  assert.equal(cb.rows.some((r) => r.name === 'Cash Credit Accounts'), false);
  assert.equal(cb.rows.some((r) => r.key === `g:${bankOd}`), false);
  // Every group row shown has something below it; totals are unchanged (cash 37,00,000 + bank 2,40,00,000).
  for (const r of cb.rows) if (r.kind === 'group') assert.equal(r.hasChildren, true, r.name);
  assert.equal(cb.totals.closing, EXPECTED.cash + EXPECTED.bank);
});

test('invariants on a mixed year posted through the vouchers service (returns, optional, post-dated, cancelled, overdraft)', () => {
  const b = makeBooks({ today: '2026-06-15' });
  const vt = b.t.ids.voucherTypes;
  // May: a sales return of 5 Widget (credit note) and a purchase return of 2 (debit note).
  b.post({ voucherTypeId: vt.credit_note, date: '2026-05-05', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 5, rate: 1500 }] });
  b.post({ voucherTypeId: vt.debit_note, date: '2026-05-06', mode: 'item_invoice', partyLedgerId: b.L.supreme, items: [{ itemId: b.widget, qty: 2, rate: 1200 }] });
  // An overdrawn bank: pay ₹3,00,000 of rent from HDFC (balance ₹2,40,000 → Cr ₹60,000).
  b.post({ voucherTypeId: vt.payment, date: '2026-05-20', mode: 'ledger', ledgers: [{ ledgerId: b.L.rent, amount: 30_000_000 }, { ledgerId: b.L.bank, amount: -30_000_000 }] });
  // Not in the books: optional, cancelled, and post-dated after the working date.
  b.post({ voucherTypeId: vt.sales, date: '2026-05-25', mode: 'item_invoice', partyLedgerId: b.L.acme, isOptional: true, items: [{ itemId: b.widget, qty: 3, rate: 1500 }] });
  const cancelled = b.post({ voucherTypeId: vt.sales, date: '2026-05-26', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 4, rate: 1500 }] });
  cancelVoucher(b.t.ctx, cancelled.id, 'Entered twice');
  b.post({ voucherTypeId: vt.receipt, date: '2026-06-30', mode: 'ledger', isPostDated: true, ledgers: [{ ledgerId: b.L.cash, amount: 500_000 }, { ledgerId: b.L.acme, amount: -500_000 }] });
  const env = b.env();
  const period = { from: '2026-04-01', to: '2026-06-30' };

  const tb = trialBalance(env, { ...period, mode: 'detailed' });
  assert.equal(tb.balanced, true);
  const pl = profitLoss(env, period);
  const bs = balanceSheet(env, { asOf: period.to });
  assert.equal(bs.balanced, true);
  // The P&L of the year so far is the Balance Sheet's current period.
  assert.equal(pl.figures.netProfit, bs.profitLoss.currentPeriod);
  // P&L blocks balance (Expenses = Income).
  for (const blk of [pl.trading, pl.profitLoss]) {
    const side = (lines: typeof blk.left) => lines.filter((l) => l.level === 0).reduce((s, l) => s + l.amount, 0);
    assert.equal(side(blk.left), side(blk.right));
  }
  // Every primary group's Group Summary equals its Balance Sheet line (Dr-signed vs side-natural).
  for (const line of [...bs.liabilities, ...bs.assets]) {
    if (line.kind !== 'group' || line.level !== 0 || line.id === null) continue;
    const gs = groupSummary(env, { groupId: line.id, from: '2026-04-01', to: period.to });
    const natural = bs.liabilities.includes(line) ? -gs.totals.closing : gs.totals.closing;
    assert.equal(natural, line.amount, line.name);
  }
  // The overdrawn bank stays inside Current Assets as a negative (Cr) amount, not moved or dropped.
  const hdfc = bs.assets.find((l) => l.key === `l:${b.L.bank}`);
  assert.equal(hdfc?.amount, -6_000_000);
  // Cash flow: Σ net = closing − opening of cash & bank; funds flow agrees with working capital.
  const cf = cashFlow(env, period);
  assert.equal(cf.totals.net, cf.closing - cf.opening);
  assert.equal(cf.groups.reduce((s, g) => s + g.net, 0), cf.totals.net);
  assert.equal(fundsFlow(env, period).difference, 0);
  // Excluded vouchers: TB sales = April 1,20,000 − return 7,500 = 1,12,500 (optional / cancelled not counted).
  assert.equal(pl.figures.sales, 12_000_000 - 750_000);
  // Post-dated receipt (30-Jun, working date 15-Jun) is not yet in Cash.
  assert.equal(tb.rows.find((r) => r.key === `l:${b.L.cash}`)?.closing, EXPECTED.cash);
});

// ───────────────────────────── 2.1 graph data ─────────────────────────────

test('Home graph tie-out: dashboard trend sales = the Sales Accounts monthly summary (credit − debit), the books-beginning month carrying the nominal opening', () => {
  // Books from 1-Feb-2026 (year-to-date sales entered as openings), working date 30-Jun-2026.
  const b = makeBooks({ booksFrom: '2026-02-01', today: '2026-06-30', skipVouchers: true });
  const t = b.t;
  const vt = t.ids.voucherTypes;
  const salesGroup = t.ids.groups.SALES_ACCOUNTS;
  // A sub-group of Sales Accounts with its own ledger and opening: the group roll-up counts it too.
  const exportGroup = saveGroup(t.ctx, { name: 'Export Sales', parentId: salesGroup }).id;
  const exportSales = t.addLedger({ name: 'Export Sales A/c', group: 'SALES_ACCOUNTS', openingBalance: -800_000 });
  t.db.run('UPDATE ledgers SET group_id = :g WHERE id = :id', { g: exportGroup, id: exportSales });
  t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: -5_000_000, id: b.L.sales });
  t.db.run('UPDATE ledgers SET opening_balance = :ob WHERE id = :id', { ob: 10_800_000 + 5_000_000 + 800_000, id: b.L.cash });
  const sell = (date: string, qty: number, extra: Record<string, unknown> = {}) =>
    b.post({ voucherTypeId: vt.sales, date, mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty, rate: 1500 }], ...extra });
  sell('2026-02-12', 10);
  sell('2026-03-30', 20);
  sell('2026-04-02', 5);
  // A sales return in May (credit note: Dr Sales), a journal straight to the export ledger in June.
  b.post({ voucherTypeId: vt.credit_note, date: '2026-05-05', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 3, rate: 1500 }] });
  b.post({ voucherTypeId: vt.journal, date: '2026-06-10', mode: 'ledger', ledgers: [{ ledgerId: b.L.acme, amount: 400_000 }, { ledgerId: exportSales, amount: -400_000 }] });
  // Neither counts anywhere: an optional sale and a post-dated one after the working date.
  sell('2026-06-12', 4, { isOptional: true });
  sell('2026-07-02', 4, { isPostDated: true });

  const dash = summaryForCtx(t.ctx, { asOf: '2026-06-30', from: '2026-04-01', to: '2026-06-30' });
  assert.equal(dash.trend.length, 12);
  assert.equal(dash.trend[0].month, '2025-07');
  const ms = monthlySummary(b.env(), { groupId: salesGroup, from: dash.trend[0].from, to: dash.trend[11].to });
  assert.equal(ms.subject.isNominal, true);
  // The monthly summary starts at the books beginning; the trend's earlier months are empty.
  assert.equal(ms.rows[0].month, '2026-02');
  const byMonth = new Map(ms.rows.map((r) => [r.month, r]));
  // Nominal opening of Sales Accounts (credit-natural): 50,000 + 8,000.
  const nominalOpening = 5_800_000;
  for (const m of dash.trend) {
    const row = byMonth.get(m.month);
    if (!row) {
      assert.ok(m.month < '2026-02', m.month);
      assert.equal(m.sales, 0, m.month);
      continue;
    }
    const movement = row.credit - row.debit;
    assert.equal(m.sales - movement, m.month === '2026-02' ? nominalOpening : 0, m.month);
  }
  // By hand: Feb 15,000 + opening 58,000; Mar 30,000; Apr 7,500; May −4,500 (return); Jun 4,000 (journal).
  assert.deepEqual(
    dash.trend.slice(7).map((m) => [m.month, m.sales]),
    [
      ['2026-02', 1_500_000 + nominalOpening],
      ['2026-03', 3_000_000],
      ['2026-04', 750_000],
      ['2026-05', -450_000],
      ['2026-06', 400_000],
    ],
  );
});

test('Monthly Summary subject.isNominal: income / expense ledgers and groups (sub-groups too) are nominal, the rest are not', () => {
  const b = makeBooks();
  const env = b.env();
  const g = b.t.ids.groups;
  const sub = saveGroup(b.t.ctx, { name: 'Office Costs', parentId: g.INDIRECT_EXPENSES }).id;
  const APR = { from: '2026-04-01', to: '2026-04-30' };
  const nominal = (q: { ledgerId?: number; groupId?: number }) => monthlySummary(b.env(), { ...APR, ...q }).subject.isNominal;
  assert.equal(nominal({ ledgerId: b.L.sales }), true);
  assert.equal(nominal({ ledgerId: b.L.rent }), true);
  assert.equal(nominal({ ledgerId: b.L.interest }), true);
  assert.equal(nominal({ ledgerId: b.L.cash }), false);
  assert.equal(nominal({ ledgerId: b.L.capital }), false);
  assert.equal(nominal({ ledgerId: b.L.pl }), false, 'the Profit & Loss A/c is a real (capital) ledger');
  assert.equal(nominal({ groupId: g.SALES_ACCOUNTS }), true);
  assert.equal(nominal({ groupId: g.PURCHASE_ACCOUNTS }), true);
  assert.equal(nominal({ groupId: g.INDIRECT_INCOMES }), true);
  assert.equal(nominal({ groupId: sub }), true);
  assert.equal(nominal({ groupId: g.CURRENT_ASSETS }), false);
  assert.equal(nominal({ groupId: g.SUNDRY_CREDITORS }), false);
  // Additive: every other field is what it was (subject name/kind/id unchanged).
  const r = monthlySummary(env, { ...APR, ledgerId: b.L.cash });
  assert.deepEqual(r.subject, { kind: 'ledger', id: b.L.cash, name: 'Cash', isNominal: false });
});
