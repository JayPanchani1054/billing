/**
 * GST module: returns (GSTR-1, GSTR-3B, GSTR-9; CMP-08 and GSTR-4 for composition taxpayers),
 * registers and analysis (HSN, sales / purchase register, ITC, exceptions), compliance files
 * (e-invoice, e-way bill), GST set-off with challans and the electronic cash / credit ledgers,
 * advances (Table 11), bills of entry, filing status and GSTR-1 amendments. Every screen needs GST
 * turned on (gstOnly); reads need gst.view, files and manual entries need gst.file (checked per action).
 * Menu items marked `gstRegistrations` show only for that registration type (composition vs regular).
 */
import { lazyScreen } from '../../app/lazyScreen.tsx';
import type { ModuleDef } from '../../app/registry.ts';
import { CompositionCard } from './CompositionCard.tsx';
import { VoucherGstPanel } from './VoucherGstPanel.tsx';
import './gst.css';

// Screens load on first open (app/lazyScreen.tsx, docs/ARCHITECTURE.md §9a); everything else here stays eager.
const EinvoiceScreen = lazyScreen(() => import('./EinvoiceScreen.tsx').then((m) => m.EinvoiceScreen));
const EwaybillScreen = lazyScreen(() => import('./EwaybillScreen.tsx').then((m) => m.EwaybillScreen));
const Gstr1Screen = lazyScreen(() => import('./Gstr1Screen.tsx').then((m) => m.Gstr1Screen));
const Gstr1SectionScreen = lazyScreen(() => import('./Gstr1SectionScreen.tsx').then((m) => m.Gstr1SectionScreen));
const Gstr3bScreen = lazyScreen(() => import('./Gstr3bScreen.tsx').then((m) => m.Gstr3bScreen));
const Gstr9Screen = lazyScreen(() => import('./Gstr9Screen.tsx').then((m) => m.Gstr9Screen));
const AdvancesScreen = lazyScreen(() => import('./AdvancesBoeScreens.tsx').then((m) => m.AdvancesScreen));
const BoeScreen = lazyScreen(() => import('./AdvancesBoeScreens.tsx').then((m) => m.BoeScreen));
const Cmp08Screen = lazyScreen(() => import('./CompositionScreens.tsx').then((m) => m.Cmp08Screen));
const CompositionRatesScreen = lazyScreen(() => import('./CompositionScreens.tsx').then((m) => m.CompositionRatesScreen));
const Gstr4Screen = lazyScreen(() => import('./CompositionScreens.tsx').then((m) => m.Gstr4Screen));
const AmendmentsScreen = lazyScreen(() => import('./FilingScreens.tsx').then((m) => m.AmendmentsScreen));
const FilingsScreen = lazyScreen(() => import('./FilingScreens.tsx').then((m) => m.FilingsScreen));
const Gstr3bChangesScreen = lazyScreen(() => import('./GapsScreens.tsx').then((m) => m.Gstr3bChangesScreen));
const Rule37Screen = lazyScreen(() => import('./GapsScreens.tsx').then((m) => m.Rule37Screen));
const CashLedgerScreen = lazyScreen(() => import('./LedgerScreens.tsx').then((m) => m.CashLedgerScreen));
const CreditLedgerScreen = lazyScreen(() => import('./LedgerScreens.tsx').then((m) => m.CreditLedgerScreen));
const SetoffScreen = lazyScreen(() => import('./SetoffScreen.tsx').then((m) => m.SetoffScreen));
const GstExceptionsScreen = lazyScreen(() => import('./RegisterScreens.tsx').then((m) => m.GstExceptionsScreen));
const GstRegisterScreen = lazyScreen(() => import('./RegisterScreens.tsx').then((m) => m.GstRegisterScreen));
const HsnSummaryScreen = lazyScreen(() => import('./RegisterScreens.tsx').then((m) => m.HsnSummaryScreen));
const ItcScreen = lazyScreen(() => import('./RegisterScreens.tsx').then((m) => m.ItcScreen));

