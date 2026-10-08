import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeRatios, pct, ratio, ratiosReport, type RatioInputs } from './ratios.ts';
import { APRIL, EXPECTED, makeBooks } from './testkit.ts';

const KNOWN: RatioInputs = {
  currentAssets: 500_000,
  currentLiabilities: 200_000,
  cashInHand: 50_000,
  bankAccounts: 100_000,
  bankOd: 0,
  sundryDebtors: 120_000,
  sundryCreditors: 150_000,
  stockInHand: 200_000,
  loans: 300_000,
  capital: 500_000,
  profitLossAccount: 100_000,
  sales: 1_200_000,
  purchases: 800_000,
  grossProfit: 300_000,
  netProfit: 120_000,
  days: 365,
};

const value = (items: Array<{ key: string; value: number | null }>, key: string) => items.find((i) => i.key === key)?.value;

test('ratio formulas on known numbers', () => {
  const { principal, ratios } = computeRatios(KNOWN);
  assert.equal(value(principal, 'workingCapital'), 300_000); // 5,00,000 − 2,00,000
  assert.equal(value(principal, 'wcTurnover'), 4); // 12,00,000 ÷ 3,00,000
  assert.equal(value(principal, 'inventoryTurnover'), 6); // 12,00,000 ÷ 2,00,000
  assert.equal(value(ratios, 'currentRatio'), 2.5); // 5 ÷ 2
  assert.equal(value(ratios, 'quickRatio'), 1.5); // (5 − 2) ÷ 2
  assert.equal(value(ratios, 'debtEquity'), 0.5); // 3 ÷ (5 + 1)
  assert.equal(value(ratios, 'grossProfitPct'), 25); // 3 ÷ 12
  assert.equal(value(ratios, 'netProfitPct'), 10); // 1.2 ÷ 12
  assert.equal(value(ratios, 'operatingCostPct'), 90); // (12 − 1.2) ÷ 12
  assert.equal(value(ratios, 'receivableDays'), 37); // 1,20,000 × 365 ÷ 12,00,000 = 36.5 → 37
  assert.equal(value(ratios, 'roiPct'), 20); // 1.2 ÷ 6
  assert.equal(value(ratios, 'rowcPct'), 40); // 1.2 ÷ 3
});

test('ratios with a zero denominator are null (not computable), never NaN/Infinity', () => {
  const { principal, ratios } = computeRatios({ ...KNOWN, sales: 0, currentLiabilities: 0, stockInHand: 0 });
  assert.equal(value(ratios, 'currentRatio'), null);
  assert.equal(value(ratios, 'grossProfitPct'), null);
  assert.equal(value(ratios, 'receivableDays'), null);
  assert.equal(value(principal, 'inventoryTurnover'), null);
  assert.equal(ratio(1, 3), 0.33);
  assert.equal(pct(2, 3), 66.67);
});

test('ratio analysis of the April books', () => {
  const b = makeBooks();
  const r = ratiosReport(b.env(), APRIL);
  assert.equal(r.days, 30);
  const p = Object.fromEntries(r.principal.map((x) => [x.key, x.value]));
  const q = Object.fromEntries(r.ratios.map((x) => [x.key, x.value]));
  assert.equal(p.workingCapital, 30_166_667); // 3,93,26,667 − 91,60,000
  assert.equal(p.cashInHand, EXPECTED.cash);
  assert.equal(p.bankAccounts, EXPECTED.bank);
  assert.equal(p.sundryDebtors, EXPECTED.acme);
  assert.equal(p.sundryCreditors, 8_080_000);
  assert.equal(p.stockInHand, EXPECTED.closingStock);
  assert.equal(p.sales, EXPECTED.sales);
  assert.equal(p.netProfit, EXPECTED.netProfit);
  assert.equal(q.currentRatio, 4.29); // 3,93,26,667 ÷ 91,60,000 = 4.293
  assert.equal(q.quickRatio, 3.48); // 3,18,60,000 ÷ 91,60,000 = 3.478
  assert.equal(q.grossProfitPct, 28.89); // 34,66,667 ÷ 1,20,00,000
  assert.equal(q.netProfitPct, 5.56);
  assert.equal(q.receivableDays, 10); // 41,60,000 × 30 ÷ 1,20,00,000 = 10.4
  assert.equal(q.debtEquity, 0);
  assert.equal(q.roiPct, 1.68); // 6,66,667 ÷ (3,90,00,000 + 6,66,667)
});
