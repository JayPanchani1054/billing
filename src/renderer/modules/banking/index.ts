/**
 * Banking module (Gateway section "Banking"): bank reconciliation, statement import and matching, cheque
 * register, post-dated cheques, deposit slip and the bank overview. Core: src/core/modules/banking/README.md.
 *
 * Screens (params):
 *   banking.summary                                   Bank overview
 *   banking.brs          { ledgerId? }                Bank reconciliation (bank-date entry grid)
 *   banking.import       { ledgerId? }                Statement import wizard
 *   banking.match        { ledgerId?, batchId?, autorun? }   Auto-match review / vouchers from lines
 *   banking.cheques      { ledgerId? }                Cheque register
 *   banking.pdc          { ledgerId? }                Post-dated cheques
 *   banking.depositSlip  { ledgerId?, date? }         Deposit (pay-in) slip
 */
import './banking.css';
import { api } from '../../app/api.ts';
import { registerGotoProvider } from '../../app/lib/goto.ts';
import type { ModuleDef } from '../../app/registry.ts';
import { todayLocal } from '../../../shared/dates.ts';
import { BrsScreen } from './BrsScreen.tsx';
import { DepositSlipScreen } from './DepositSlipScreen.tsx';
import { ImportScreen } from './ImportScreen.tsx';
import { MatchScreen } from './MatchScreen.tsx';
import { ChequeRegisterScreen, PdcScreen } from './RegisterScreens.tsx';
import { SummaryScreen } from './SummaryScreen.tsx';

export const bankingModule: ModuleDef = {
  id: 'banking',
  screens: [
    { id: 'banking.summary', title: 'Bank Overview', component: SummaryScreen, access: 'reports.view', keywords: ['banks', 'bank balance', 'accounts'] },
    { id: 'banking.brs', title: 'Bank Reconciliation', component: BrsScreen, access: 'reports.view', keywords: ['brs', 'bank date', 'reconcile'] },
    { id: 'banking.import', title: 'Import Bank Statement', component: ImportScreen, access: 'banking.reconcile', keywords: ['statement', 'csv', 'excel', 'upload'] },
    { id: 'banking.match', title: 'Match Bank Statement', component: MatchScreen, access: 'banking.reconcile', keywords: ['auto match', 'auto reconcile', 'statement'] },
    { id: 'banking.cheques', title: 'Cheque Register', component: ChequeRegisterScreen, access: 'reports.view', keywords: ['cheque', 'check', 'dd', 'stale'] },
    { id: 'banking.pdc', title: 'Post-dated Cheques', component: PdcScreen, access: 'reports.view', keywords: ['pdc', 'post dated', 'cheque'] },
    { id: 'banking.depositSlip', title: 'Deposit Slip', component: DepositSlipScreen, access: 'reports.view', keywords: ['pay-in slip', 'paying slip', 'challan', 'deposit'] },
  ],
  menu: [
    { section: 'banking', label: 'Bank Reconciliation', screen: 'banking.brs', order: 10, keywords: ['brs'], description: 'Enter bank dates and see books vs bank balance' },
    { section: 'banking', label: 'Import Statement', screen: 'banking.import', order: 20, description: 'Read the CSV / Excel statement from net banking' },
    { section: 'banking', label: 'Match Statement', screen: 'banking.match', order: 30, description: 'Match statement lines with vouchers; create the missing ones' },
    { section: 'banking', label: 'Bank Overview', screen: 'banking.summary', order: 40, description: 'All bank accounts: books, bank and open items' },
    { section: 'banking', label: 'Cheque Register', screen: 'banking.cheques', order: 50, description: 'Cheques issued and received with clearing status' },
    { section: 'banking', label: 'Post-dated Cheques', screen: 'banking.pdc', order: 60, keywords: ['pdc'], description: 'PDCs received and issued, by due date' },
    { section: 'banking', label: 'Deposit Slip', screen: 'banking.depositSlip', order: 70, description: 'Print the pay-in slip for cheques and cash deposited' },
  ],
};

// Go To: "hdfc" → Bank Reconciliation of that bank.
registerGotoProvider({
  id: 'banking.brs',
  label: 'Bank reconciliation',
  minQuery: 2,
  screens: ['banking.brs'], // banking.summary needs reports.view: don't ask for users who can't open BRS
  search: async (q) => {
    const needle = q.trim().toLowerCase();
    const banks = await api('banking.summary', { asOf: todayLocal() });
    return banks
      .filter((b) => b.name.toLowerCase().includes(needle) || (b.bankName ?? '').toLowerCase().includes(needle) || (b.accountNo ?? '').includes(needle))
      .slice(0, 5)
      .map((b) => ({
        id: `brs:${b.id}`,
        label: `Reconcile ${b.name}`,
        group: 'Bank reconciliation',
        description: b.accountNo ? `A/c ${b.accountNo}` : 'Bank reconciliation',
        screen: 'banking.brs',
        params: { ledgerId: b.id },
      }));
  },
});
