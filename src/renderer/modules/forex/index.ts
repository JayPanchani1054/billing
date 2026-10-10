/**
 * Multi-currency renderer module (core: src/core/modules/forex). Everything here needs F11 ›
 * Multiple currencies (`feature: 'multiCurrency'`): menus and Go To hide it while the feature is off,
 * so the UI stays clean. Voucher entry's foreign-currency fields (Alt+Y), dialogs and side panel
 * (ForexDialogs.tsx, EntryPanel.tsx) are rendered by the vouchers module; the voucher view panel
 * (VoucherPanel.tsx) through ModuleDef.voucherPanels; the printed foreign-currency block
 * (PrintBlock.tsx) by the print templates.
 */
import { lazyScreen } from '../../app/lazyScreen.tsx';
import type { ModuleDef } from '../../app/registry.ts';
import { ForexVoucherPanel } from './VoucherPanel.tsx';
import './forex.css';

// Screens load on first open (app/lazyScreen.tsx, docs/ARCHITECTURE.md §9a); everything else here stays eager.
const LedgerScreen = lazyScreen(() => import('./LedgerScreen.tsx').then((m) => m.LedgerScreen));
const OpeningScreen = lazyScreen(() => import('./OpeningScreen.tsx').then((m) => m.OpeningScreen));
const OutstandingScreen = lazyScreen(() => import('./OutstandingScreen.tsx').then((m) => m.OutstandingScreen));
const RevaluationScreen = lazyScreen(() => import('./RevaluationScreen.tsx').then((m) => m.RevaluationScreen));
const SettingsScreen = lazyScreen(() => import('./SettingsScreen.tsx').then((m) => m.SettingsScreen));

const FX = 'multiCurrency' as const;

export const forexModule: ModuleDef = {
  id: 'forex',
  screens: [
    { id: 'forex.settings', title: 'Multi-currency Settings', component: SettingsScreen, access: 'masters.view', feature: FX, keywords: ['forex', 'exchange gain', 'exchange loss', 'foreign currency'] },
    { id: 'forex.outstanding', title: 'Forex Outstanding', component: OutstandingScreen, access: 'reports.view', feature: FX, keywords: ['foreign currency', 'export receivable', 'import payable', 'usd', 'bill-wise'] },
    { id: 'forex.ledger', title: 'Ledger in Foreign Currency', component: LedgerScreen, access: 'reports.view', feature: FX, keywords: ['forex', 'both currencies', 'party statement'] },
    { id: 'forex.revaluation', title: 'Forex Revaluation', component: RevaluationScreen, access: 'reports.view', feature: FX, keywords: ['unrealised', 'exchange gain', 'exchange loss', 'closing rate', 'forex adjustment', 'as 11', 'ind as 21'] },
    { id: 'forex.opening', title: 'Opening Balance in Currency', component: OpeningScreen, access: 'masters.view', feature: FX, keywords: ['opening balance', 'foreign currency', 'opening bills'] },
  ],
  menu: [
    { section: 'masters', label: 'Multi-currency Settings', screen: 'forex.settings', order: 19, feature: FX, description: 'Exchange gain / loss ledgers and the revaluation rate' },
    { section: 'masters', label: 'Opening Balance in Currency', screen: 'forex.opening', order: 19.5, feature: FX, description: 'Opening balance and opening bills of a ledger kept in a foreign currency' },
    { section: 'reports', label: 'Forex Outstanding', screen: 'forex.outstanding', order: 50, feature: FX, description: 'Bills in foreign currencies with booked and closing rates' },
    { section: 'reports', label: 'Ledger in Foreign Currency', screen: 'forex.ledger', order: 51, feature: FX, description: 'A party or bank kept in a foreign currency, in both currencies' },
    { section: 'reports', label: 'Forex Revaluation', screen: 'forex.revaluation', order: 52, feature: FX, description: 'Unrealised exchange gain / loss at the closing rate; post the adjustment journal' },
  ],
  voucherPanels: [ForexVoucherPanel],
};
