/**
 * POS / counter billing renderer module (core: src/core/modules/pos). Everything here needs F11 ›
 * POS invoicing (`feature: 'pos'`): menus and Go To hide it while the feature is off.
 *
 * Screens: the POS counter (scan, split tender, change, hold / recall, reprint, receipt printing),
 * return / exchange from a bill, the day-end summary and POS settings (tender modes). Extension
 * points used: voucherPanels (tenders of a POS bill on 'vouchers.view' + Alt+T return); the print
 * templates render PosPrintBlock ("Paid by", cash tendered, change); 'vouchers.entry' hands POS
 * voucher types over to 'pos.counter'.
 */
import type { ModuleDef } from '../../app/registry.ts';
import { CounterScreen } from './CounterScreen.tsx';
import { ReturnScreen } from './ReturnScreen.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';
import { SummaryScreen } from './SummaryScreen.tsx';
import { PosVoucherPanel } from './VoucherPanel.tsx';
import './pos.css';

const POS = 'pos' as const;

export const posModule: ModuleDef = {
  id: 'pos',
  screens: [
    {
      id: 'pos.counter',
      title: 'POS Counter',
      component: CounterScreen,
      access: 'vouchers.create',
      feature: POS,
      keywords: ['point of sale', 'pos', 'counter billing', 'retail', 'barcode', 'scan', 'till', 'cash memo', 'billing'],
    },
    { id: 'pos.return', title: 'POS Return / Exchange', component: ReturnScreen, access: 'vouchers.create', feature: POS, keywords: ['sales return', 'exchange', 'refund', 'credit note', 'pos'] },
    { id: 'pos.summary', title: 'POS Day-end Summary', component: SummaryScreen, access: 'reports.view', feature: POS, keywords: ['day end', 'z report', 'cash count', 'counter summary', 'tender', 'upi', 'card', 'pos register'] },
    { id: 'pos.settings', title: 'POS Settings', component: SettingsScreen, access: 'vouchers.view', feature: POS, keywords: ['tender modes', 'upi', 'card', 'walk-in', 'receipt printer', 'pos'] },
  ],
  menu: [
    { section: 'transactions', label: 'POS Counter', screen: 'pos.counter', order: 5, feature: POS, description: 'Counter billing: scan barcodes, split payment, change, thermal receipt' },
    { section: 'transactions', label: 'POS Return / Exchange', screen: 'pos.return', order: 6, feature: POS, description: 'Goods back from a POS bill: refund, exchange credit or credit to the customer' },
    { section: 'reports', label: 'POS Day-end Summary', screen: 'pos.summary', order: 55, feature: POS, description: 'Sales, returns and cash by tender, cashier and counter; cash count' },
    { section: 'masters', label: 'POS Settings', screen: 'pos.settings', order: 45, feature: POS, description: 'Tender modes, walk-in party, prices and receipt printing of the counter' },
  ],
  voucherPanels: [PosVoucherPanel],
};