export const gstModule: ModuleDef = {
  id: 'gst',
  screens: [
    { id: 'gst.gstr1', title: 'GSTR-1', component: Gstr1Screen, access: 'gst.view', gstOnly: true, keywords: ['gstr1', 'outward', 'sales return', 'b2b', 'b2c', 'json', 'portal'] },
    { id: 'gst.gstr1.section', title: 'GSTR-1 Table', component: Gstr1SectionScreen, access: 'gst.view', gstOnly: true },
    { id: 'gst.gstr3b', title: 'GSTR-3B', component: Gstr3bScreen, access: 'gst.view', gstOnly: true, keywords: ['gstr3b', 'summary return', 'itc', 'set off', 'cash', 'payment', 'json'] },
    { id: 'gst.gstr9', title: 'GSTR-9', component: Gstr9Screen, access: 'gst.view', gstOnly: true, keywords: ['gstr9', 'annual return', 'yearly'] },
    { id: 'gst.hsn', title: 'HSN/SAC Summary', component: HsnSummaryScreen, access: 'gst.view', gstOnly: true, keywords: ['hsn', 'sac', 'table 12', 'uqc'] },
    { id: 'gst.register', title: 'GST Register', component: GstRegisterScreen, access: 'gst.view', gstOnly: true, keywords: ['sales register', 'purchase register', 'gst register'] },
    { id: 'gst.itc', title: 'Input Tax Credit', component: ItcScreen, access: 'gst.view', gstOnly: true, keywords: ['itc', 'input credit', 'blocked credit', '17(5)'] },
    { id: 'gst.exceptions', title: 'GST Exceptions', component: GstExceptionsScreen, access: 'gst.view', gstOnly: true, keywords: ['uncertain transactions', 'errors', 'mismatch', 'gstin', 'hsn missing'] },
    { id: 'gst.einvoice', title: 'e-Invoice', component: EinvoiceScreen, access: 'gst.view', gstOnly: true, feature: 'einvoice', keywords: ['irn', 'irp', 'einvoice', 'qr code'] },
    { id: 'gst.ewaybill', title: 'e-Way Bills', component: EwaybillScreen, access: 'gst.view', gstOnly: true, feature: 'ewayBill', keywords: ['eway', 'ewb', 'transport', 'vehicle'] },
    // GST plus: set-off, electronic ledgers, composition returns, advances, imports, filing status.
    { id: 'gst.setoff', title: 'GST Set-off', component: SetoffScreen, access: 'gst.view', gstOnly: true, keywords: ['set off', 'setoff', 'challan', 'pmt-06', 'cpin', 'payment', 'utilisation', 'rule 88a', 'stat adjustment'] },
    { id: 'gst.ledger.cash', title: 'Electronic Cash Ledger', component: CashLedgerScreen, access: 'gst.view', gstOnly: true, keywords: ['cash ledger', 'challan', 'deposit', 'pmt-06'] },
    { id: 'gst.ledger.credit', title: 'Electronic Credit Ledger', component: CreditLedgerScreen, access: 'gst.view', gstOnly: true, keywords: ['credit ledger', 'itc', 'reversal', 'rule 42', 'rule 43', 'rule 37'] },
    { id: 'gst.cmp08', title: 'CMP-08', component: Cmp08Screen, access: 'gst.view', gstOnly: true, keywords: ['cmp08', 'composition', 'quarterly statement', 'self-assessed tax'] },
    { id: 'gst.gstr4', title: 'GSTR-4', component: Gstr4Screen, access: 'gst.view', gstOnly: true, keywords: ['gstr4', 'composition', 'annual return'] },
    { id: 'gst.composition', title: 'Composition Rates', component: CompositionRatesScreen, access: 'gst.view', gstOnly: true, keywords: ['composition', 'rate', 'category', 'rule 7'] },
    { id: 'gst.advances', title: 'Advances (GST)', component: AdvancesScreen, access: 'gst.view', gstOnly: true, keywords: ['advance', 'table 11', '11a', '11b', 'advance receipt', 'refund voucher'] },
    { id: 'gst.boe', title: 'Bills of Entry', component: BoeScreen, access: 'gst.view', gstOnly: true, keywords: ['bill of entry', 'boe', 'import', 'customs', 'impg', 'icegate', '4(a)(1)'] },
    { id: 'gst.amendments', title: 'GSTR-1 Amendments', component: AmendmentsScreen, access: 'gst.view', gstOnly: true, keywords: ['amendment', '9a', '9c', 'b2ba', 'cdnra', 'filed'] },
    { id: 'gst.gstr3b.changes', title: 'Changes after GSTR-3B Filing', component: Gstr3bChangesScreen, access: 'gst.view', gstOnly: true, keywords: ['gstr3b', 'filed', 'changed after filing', 'late purchase', 'itc', 'amendment'] },
    { id: 'gst.rule37', title: 'Rule 37 (180 Days)', component: Rule37Screen, access: 'gst.view', gstOnly: true, keywords: ['rule 37', '180 days', 'unpaid', 'itc reversal', 'reclaim', '16(2)', 'interest'] },
    { id: 'gst.filings', title: 'Return Filing Status', component: FilingsScreen, access: 'gst.view', gstOnly: true, keywords: ['filed', 'arn', 'filing status', 'mark filed'] },
  ],
  menu: [
    { section: 'gst', label: 'GSTR-1', screen: 'gst.gstr1', order: 10, gstRegistrations: ['regular'], description: 'Sales return for the month or quarter — tables, checks and JSON' },
    { section: 'gst', label: 'GSTR-3B', screen: 'gst.gstr3b', order: 20, gstRegistrations: ['regular'], description: 'Summary return — tax payable, ITC set-off and cash to pay' },
    { section: 'gst', label: 'CMP-08', screen: 'gst.cmp08', order: 11, gstRegistrations: ['composition'], description: 'Composition: quarterly statement of tax on turnover and reverse charge' },
    { section: 'gst', label: 'GSTR-4', screen: 'gst.gstr4', order: 21, gstRegistrations: ['composition'], description: 'Composition: annual return prepared from the books' },
    { section: 'gst', label: 'GST Set-off', screen: 'gst.setoff', order: 25, description: 'Use credit and cash to pay the return, record challans, post the set-off' },
    { section: 'gst', label: 'Electronic Cash Ledger', screen: 'gst.ledger.cash', order: 26, description: 'Challan deposits and their use, by major and minor head' },
    { section: 'gst', label: 'Electronic Credit Ledger', screen: 'gst.ledger.credit', order: 27, gstRegistrations: ['regular'], description: 'ITC booked, reversed and used, by head' },
    { section: 'gst', label: 'Advances (GST)', screen: 'gst.advances', order: 85, gstRegistrations: ['regular'], description: 'Tax on advances received and adjusted — GSTR-1 Table 11' },
    { section: 'gst', label: 'Bills of Entry', screen: 'gst.boe', order: 86, description: 'Imports of goods: IGST paid at customs, reconciled with GSTR-2B' },
    { section: 'gst', label: 'GSTR-1 Amendments', screen: 'gst.amendments', order: 87, gstRegistrations: ['regular'], description: 'Documents changed after their GSTR-1 was filed (9A / 9C / 10)' },
    { section: 'gst', label: 'Changes after GSTR-3B Filing', screen: 'gst.gstr3b.changes', order: 88, gstRegistrations: ['regular'], description: 'Vouchers changed after their GSTR-3B was filed, reported in the next GSTR-3B' },
    { section: 'gst', label: 'Rule 37 (180 Days)', screen: 'gst.rule37', order: 89, gstRegistrations: ['regular'], description: 'Purchases not paid within 180 days: credit to reverse, and to reclaim once paid' },
    { section: 'gst', label: 'Return Filing Status', screen: 'gst.filings', order: 95, description: 'Returns marked filed, with date and ARN' },
    { section: 'gst', label: 'Composition Rates', screen: 'gst.composition', order: 96, gstRegistrations: ['composition'], description: 'Your composition category and the effective-dated rates' },
    { section: 'gst', label: 'GST Exceptions', screen: 'gst.exceptions', order: 30, description: 'Entries to fix before filing' },
    { section: 'gst', label: 'e-Invoice', screen: 'gst.einvoice', order: 40, gstRegistrations: ['regular'], description: 'Generate e-invoice JSON and record IRNs' },
    { section: 'gst', label: 'e-Way Bills', screen: 'gst.ewaybill', order: 50, description: 'Invoices that need an e-way bill and their numbers' },
    { section: 'gst', label: 'GST Register', screen: 'gst.register', order: 60, description: 'Sales and purchases with their GST, one line per document' },
    { section: 'gst', label: 'HSN/SAC Summary', screen: 'gst.hsn', order: 70, description: 'Supplies by HSN/SAC code and rate' },
    { section: 'gst', label: 'Input Tax Credit', screen: 'gst.itc', order: 80, gstRegistrations: ['regular'], description: 'ITC by supplier: eligible, blocked, reverse charge, imports' },
    { section: 'gst', label: 'GSTR-9', screen: 'gst.gstr9', order: 90, gstRegistrations: ['regular'], description: 'Annual summary prepared from the books' },
  ],
  dashboardCards: [CompositionCard],
  voucherPanels: [VoucherGstPanel],
};
