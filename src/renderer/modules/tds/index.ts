/**
 * TDS / TCS renderer module (core: src/core/modules/tds). Everything here is hidden unless F11 ›
 * TDS or TCS is on (`anyFeature`); screens that only make sense for one kind say so when it is off.
 * Gateway section "TDS / TCS"; every screen is in Go To (Alt+G). The voucher entry panel
 * (EntryPanel.tsx) is rendered by the vouchers module.
 */
import { lazyScreen } from '../../app/lazyScreen.tsx';
import type { ModuleDef } from '../../app/registry.ts';
import { TdsVoucherPanel } from './VoucherPanel.tsx';
import { TdsDueNotice } from './notices.tsx';

// Screens load on first open (app/lazyScreen.tsx, docs/ARCHITECTURE.md §9a); everything else here stays eager.
const ChallanScreen = lazyScreen(() => import('./ChallanScreen.tsx').then((m) => m.ChallanScreen));
const LedgerFormScreen = lazyScreen(() => import('./LedgerScreens.tsx').then((m) => m.LedgerFormScreen));
const LedgersScreen = lazyScreen(() => import('./LedgerScreens.tsx').then((m) => m.LedgersScreen));
const NatureFormScreen = lazyScreen(() => import('./NatureScreens.tsx').then((m) => m.NatureFormScreen));
const NaturesScreen = lazyScreen(() => import('./NatureScreens.tsx').then((m) => m.NaturesScreen));
const ReceivableScreen = lazyScreen(() => import('./ReceivableScreen.tsx').then((m) => m.ReceivableScreen));
const ChallansScreen = lazyScreen(() => import('./ReportScreens.tsx').then((m) => m.ChallansScreen));
const ComputationScreen = lazyScreen(() => import('./ReportScreens.tsx').then((m) => m.ComputationScreen));
const ExceptionsScreen = lazyScreen(() => import('./ReportScreens.tsx').then((m) => m.ExceptionsScreen));
const LinesScreen = lazyScreen(() => import('./ReportScreens.tsx').then((m) => m.LinesScreen));
const OutstandingScreen = lazyScreen(() => import('./ReportScreens.tsx').then((m) => m.OutstandingScreen));
const ReturnScreen = lazyScreen(() => import('./ReturnScreen.tsx').then((m) => m.ReturnScreen));
const SetupScreen = lazyScreen(() => import('./SetupScreen.tsx').then((m) => m.SetupScreen));

const ANY = ['tds', 'tcs'] as const;

export const tdsModule: ModuleDef = {
  id: 'tds',
  screens: [
    { id: 'tds.setup', title: 'TDS / TCS Setup', component: SetupScreen, access: 'tds.view', anyFeature: ANY, keywords: ['tan', 'deductor', '194q'] },
    { id: 'tds.natures', title: 'Natures of Payment / Goods', component: NaturesScreen, access: 'tds.view', anyFeature: ANY, keywords: ['section', 'rate', 'threshold', '194c', '194j', '206c'] },
    { id: 'tds.nature.form', title: 'TDS / TCS Nature', component: NatureFormScreen, access: 'tds.view', anyFeature: ANY },
    { id: 'tds.ledgers', title: 'Ledger TDS / TCS Details', component: LedgersScreen, access: 'tds.view', anyFeature: ANY, keywords: ['pan', 'deductee', 'certificate', '197'] },
    { id: 'tds.ledger.form', title: 'TDS / TCS Details', component: LedgerFormScreen, access: 'tds.view', anyFeature: ANY },
    { id: 'tds.computation', title: 'TDS / TCS Computation', component: ComputationScreen, access: 'tds.view', anyFeature: ANY },
    { id: 'tds.lines', title: 'TDS / TCS Lines', component: LinesScreen, access: 'tds.view', anyFeature: ANY },
    { id: 'tds.outstanding', title: 'TDS / TCS Outstanding', component: OutstandingScreen, access: 'tds.view', anyFeature: ANY, keywords: ['payable', 'interest', '201', '234e', 'due'] },
    { id: 'tds.challans', title: 'TDS / TCS Challan Register', component: ChallansScreen, access: 'tds.view', anyFeature: ANY, keywords: ['itns 281', 'bsr'] },
    { id: 'tds.challan', title: 'TDS / TCS Challan', component: ChallanScreen, access: 'tds.view', anyFeature: ANY, keywords: ['itns 281', 'bsr', 'deposit'] },
    { id: 'tds.return', title: 'TDS / TCS Quarterly Return', component: ReturnScreen, access: 'tds.view', anyFeature: ANY, keywords: ['26q', '27q', '27eq', 'statement', 'fvu', 'rpu'] },
    { id: 'tds.receivable', title: 'TDS Receivable (26AS)', component: ReceivableScreen, access: 'tds.view', feature: 'tds', keywords: ['26as', 'ais', 'form 16a'] },
    { id: 'tds.exceptions', title: 'TDS / TCS Exceptions', component: ExceptionsScreen, access: 'tds.view', anyFeature: ANY, keywords: ['pan', 'short deduction', 'threshold'] },
  ],
  menu: [
    { section: 'tds', label: 'TDS / TCS Setup', screen: 'tds.setup', order: 10, anyFeature: ANY, description: 'TAN, person responsible, s.194Q and rounding' },
    { section: 'tds', label: 'Natures of Payment / Goods', screen: 'tds.natures', order: 11, anyFeature: ANY, description: 'Sections, rates and thresholds with dates' },
    { section: 'tds', label: 'Ledger TDS / TCS Details', screen: 'tds.ledgers', order: 12, anyFeature: ANY, description: 'Deductees, PAN, certificates; TDS on expenses, TCS on sales' },
    { section: 'tds', label: 'Create TDS / TCS Challan', screen: 'tds.challan', order: 20, anyFeature: ANY, description: 'Record the tax you deposited (ITNS 281)' },
    { section: 'tds', label: 'TDS / TCS Computation', screen: 'tds.computation', order: 30, anyFeature: ANY, description: 'Deducted / collected per party and section' },
    { section: 'tds', label: 'TDS / TCS Outstanding', screen: 'tds.outstanding', order: 31, anyFeature: ANY, description: 'Not yet deposited, due dates, interest and late fee' },
    { section: 'tds', label: 'TDS / TCS Challan Register', screen: 'tds.challans', order: 32, anyFeature: ANY, description: 'Challans paid and what they cleared' },
    { section: 'tds', label: 'Quarterly Return (26Q / 27Q / 27EQ)', screen: 'tds.return', order: 33, anyFeature: ANY, description: 'Deductee and challan rows; CSV files for filing' },
    { section: 'tds', label: 'TDS / TCS Exceptions', screen: 'tds.exceptions', order: 34, anyFeature: ANY, description: 'Missing PAN, thresholds crossed, short deduction' },
    { section: 'tds', label: 'TDS Receivable vs 26AS', screen: 'tds.receivable', order: 40, feature: 'tds', description: 'Tax your customers deducted, matched with Form 26AS' },
  ],
  voucherPanels: [TdsVoucherPanel],
  gatewayNotices: [TdsDueNotice],
};
