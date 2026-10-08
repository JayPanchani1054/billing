/**
 * Ratio Analysis (Tally "Ratio Analysis"): principal groups and key ratios with documented formulas
 * (README §15). Balances are as at the end of `to`; flows (sales, purchases, profit) are for [from, to].
 */
import type { GroupCode } from '../../../shared/constants.ts';
import type { Paise } from '../../../shared/money.ts';
import type { RatioItem, RatiosResult } from '../../../shared/types/reports.ts';
import { assertPeriod, daysIn, nominalMovement, stockAt, stockAtEnd, type ReportEnv } from './engine.ts';
import { bsParts, neg, profitFigures } from './financials.ts';

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** a / b rounded to 2 decimals, null when b is 0. */
export function ratio(a: number, b: number): number | null {
  return b === 0 ? null : round2(a / b);
}

/** a / b × 100 rounded to 2 decimals, null when b is 0. */
export function pct(a: number, b: number): number | null {
  return b === 0 ? null : round2((a / b) * 100);
}

export interface RatioInputs {
  currentAssets: Paise;
  currentLiabilities: Paise;
  cashInHand: Paise;
  bankAccounts: Paise;
  bankOd: Paise;
  sundryDebtors: Paise;
  sundryCreditors: Paise;
  stockInHand: Paise;
  loans: Paise;
  capital: Paise;
  profitLossAccount: Paise;
  sales: Paise;
  purchases: Paise;
  grossProfit: Paise;
  netProfit: Paise;
  days: number;
}

/** Pure ratio computation from the principal figures (all paise, side-natural). */
export function computeRatios(x: RatioInputs, groupIds: Partial<Record<GroupCode, number>> = {}): { principal: RatioItem[]; ratios: RatioItem[] } {
  const g = (code: GroupCode): number | null => groupIds[code] ?? null;
  const workingCapital = x.currentAssets - x.currentLiabilities;
  const equity = x.capital + x.profitLossAccount;
  const item = (key: string, label: string, value: number | null, unit: RatioItem['unit'], formula: string, groupId: number | null = null): RatioItem => ({
    key,
    label,
    value,
    unit,
    formula,
    groupId,
  });
  const principal: RatioItem[] = [
    item('workingCapital', 'Working Capital', workingCapital, 'amount', 'Current Assets − Current Liabilities', g('CURRENT_ASSETS')),
    item('cashInHand', 'Cash-in-Hand', x.cashInHand, 'amount', 'Closing balance of Cash-in-Hand', g('CASH_IN_HAND')),
    item('bankAccounts', 'Bank Accounts', x.bankAccounts, 'amount', 'Closing balance of Bank Accounts', g('BANK_ACCOUNTS')),
    item('bankOd', 'Bank OD A/c', x.bankOd, 'amount', 'Closing balance of Bank OD A/c (credit)', g('BANK_OD')),
    item('sundryDebtors', 'Sundry Debtors', x.sundryDebtors, 'amount', 'Closing balance of Sundry Debtors', g('SUNDRY_DEBTORS')),
    item('sundryCreditors', 'Sundry Creditors', x.sundryCreditors, 'amount', 'Closing balance of Sundry Creditors (credit)', g('SUNDRY_CREDITORS')),
    item('sales', 'Sales Accounts', x.sales, 'amount', 'Net sales of the period', g('SALES_ACCOUNTS')),
    item('purchases', 'Purchase Accounts', x.purchases, 'amount', 'Net purchases of the period', g('PURCHASE_ACCOUNTS')),
    item('stockInHand', 'Stock-in-Hand', x.stockInHand, 'amount', 'Closing stock', g('STOCK_IN_HAND')),
    item('netProfit', 'Net Profit', x.netProfit, 'amount', 'Net profit (loss negative) of the period'),
    item('wcTurnover', 'Working Capital Turnover', ratio(x.sales, workingCapital), 'times', 'Sales Accounts ÷ Working Capital'),
    item('inventoryTurnover', 'Inventory Turnover', ratio(x.sales, x.stockInHand), 'times', 'Sales Accounts ÷ Closing Stock'),
  ];
  const ratios: RatioItem[] = [
    item('currentRatio', 'Current Ratio', ratio(x.currentAssets, x.currentLiabilities), 'ratio', 'Current Assets ÷ Current Liabilities'),
    item('quickRatio', 'Quick Ratio', ratio(x.currentAssets - x.stockInHand, x.currentLiabilities), 'ratio', '(Current Assets − Stock-in-Hand) ÷ Current Liabilities'),
    item('debtEquity', 'Debt / Equity Ratio', ratio(x.loans, equity), 'ratio', 'Loans (Liability) ÷ (Capital Account + Profit & Loss A/c)'),
    item('grossProfitPct', 'Gross Profit %', pct(x.grossProfit, x.sales), 'percent', 'Gross Profit ÷ Sales Accounts × 100'),
    item('netProfitPct', 'Net Profit %', pct(x.netProfit, x.sales), 'percent', 'Net Profit ÷ Sales Accounts × 100'),
    item('operatingCostPct', 'Operating Cost %', pct(x.sales - x.netProfit, x.sales), 'percent', '(Sales Accounts − Net Profit) ÷ Sales Accounts × 100'),
    item(
      'receivableDays',
      'Receivables Turnover in Days',
      x.sales === 0 ? null : Math.round((x.sundryDebtors * x.days) / x.sales),
      'days',
      'Sundry Debtors × days in the period ÷ Sales Accounts',
    ),
    item('roiPct', 'Return on Investment %', pct(x.netProfit, equity), 'percent', 'Net Profit ÷ (Capital Account + Profit & Loss A/c) × 100'),
    item('rowcPct', 'Return on Working Capital %', pct(x.netProfit, workingCapital), 'percent', 'Net Profit ÷ Working Capital × 100'),
  ];
  return { principal, ratios };
}

