/**
 * Reports module ("Display"): Balance Sheet, Profit & Loss, Trial Balance, Group Summary,
 * Ledger, Cash/Bank books, registers, Monthly Summary, Cash Flow, Funds Flow, Ratio Analysis,
 * Exception Reports, Cost Centres and Statistics — all with keyboard drill-down down to the voucher.
 */
import { api, registerGotoProvider } from '../../app/index.ts';
import { lazyScreen } from '../../app/lazyScreen.tsx';
import type { GotoItem, MenuItem, ModuleDef, ScreenDef } from '../../app/index.ts';
import { REGISTERS } from './lib/model.ts';
import './reports.css';

// Screens load on first open (app/lazyScreen.tsx, docs/ARCHITECTURE.md §9a); everything else here stays eager.
const BalanceSheetScreen = lazyScreen(() => import('./BalanceSheetScreen.tsx').then((m) => m.BalanceSheetScreen));
const CashBankScreen = lazyScreen(() => import('./CashBankScreen.tsx').then((m) => m.CashBankScreen));
const CostCentresScreen = lazyScreen(() => import('./CostCentresScreen.tsx').then((m) => m.CostCentresScreen));
const ExceptionsScreen = lazyScreen(() => import('./ExceptionsScreen.tsx').then((m) => m.ExceptionsScreen));
const CashFlowScreen = lazyScreen(() => import('./FlowScreens.tsx').then((m) => m.CashFlowScreen));
const FundsFlowScreen = lazyScreen(() => import('./FlowScreens.tsx').then((m) => m.FundsFlowScreen));
const GroupSummaryScreen = lazyScreen(() => import('./GroupSummaryScreen.tsx').then((m) => m.GroupSummaryScreen));
const LedgerScreen = lazyScreen(() => import('./LedgerScreen.tsx').then((m) => m.LedgerScreen));
const MonthlySummaryScreen = lazyScreen(() => import('./MonthlySummaryScreen.tsx').then((m) => m.MonthlySummaryScreen));
const ProfitLossScreen = lazyScreen(() => import('./ProfitLossScreen.tsx').then((m) => m.ProfitLossScreen));
const RatiosScreen = lazyScreen(() => import('./RatiosScreen.tsx').then((m) => m.RatiosScreen));
const RegisterScreen = lazyScreen(() => import('./RegisterScreen.tsx').then((m) => m.RegisterScreen));
const StatisticsScreen = lazyScreen(() => import('./StatisticsScreen.tsx').then((m) => m.StatisticsScreen));
const TrialBalanceScreen = lazyScreen(() => import('./TrialBalanceScreen.tsx').then((m) => m.TrialBalanceScreen));

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
