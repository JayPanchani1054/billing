/**
 * Cheques renderer module (print group; core: src/core/modules/cheques, README there). Payee bank
 * details and bulk e-payment files work always; cheque books, the leaf register, layouts and cheque
 * printing need F11 › Cheque printing. Every screen is in the Gateway (Masters / Banking) and Go To.
 *
 * Screens (params):
 *   cheques.payees                                Payee Bank Details (list)
 *   cheques.payee.form    { ledgerId? }           bank account of one party / expense ledger
 *   cheques.books         { bankLedgerId? }       Cheque Books
 *   cheques.book.form     { bankLedgerId?, id? }  cheque book creation / alteration
 *   cheques.bank          { bankLedgerId? }       Cheque Printing Settings of a bank (layout, A/c Payee, signatory)
 *   cheques.layouts                               Cheque Layouts
 *   cheques.layout.form   { id?, preset? }        layout editor with live preview and calibration print
 *   cheques.register      { bankLedgerId?, bookId?, status? }  Cheque Leaf Register
 *   cheques.print         { voucherIds? }         Print Cheques (single from Alt+K on a Payment / Contra, or bulk)
 *   cheques.epayments     { bankLedgerId? }       E-payment File (bulk NEFT / RTGS / IMPS CSV)
 * Voucher view: Alt+K Print cheque (VoucherChequePanel). Go To also finds payees by ledger / beneficiary name or A/c no.
 */
import './cheques.css';
import { api } from '../../app/api.ts';
import { registerGotoProvider } from '../../app/lib/goto.ts';
import { lazyScreen } from '../../app/lazyScreen.tsx';
import type { ModuleDef } from '../../app/registry.ts';
import { VoucherChequePanel } from './VoucherChequePanel.tsx';

// Screens load on first open (app/lazyScreen.tsx, docs/ARCHITECTURE.md §9a); everything else here stays eager.
const BankSettingsScreen = lazyScreen(() => import('./BookScreens.tsx').then((m) => m.BankSettingsScreen));
const ChequeBookFormScreen = lazyScreen(() => import('./BookScreens.tsx').then((m) => m.ChequeBookFormScreen));
const ChequeBooksScreen = lazyScreen(() => import('./BookScreens.tsx').then((m) => m.ChequeBooksScreen));
const EPaymentScreen = lazyScreen(() => import('./EPaymentScreen.tsx').then((m) => m.EPaymentScreen));
const ChequeLayoutFormScreen = lazyScreen(() => import('./LayoutScreens.tsx').then((m) => m.ChequeLayoutFormScreen));
const ChequeLayoutsScreen = lazyScreen(() => import('./LayoutScreens.tsx').then((m) => m.ChequeLayoutsScreen));
const PayeeFormScreen = lazyScreen(() => import('./PayeeScreens.tsx').then((m) => m.PayeeFormScreen));
const PayeeListScreen = lazyScreen(() => import('./PayeeScreens.tsx').then((m) => m.PayeeListScreen));
const PrintChequesScreen = lazyScreen(() => import('./PrintChequesScreen.tsx').then((m) => m.PrintChequesScreen));
const ChequeLeafRegisterScreen = lazyScreen(() => import('./RegisterScreen.tsx').then((m) => m.ChequeLeafRegisterScreen));

const CHQ = 'chequePrinting' as const;

