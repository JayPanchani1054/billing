import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelVoucher } from '../vouchers/service.ts';
import { loadReportEnv } from './engine.ts';
import { APRIL, EXPECTED, makeBooks } from './testkit.ts';
import { cashBank, groupSummary, trialBalance } from './trialBalance.ts';

test('TB (groups): primary groups net, Dr total = Cr total = 6,03,60,000 p with the opening stock row', () => {
  const b = makeBooks();
  const tb = trialBalance(b.env(), { ...APRIL, mode: 'groups' });
  // Dr: opening stock 1,00,00,000 + fixed 95,00,000 + current assets 3,18,60,000 + purchase 60,00,000 + indirect exp 30,00,000
  // Cr: capital 3,90,00,000 + current liabilities 91,60,000 + sales 1,20,00,000 + indirect inc 2,00,000
  assert.equal(tb.totals.closing.debit, 60_360_000);
  assert.equal(tb.totals.closing.credit, 60_360_000);
  assert.equal(tb.balanced, true);
  assert.equal(tb.unbalancedBy, 0);
  assert.equal(tb.openingDifference, 0);
  assert.ok(!tb.rows.some((r) => r.kind === 'ledger'), 'groups mode has no ledger rows');
  assert.equal(tb.rows[0].key, 'stock:opening');
  assert.equal(tb.rows[0].closing, EXPECTED.openingStock);
  const ca = tb.rows.find((r) => r.name === 'Current Assets');
  // 37,00,000 cash + 2,40,00,000 bank + 41,60,000 Acme
  assert.equal(ca?.closing, 31_860_000);
  assert.equal(ca?.opening, 25_000_000);
});

test('TB (detailed): ledgers under their groups; gross Dr/Cr per ledger; transactions Dr = Cr', () => {
  const b = makeBooks();
  const tb = trialBalance(b.env(), { ...APRIL, mode: 'detailed' });
  const supreme = tb.rows.find((r) => r.key === `l:${b.L.supreme}`);
  assert.deepEqual(
    supreme && { o: supreme.opening, d: supreme.debit, c: supreme.credit, cl: supreme.closing, lvl: supreme.level },
    // −60,00,000 + 50,00,000 − 70,80,000 = −80,80,000
    { o: -6_000_000, d: 5_000_000, c: 7_080_000, cl: -8_080_000, lvl: 2 },
  );
  const dt = tb.rows.find((r) => r.name === 'Duties & Taxes');
  assert.equal(dt?.hasChildren, true);
  assert.equal(dt?.closing, -1_080_000); // 5,40,000 × 2 input − 10,80,000 × 2 output
  assert.equal(tb.totals.transactions.debit, tb.totals.transactions.credit);
  assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
});

test('TB (ledgers): flat list, gross totals 6,14,40,000 p each side', () => {
  const b = makeBooks();
  const tb = trialBalance(b.env(), { ...APRIL, mode: 'ledgers' });
  assert.ok(tb.rows.every((r) => r.level === 0));
  // Dr: furniture 95,00,000 + cash 37,00,000 + bank 2,40,00,000 + Acme 41,60,000 + input 5,40,000 × 2 + purchase 60,00,000
  //     + rent 25,00,000 + depreciation 5,00,000 + opening stock 1,00,00,000 = 6,14,40,000
  assert.equal(tb.totals.closing.debit, 61_440_000);
  assert.equal(tb.totals.closing.credit, 61_440_000);
});

test('TB hides all-zero ledgers unless showZero', () => {
  const b = makeBooks();
  const env = b.env();
  const hidden = trialBalance(env, { ...APRIL, mode: 'detailed' });
  assert.ok(!hidden.rows.some((r) => r.name === 'Output IGST'));
  assert.ok(!hidden.rows.some((r) => r.name === 'Round Off'));
  const shown = trialBalance(env, { ...APRIL, mode: 'detailed', showZero: true });
  assert.ok(shown.rows.some((r) => r.name === 'Output IGST'));
  assert.equal(shown.totals.closing.debit, hidden.totals.closing.debit);
});

test('opening-balance difference: Σ openings + opening stock ≠ 0 → Cr difference row and TB still balances', () => {
  // Capital ₹3,80,000 instead of ₹3,90,000 → Σ ledger openings + stock = +10,00,000 Dr → difference 10,00,000 Cr.
  const b = makeBooks({ capitalOpening: -38_000_000 });
  const tb = trialBalance(b.env(), { ...APRIL, mode: 'groups' });
  assert.equal(tb.openingDifference, -1_000_000);
  const diff = tb.rows.find((r) => r.kind === 'difference');
  assert.equal(diff?.closing, -1_000_000);
  assert.equal(diff?.name, 'Difference in opening balances');
  assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
  assert.equal(tb.totals.opening.debit, tb.totals.opening.credit);
  assert.equal(tb.balanced, true);
});