export function ratiosReport(env: ReportEnv, input: { from: string; to: string }): RatiosResult {
  assertPeriod(input.from, input.to);
  const bs = bsParts(env, input.to);
  const sumUnder = (code: GroupCode): Paise => {
    const id = env.groupByCode.get(code);
    if (id === undefined) return 0;
    let s = 0;
    for (const [lid, v] of bs.closings) {
      if (lid === env.plLedgerId) continue;
      const l = env.ledgerById.get(lid);
      const g = l ? env.tree.byId.get(l.groupId) : undefined;
      if (g?.chainIds.includes(id)) s += v;
    }
    return s;
  };
  const closingStock = stockAtEnd(env, input.to);
  const f = profitFigures(env, { values: nominalMovement(env, input.from, input.to), openingStock: stockAt(env, input.from), closingStock });
  const groupIds: Partial<Record<GroupCode, number>> = {};
  for (const [code, id] of env.groupByCode) groupIds[code] = id;
  const x: RatioInputs = {
    currentAssets: sumUnder('CURRENT_ASSETS') + bs.closingStock,
    currentLiabilities: neg(sumUnder('CURRENT_LIABILITIES')),
    cashInHand: sumUnder('CASH_IN_HAND'),
    bankAccounts: sumUnder('BANK_ACCOUNTS'),
    bankOd: neg(sumUnder('BANK_OD')),
    sundryDebtors: sumUnder('SUNDRY_DEBTORS'),
    sundryCreditors: neg(sumUnder('SUNDRY_CREDITORS')),
    stockInHand: sumUnder('STOCK_IN_HAND') + bs.closingStock,
    loans: neg(sumUnder('LOANS_LIABILITY')),
    capital: neg(sumUnder('CAPITAL_ACCOUNT')),
    profitLossAccount: bs.plOpening + bs.plTransferred + bs.currentProfit,
    sales: f.sales,
    purchases: f.purchases,
    grossProfit: f.grossProfit,
    netProfit: f.netProfit,
    days: daysIn(input.from, input.to),
  };
  const { principal, ratios } = computeRatios(x, groupIds);
  return { from: input.from, to: input.to, days: x.days, principal, ratios };
}
