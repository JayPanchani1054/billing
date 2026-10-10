/**
 * Documents module UI (core: src/core/modules/documents, README there). Screens and params:
 *
 *   'documents.quotations'          { baseType?: 'quotation' | 'proforma', status? }  Quotation / Proforma register
 *   'documents.quotation.status'    { id }  (dialog) accept / reject / open again
 *   'documents.recurring'           Recurring voucher templates
 *   'documents.recurring.form'      { id? | sourceVoucherId? }  create / alter a template
 *   'documents.recurring.due'       Due recurring vouchers: review, then post (also the Gateway notice)
 *   'documents.billsPending'        { kind?: 'sales' | 'purchase', partyLedgerId? }  Sales / Purchase Bills Pending
 *   'documents.order.preclose'      { orderId, kind?, itemId? }  (dialog) pre-close an order's balance
 *   'documents.scenarios'           Scenario masters
 *   'documents.budgets'             Budget masters
 *   'documents.budget.form'         { id? }  create / alter a budget
 *   'documents.budget.variance'     { budgetId? }  Budget vs actual
 *
 * Quotation / Proforma Invoice entry is the vouchers module's 'vouchers.entry' (Gateway › Transactions,
 * F10, Go To). Extension points used: gatewayNotices (recurring due on company open), dashboardCards
 * (documents card) and voucherPanels (links + Alt+V / Alt+O convert, Alt+S status, Alt+R make
 * recurring, Alt+L pre-close on 'vouchers.view'). The scenario picker and budget column of the Trial
 * Balance / P&L / Balance Sheet live in the reports module (reports/overlay.tsx).
 */
import { lazyScreen } from '../../app/lazyScreen.tsx';
import type { ModuleDef } from '../../app/registry.ts';
import { DocumentsCard, RecurringDueNotice, VoucherDocumentsPanel } from './components.tsx';
import { BillsPendingScreen, OrderPrecloseDialog } from './PendingScreens.tsx';
import { DocumentStatusDialog, QuotationsScreen } from './QuotationsScreen.tsx';

// Screens load on first open (app/lazyScreen.tsx, docs/ARCHITECTURE.md §9a); everything else here stays eager.
const BudgetFormScreen = lazyScreen(() => import('./PlanningScreens.tsx').then((m) => m.BudgetFormScreen));
const BudgetListScreen = lazyScreen(() => import('./PlanningScreens.tsx').then((m) => m.BudgetListScreen));
const BudgetVarianceScreen = lazyScreen(() => import('./PlanningScreens.tsx').then((m) => m.BudgetVarianceScreen));
const ScenarioListScreen = lazyScreen(() => import('./PlanningScreens.tsx').then((m) => m.ScenarioListScreen));
const RecurringDueScreen = lazyScreen(() => import('./RecurringScreens.tsx').then((m) => m.RecurringDueScreen));
const RecurringFormScreen = lazyScreen(() => import('./RecurringScreens.tsx').then((m) => m.RecurringFormScreen));
const RecurringListScreen = lazyScreen(() => import('./RecurringScreens.tsx').then((m) => m.RecurringListScreen));

export const documentsModule: ModuleDef = {
  id: 'documents',
  screens: [
    { id: 'documents.quotations', title: 'Quotation Register', component: QuotationsScreen, access: 'vouchers.view', goto: true, keywords: ['quotation', 'quote', 'estimate', 'proforma', 'pro forma', 'offer', 'conversion'] },
    { id: 'documents.quotation.status', title: 'Quotation Status', component: DocumentStatusDialog, access: 'vouchers.alter', presentation: 'dialog' },
    { id: 'documents.recurring', title: 'Recurring Vouchers', component: RecurringListScreen, access: 'vouchers.view', goto: true, keywords: ['recurring', 'repeat', 'schedule', 'rent', 'retainer', 'amc', 'emi', 'standing instruction'] },
    { id: 'documents.recurring.form', title: 'Recurring Voucher', component: RecurringFormScreen, access: 'vouchers.create' },
    { id: 'documents.recurring.due', title: 'Due Recurring Vouchers', component: RecurringDueScreen, access: 'vouchers.view', goto: true, keywords: ['recurring due', 'post recurring', 'rent due'] },
    { id: 'documents.billsPending', title: 'Bills Pending', component: BillsPendingScreen, access: 'reports.view', feature: 'inventory', goto: true, keywords: ['unbilled', 'challan', 'delivery note', 'receipt note', 'uninvoiced', 'bills pending'] },
    { id: 'documents.order.preclose', title: 'Pre-close Order', component: OrderPrecloseDialog, access: 'vouchers.alter', feature: 'orderProcessing', presentation: 'dialog' },
    { id: 'documents.scenarios', title: 'Scenarios', component: ScenarioListScreen, access: 'masters.view', goto: true, keywords: ['scenario', 'provisional', 'memorandum', 'reversing journal', 'what if'] },
    { id: 'documents.budgets', title: 'Budgets', component: BudgetListScreen, access: 'masters.view', goto: true, keywords: ['budget', 'target', 'plan'] },
    { id: 'documents.budget.form', title: 'Budget', component: BudgetFormScreen, access: 'masters.view' },
    { id: 'documents.budget.variance', title: 'Budget Variance', component: BudgetVarianceScreen, access: 'reports.financial', goto: true, keywords: ['budget vs actual', 'variance', 'budget report'] },
  ],
  menu: [
    { section: 'transactions', label: 'Due Recurring Vouchers', screen: 'documents.recurring.due', order: 90, description: 'Review and post rent, retainers and other repeating vouchers' },
    { section: 'masters', label: 'Recurring Vouchers', screen: 'documents.recurring', order: 80, description: 'Vouchers you post on a schedule (monthly, quarterly, every N days)' },
    { section: 'masters', label: 'Budgets', screen: 'documents.budgets', order: 82, description: 'Budgets for groups, ledgers and cost centres' },
    { section: 'masters', label: 'Scenarios', screen: 'documents.scenarios', order: 83, description: 'Provisional reports with memorandum and reversing journals' },
    { section: 'reports', label: 'Quotation Register', screen: 'documents.quotations', order: 70, description: 'Quotations and proforma invoices: status, validity and conversion rate' },
    { section: 'reports', label: 'Budget Variance', screen: 'documents.budget.variance', order: 72, description: 'Budget against actual for each budget line' },
    { section: 'inventory_reports', label: 'Sales Bills Pending', screen: 'documents.billsPending', params: { kind: 'sales' }, order: 52, description: 'Delivery notes not yet invoiced' },
    { section: 'inventory_reports', label: 'Purchase Bills Pending', screen: 'documents.billsPending', params: { kind: 'purchase' }, order: 53, description: 'Receipt notes whose bills are not yet entered' },
  ],
  gatewayNotices: [RecurringDueNotice],
  dashboardCards: [DocumentsCard],
  voucherPanels: [VoucherDocumentsPanel],
};