test('optional, cancelled and not-yet-due post-dated vouchers stay out of the TB; a due post-dated one counts', () => {
  const b = makeBooks();
  const env0 = b.env();
  const before = trialBalance(env0, { ...APRIL, mode: 'detailed' });
  const vt = b.t.ids.voucherTypes;
  const pay = (date: string, extra: object) =>
    b.post({ voucherTypeId: vt.payment, date, mode: 'ledger', ledgers: [{ ledgerId: b.L.rent, amount: 100_000 }, { ledgerId: b.L.cash, amount: -100_000 }], ...extra });
  pay('2026-04-21', { isOptional: true });
  const c = pay('2026-04-22', {});
  cancelVoucher(b.t.ctx, c.id, 'Entered twice');
  pay('2026-05-05', { isPostDated: true }); // after today (30-Apr) and after the period
  const after = trialBalance(loadReportEnv(b.t.db, b.t.today), { ...APRIL, mode: 'detailed' });
  const rent = (tb: typeof before) => tb.rows.find((r) => r.key === `l:${b.L.rent}`)?.closing;
  assert.equal(rent(after), rent(before));
  assert.equal(rent(after), 2_500_000);
  // A post-dated cheque dated within the period and on/before today counts.
  pay('2026-04-30', { isPostDated: true });
  const due = trialBalance(loadReportEnv(b.t.db, b.t.today), { ...APRIL, mode: 'detailed' });
  assert.equal(rent(due), 2_600_000);
  // May: the 5-May post-dated payment is still in the future (today 30-Apr) → not in the books.
  const may = trialBalance(loadReportEnv(b.t.db, b.t.today), { from: '2026-05-01', to: '2026-05-31', mode: 'detailed' });
  assert.equal(may.rows.find((r) => r.key === `l:${b.L.rent}`)?.debit ?? 0, 0);
});

test('second year: income/expense ledgers start afresh; last year profit sits in the Profit & Loss A/c with the year-opening stock', () => {
  const b = makeBooks({ today: '2027-05-31' });
  const vt = b.t.ids.voucherTypes;
  // FY 2027-28: sell 10 Widget @ ₹2,000 → sales 20,00,000 p.
  b.post({ voucherTypeId: vt.sales, date: '2027-05-10', mode: 'item_invoice', partyLedgerId: b.L.acme, items: [{ itemId: b.widget, qty: 10, rate: 2000 }] });
  const tb = trialBalance(b.env(), { from: '2027-05-01', to: '2027-05-31', mode: 'detailed' });
  assert.equal(tb.yearStart, '2027-04-01');
  // Opening stock of FY 2027-28 = April 2026 closing stock 74,66,667.
  assert.equal(tb.openingStock, EXPECTED.closingStock);
  const sales = tb.rows.find((r) => r.key === `l:${b.L.sales}`);
  assert.equal(sales?.opening, 0, 'FY 2026-27 sales are not carried forward');
  assert.equal(sales?.closing, -2_000_000);
  const pl = tb.rows.find((r) => r.key === `l:${b.L.pl}`);
  // FY 2026-27 net profit 6,66,667 as a credit.
  assert.equal(pl?.opening, -EXPECTED.netProfit);
  assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
  assert.equal(tb.totals.opening.debit, tb.totals.opening.credit);
});

test('without integrated inventory: no opening stock row and the difference ignores stock', () => {
  const b = makeBooks({ features: { integrateInventory: false } });
  const tb = trialBalance(b.env(), { ...APRIL, mode: 'groups' });
  assert.equal(tb.inventoryIntegrated, false);
  assert.ok(!tb.rows.some((r) => r.kind === 'stock'));
  // Σ ledger openings = −1,00,00,000 (no stock) → difference +1,00,00,000 Dr.
  assert.equal(tb.openingDifference, 10_000_000);
  assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
});

test('Group Summary rolls up sub-groups and ledgers; Current Assets includes closing stock', () => {
  const b = makeBooks();
  const env = b.env();
  const ca = groupSummary(env, { ...APRIL, groupId: b.t.ids.groups.CURRENT_ASSETS });
  // 37,00,000 + 2,40,00,000 + 41,60,000 + closing stock 74,66,667
  assert.equal(ca.totals.closing, 31_860_000 + EXPECTED.closingStock);
  const stock = ca.rows.find((r) => r.name === 'Stock-in-Hand');
  assert.equal(stock?.closing, EXPECTED.closingStock);
  assert.equal(stock?.opening, EXPECTED.openingStock);
  assert.equal(ca.rows.find((r) => r.kind === 'stock')?.level, 1);
  const dt = groupSummary(env, { ...APRIL, groupId: b.t.ids.groups.DUTIES_TAXES });
  assert.equal(dt.rows.length, 4);
  assert.equal(dt.totals.closing, dt.rows.reduce((s, r) => s + r.closing, 0));
  assert.equal(dt.totals.closing, -1_080_000);
  assert.equal(dt.group.path.join(' › '), 'Current Liabilities › Duties & Taxes');
});

test('Group Summary of a primary group equals its Trial Balance line', () => {
  const b = makeBooks();
  const env = b.env();
  const tb = trialBalance(env, { ...APRIL, mode: 'groups' });
  for (const code of ['CURRENT_LIABILITIES', 'FIXED_ASSETS', 'INDIRECT_EXPENSES', 'CAPITAL_ACCOUNT'] as const) {
    const id = b.t.ids.groups[code];
    const gs = groupSummary(env, { ...APRIL, groupId: id });
    const line = tb.rows.find((r) => r.key === `g:${id}`);
    assert.equal(gs.totals.closing, line?.closing, code);
    assert.equal(gs.totals.debit, line?.debit, code);
  }
});

test('Cash/Bank books: opening 2,50,00,000 → closing 2,77,00,000', () => {
  const b = makeBooks();
  const r = cashBank(b.env(), APRIL);
  assert.equal(r.totals.opening, 25_000_000);
  assert.equal(r.totals.closing, 27_700_000);
  assert.deepEqual(
    r.rows.filter((x) => x.kind === 'ledger').map((x) => [x.name, x.closing]),
    [
      ['Cash', EXPECTED.cash],
      ['HDFC Bank', EXPECTED.bank],
    ],
  );
  assert.ok(!r.rows.some((x) => x.name === 'Bank OD A/c'), 'empty Bank OD group hidden');
});
