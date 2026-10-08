/**
 * Vouchers module (renderer): voucher entry, Day Book, voucher view and the generic voucher list,
 * the Transactions menu and the Go To 'vouchers' provider. See README.md.
 *
 *   'vouchers.entry'   {baseType? | voucherTypeId?, id? (alter), duplicateOf?, date?, partyId?}
 *   'vouchers.daybook' {from?, to?}
 *   'vouchers.view'    {id}
 *   'vouchers.list'    {from?, to?, voucherTypeIds?, baseTypes?, partyLedgerId?, ledgerId?, search?, includeOptional?, includeCancelled?, onlyPostDated?, title?}
 */
import './vouchers.css';
import type { MenuItem, ModuleDef } from '../../app/registry.ts';
import { api, registerGotoProvider } from '../../app/index.ts';
import { VOUCHER_FEATURE } from '../../app/lib/shortcuts.ts';
import { DayBookScreen } from './DayBookScreen.tsx';
import { VoucherEntryScreen } from './entry/VoucherEntryScreen.tsx';
import { searchText } from './lib/daybook.ts';
import { voucherGotoItems, voucherMenuEntries } from './lib/menu.ts';
import { VoucherListScreen } from './VoucherListScreen.tsx';
import { VoucherViewScreen } from './VoucherViewScreen.tsx';

export type { VoucherEntryParams } from './entry/VoucherEntryScreen.tsx';
export type { VoucherListParams } from './VoucherListScreen.tsx';

// Go To: find vouchers by number, party, reference, narration or exact amount (replaces the shell's built-in).
registerGotoProvider({
  id: 'vouchers',
  label: 'Vouchers',
  minQuery: 1,
  search: async (query) => {
    const search = searchText(query);
    if (search === '') return [];
    const out = await api('vouchers.list', { from: '1900-01-01', to: '2999-12-31', search, limit: 8, sort: 'date_desc' });
    return voucherGotoItems(out.rows);
  },
});

const entryMenu: MenuItem[] = voucherMenuEntries(VOUCHER_FEATURE).map((e) => {
  const item: MenuItem = {
    section: 'transactions',
    label: e.label,
    screen: 'vouchers.entry',
    params: { baseType: e.baseType },
    order: e.order,
    access: 'vouchers.create',
    keywords: e.keywords,
    description: e.description,
  };
  if (e.hotkey) item.hotkey = e.hotkey;
  if (e.feature) item.feature = e.feature;
  return item;
});

export const vouchersModule: ModuleDef = {
  id: 'vouchers',
  screens: [
    { id: 'vouchers.entry', title: 'Voucher Entry', component: VoucherEntryScreen, access: 'vouchers.view', keywords: ['voucher', 'invoice', 'bill', 'entry', 'transaction'] },
    { id: 'vouchers.daybook', title: 'Day Book', component: DayBookScreen, access: 'vouchers.view', goto: true, keywords: ['daybook', 'vouchers', 'transactions', 'register', 'today'] },
    { id: 'vouchers.view', title: 'Voucher', component: VoucherViewScreen, access: 'vouchers.view', keywords: ['display voucher'] },
    { id: 'vouchers.list', title: 'Vouchers', component: VoucherListScreen, access: 'vouchers.view', goto: true, keywords: ['voucher register', 'all vouchers', 'transactions'] },
  ],
  menu: [
    { section: 'transactions', label: 'Day Book', screen: 'vouchers.daybook', order: 1, keywords: ['daybook', 'register', 'today'], description: "Every voucher of the day (or any period) — open, change or delete them" },
    ...entryMenu,
    {
      section: 'transactions',
      label: 'Post-dated Vouchers',
      screen: 'vouchers.list',
      params: { onlyPostDated: true },
      order: 60,
      keywords: ['pdc', 'post dated cheques', 'future'],
      description: 'Vouchers dated in the future that join the books on their date',
    },
  ],
};
