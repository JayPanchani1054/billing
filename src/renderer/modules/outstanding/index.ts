/**
 * Outstanding module (Tally "Statements of Accounts › Outstandings"): receivables / payables
 * (party-wise, bill-wise, ageing), party outstanding with bill history, statement of account,
 * interest on overdue bills and payment reminder letters; plus the dashboard's <DueSoonWidget>.
 * See ./README.md.
 */
import type { ModuleDef } from '../../app/registry.ts';
import { InterestScreen } from './InterestScreen.tsx';
import { PayablesScreen, ReceivablesScreen } from './OutstandingReport.tsx';
import { PartyScreen } from './PartyScreen.tsx';
import { RemindersScreen } from './RemindersScreen.tsx';
import { StatementScreen } from './StatementScreen.tsx';
import './outstanding.css';

export { DueSoonWidget } from './DueSoon.tsx';
export type { DueSoonWidgetProps } from './DueSoon.tsx';

export const outstandingModule: ModuleDef = {
  id: 'outstanding',
  screens: [
    {
      id: 'outstanding.receivables',
      title: 'Receivables',
      component: ReceivablesScreen,
      access: 'reports.view',
      keywords: ['receivables', 'debtors', 'bills receivable', 'customers', 'outstanding', 'ageing', 'overdue', 'credit limit'],
    },
    {
      id: 'outstanding.payables',
      title: 'Payables',
      component: PayablesScreen,
      access: 'reports.view',
      keywords: ['payables', 'creditors', 'bills payable', 'suppliers', 'outstanding', 'ageing', 'overdue'],
    },
    { id: 'outstanding.party', title: 'Party Outstanding', component: PartyScreen, access: 'reports.view', keywords: ['ledger outstanding', 'bill-wise', 'pending bills'] },
    {
      id: 'outstanding.statement',
      title: 'Statement of Account',
      component: StatementScreen,
      access: 'reports.view',
      goto: true,
      keywords: ['statement', 'account statement', 'confirmation of balance', 'soa'],
    },
    {
      id: 'outstanding.interest',
      title: 'Interest Calculation',
      component: InterestScreen,
      access: 'reports.view',
      goto: true,
      keywords: ['interest', 'overdue interest', 'msme', 'late payment'],
    },
    {
      id: 'outstanding.reminders',
      title: 'Payment Reminders',
      component: RemindersScreen,
      access: 'reports.view',
      goto: true,
      keywords: ['reminder', 'reminder letter', 'dunning', 'follow up', 'collection', 'overdue'],
    },
  ],
  menu: [
    {
      section: 'reports',
      label: 'Receivables',
      screen: 'outstanding.receivables',
      order: 60,
      keywords: ['receivables', 'debtors', 'bills receivable', 'outstanding', 'customers'],
      description: 'What customers owe you, party-wise and bill-wise',
    },
    {
      section: 'reports',
      label: 'Payables',
      screen: 'outstanding.payables',
      order: 61,
      keywords: ['payables', 'creditors', 'bills payable', 'outstanding', 'suppliers'],
      description: 'What you owe suppliers, party-wise and bill-wise',
    },
    {
      section: 'reports',
      label: 'Ageing Analysis',
      screen: 'outstanding.receivables',
      params: { view: 'ageing' },
      order: 62,
      keywords: ['ageing', 'aging', 'age-wise', 'debtors ageing', 'receivables ageing'],
      description: 'Receivables split by how long they have been due',
    },
    {
      section: 'reports',
      label: 'Overdue Bills',
      screen: 'outstanding.receivables',
      params: { view: 'bills', overdueOnly: true },
      order: 63,
      keywords: ['overdue', 'past due', 'late payments', 'debtors'],
      description: 'Customer bills past their due date',
    },
    {
      section: 'reports',
      label: 'Statement of Account',
      screen: 'outstanding.statement',
      order: 64,
      keywords: ['statement', 'account statement', 'confirmation', 'soa'],
      description: 'Printable statement for a customer or supplier',
    },
    {
      section: 'reports',
      label: 'Interest Calculation',
      screen: 'outstanding.interest',
      order: 65,
      keywords: ['interest', 'overdue interest', 'msme'],
      description: 'Interest on late payments, bill by bill',
    },
    {
      section: 'reports',
      label: 'Payment Reminders',
      screen: 'outstanding.reminders',
      order: 66,
      keywords: ['reminder', 'reminder letter', 'overdue', 'collection'],
      description: 'Reminder letters for customers with overdue bills',
    },
  ],
};
