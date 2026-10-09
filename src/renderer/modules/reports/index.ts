/**
 * Reports module (Tally "Display"): Balance Sheet, Profit & Loss, Trial Balance, Group Summary,
 * Ledger, Cash/Bank books, registers, Monthly Summary, Cash Flow, Funds Flow, Ratio Analysis,
 * Exception Reports, Cost Centres and Statistics — all with keyboard drill-down down to the voucher.
 */
import { api, registerGotoProvider } from '../../app/index.ts';
import type { GotoItem, MenuItem, ModuleDef, ScreenDef } from '../../app/index.ts';
import { BalanceSheetScreen } from './BalanceSheetScreen.tsx';
import { CashBankScreen } from './CashBankScreen.tsx';
import { CostCentresScreen } from './CostCentresScreen.tsx';
import { ExceptionsScreen } from './ExceptionsScreen.tsx';
import { CashFlowScreen, FundsFlowScreen } from './FlowScreens.tsx';
import { GroupSummaryScreen } from './GroupSummaryScreen.tsx';
import { LedgerScreen } from './LedgerScreen.tsx';
import { MonthlySummaryScreen } from './MonthlySummaryScreen.tsx';
import { ProfitLossScreen } from './ProfitLossScreen.tsx';
import { RatiosScreen } from './RatiosScreen.tsx';
import { RegisterScreen } from './RegisterScreen.tsx';
import { StatisticsScreen } from './StatisticsScreen.tsx';
import { TrialBalanceScreen } from './TrialBalanceScreen.tsx';
import { REGISTERS } from './lib/model.ts';
import './reports.css';

const screens: ScreenDef[] = [
  { id: 'reports.balanceSheet', title: 'Balance Sheet', component: BalanceSheetScreen, access: 'reports.financial', goto: true, keywords: ['bs', 'assets', 'liabilities', 'position'] },
  { id: 'reports.profitLoss', title: 'Profit & Loss A/c', component: ProfitLossScreen, access: 'reports.financial', goto: true, keywords: ['pl', 'p&l', 'income', 'expenses', 'profit', 'trading', 'schedule iii'] },
  { id: 'reports.trialBalance', title: 'Trial Balance', component: TrialBalanceScreen, access: 'reports.view', goto: true, keywords: ['tb'] },
  { id: 'reports.groupSummary', title: 'Group Summary', component: GroupSummaryScreen, access: 'reports.view', keywords: ['group vouchers'] },
  { id: 'reports.ledger', title: 'Ledger', component: LedgerScreen, access: 'reports.view', goto: true, keywords: ['ledger vouchers', 'account statement', 'khata'] },
  { id: 'reports.cashBank', title: 'Cash/Bank Books', component: CashBankScreen, access: 'reports.view', goto: true, keywords: ['cash book', 'bank book'] },
  { id: 'reports.register', title: 'Register', component: RegisterScreen, access: 'reports.view', keywords: ['sales register', 'purchase register'] },
  { id: 'reports.monthlySummary', title: 'Monthly Summary', component: MonthlySummaryScreen, access: 'reports.view' },
  { id: 'reports.cashFlow', title: 'Cash Flow', component: CashFlowScreen, access: 'reports.financial', goto: true, keywords: ['inflow', 'outflow'] },
  { id: 'reports.fundsFlow', title: 'Funds Flow', component: FundsFlowScreen, access: 'reports.financial', goto: true, keywords: ['working capital', 'sources', 'applications'] },
  { id: 'reports.ratios', title: 'Ratio Analysis', component: RatiosScreen, access: 'reports.financial', goto: true, keywords: ['current ratio', 'quick ratio', 'gross profit'] },
  { id: 'reports.exceptions', title: 'Exception Reports', component: ExceptionsScreen, access: 'reports.view', goto: true, keywords: ['negative', 'optional', 'post-dated', 'cancelled', 'memorandum'] },
  { id: 'reports.costCentres', title: 'Cost Centres', component: CostCentresScreen, access: 'reports.view', feature: 'costCentres', goto: true, keywords: ['cost category', 'cost centre'] },
  { id: 'reports.statistics', title: 'Statistics', component: StatisticsScreen, access: 'reports.view', goto: true, keywords: ['voucher count', 'masters count'] },
];

const menu: MenuItem[] = [
  { section: 'reports', label: 'Balance Sheet', screen: 'reports.balanceSheet', order: 10, description: 'What the business owns and owes on a date' },
  { section: 'reports', label: 'Profit & Loss A/c', screen: 'reports.profitLoss', order: 11, description: 'Income, expenses and profit for the period' },
  { section: 'reports', label: 'Trial Balance', screen: 'reports.trialBalance', order: 12, description: 'Closing balances of every group and ledger' },
  { section: 'reports', label: 'Ledger', screen: 'reports.ledger', order: 14, description: 'All vouchers of one ledger with the running balance' },
  { section: 'reports', label: 'Cash/Bank Books', screen: 'reports.cashBank', order: 15, description: 'Cash and bank accounts with their balances' },
  ...REGISTERS.map(
    (r, i): MenuItem => ({ section: 'reports', label: r.label, screen: 'reports.register', params: { baseType: r.baseType }, order: 20 + i, keywords: ['register', 'day book'], description: `Month-wise ${r.label.replace(' Register', '').toLowerCase()} vouchers` }),
  ),
  { section: 'reports', label: 'Ratio Analysis', screen: 'reports.ratios', order: 40, description: 'Current ratio, profit margins, receivable days and more' },
  { section: 'reports', label: 'Cash Flow', screen: 'reports.cashFlow', order: 41, description: 'Money in and out of cash and bank, month by month' },
  { section: 'reports', label: 'Funds Flow', screen: 'reports.fundsFlow', order: 42, description: 'Sources and uses of funds, change in working capital' },
  { section: 'reports', label: 'Cost Centre Report', screen: 'reports.costCentres', order: 43, keywords: ['cost centres', 'cost centre summary'], description: 'Expenses and income by cost centre' },
  { section: 'reports', label: 'Exception Reports', screen: 'reports.exceptions', order: 44, description: 'Unusual balances, optional, post-dated and cancelled vouchers' },
  { section: 'reports', label: 'Statistics', screen: 'reports.statistics', order: 45, description: 'Number of vouchers and masters' },
];

export const reportsModule: ModuleDef = { id: 'reports', screens, menu };

/** Go To: account groups open their Group Summary (ledgers already open Ledger Vouchers via the shell). */
registerGotoProvider({
  id: 'reports.groups',
  label: 'Groups',
  minQuery: 2,
  screens: ['reports.groupSummary'],
  search: async (query) => {
    const res = await api('accounts.group.list', { search: query });
    return res.rows.slice(0, 8).map(
      (g): GotoItem => ({
        id: `group:${g.id}`,
        label: g.name,
        group: 'Groups',
        description: g.path.length > 1 ? g.path.slice(0, -1).join(' › ') : 'Primary group',
        keywords: g.alias ? [g.alias] : [],
        screen: 'reports.groupSummary',
        params: { groupId: g.id },
      }),
    );
  },
});