export const chequesModule: ModuleDef = {
  id: 'cheques',
  screens: [
    { id: 'cheques.payees', title: 'Payee Bank Details', component: PayeeListScreen, access: 'masters.view', keywords: ['beneficiary', 'ifsc', 'bank account', 'neft', 'rtgs', 'vendor bank'] },
    { id: 'cheques.payee.form', title: 'Payee Bank Details', component: PayeeFormScreen, access: 'masters.view', keywords: ['beneficiary', 'ifsc', 'name on cheque'] },
    { id: 'cheques.books', title: 'Cheque Books', component: ChequeBooksScreen, access: 'masters.view', feature: CHQ, keywords: ['cheque book', 'leaves', 'cheque series'] },
    { id: 'cheques.book.form', title: 'Cheque Book', component: ChequeBookFormScreen, access: 'masters.view', feature: CHQ },
    { id: 'cheques.bank', title: 'Cheque Printing Settings', component: BankSettingsScreen, access: 'masters.view', feature: CHQ, keywords: ['signatory', 'a/c payee', 'crossing', 'cheque layout'] },
    { id: 'cheques.layouts', title: 'Cheque Layouts', component: ChequeLayoutsScreen, access: 'masters.view', feature: CHQ, keywords: ['cheque format', 'cts-2010', 'calibration', 'cheque printing'] },
    { id: 'cheques.layout.form', title: 'Cheque Layout', component: ChequeLayoutFormScreen, access: 'masters.view', feature: CHQ, keywords: ['calibration', 'cts-2010'] },
    { id: 'cheques.register', title: 'Cheque Leaf Register', component: ChequeLeafRegisterScreen, access: 'reports.view', feature: CHQ, keywords: ['cheque book', 'unused cheques', 'cancelled cheques', 'stale', 'spoilt'] },
    { id: 'cheques.print', title: 'Print Cheques', component: PrintChequesScreen, access: 'vouchers.view', feature: CHQ, keywords: ['cheque printing', 'bulk cheques', 'cheque writer'] },
    { id: 'cheques.epayments', title: 'E-payment File', component: EPaymentScreen, access: 'vouchers.view', keywords: ['bulk payment', 'neft', 'rtgs', 'imps', 'bank upload', 'vendor payments'] },
  ],
  menu: [
    { section: 'masters', label: 'Payee Bank Details', screen: 'cheques.payees', order: 20, keywords: ['beneficiary', 'ifsc'], description: 'Bank accounts of suppliers and other payees, for transfers and cheques' },
    { section: 'masters', label: 'Cheque Books', screen: 'cheques.books', order: 21, feature: CHQ, description: 'Leaf ranges per bank; payments take the next leaf' },
    { section: 'masters', label: 'Cheque Layouts', screen: 'cheques.layouts', order: 22, feature: CHQ, description: 'Where the date, payee and amount go on each bank’s leaf' },
    { section: 'masters', label: 'Cheque Printing Settings', screen: 'cheques.bank', order: 23, feature: CHQ, description: 'Layout, A/c Payee crossing and signatory per bank' },
    { section: 'banking', label: 'Print Cheques', screen: 'cheques.print', order: 52, feature: CHQ, keywords: ['cheque printing'], description: 'Print the cheques of payments, one or many at a time' },
    { section: 'banking', label: 'Cheque Leaf Register', screen: 'cheques.register', order: 54, feature: CHQ, keywords: ['cheque book register'], description: 'Every leaf: issued, cleared, stale, cancelled, unused' },
    { section: 'banking', label: 'E-payment File', screen: 'cheques.epayments', order: 80, keywords: ['bulk payment', 'neft', 'rtgs'], description: 'Bulk NEFT / RTGS / IMPS file of payments for net banking' },
  ],
  voucherPanels: [VoucherChequePanel],
};

// Go To: "supreme bank" → the bank details of that payee (ledgers that already have some).
registerGotoProvider({
  id: 'cheques.payees',
  label: 'Payee bank details',
  minQuery: 2,
  screens: ['cheques.payee.form'],
  search: async (q) => {
    const res = await api('cheques.payee.list', { search: q.trim(), withDetails: true, limit: 5 });
    return res.rows.map((r) => ({
      id: `payee:${r.ledgerId}`,
      label: `Bank details: ${r.ledgerName}`,
      group: 'Payee bank details',
      description: [r.bankName, r.accountNo ? `A/c ${r.accountNo}` : null, r.ifsc].filter(Boolean).join(' · ') || r.groupName,
      screen: 'cheques.payee.form',
      params: { ledgerId: r.ledgerId },
    }));
  },
});
