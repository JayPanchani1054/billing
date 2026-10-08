/**
 * Accounts module (accounting masters): chart of accounts, groups, ledgers (single and multiple
 * creation), opening balances, cost centres, currencies and voucher types; the Go To 'ledgers'
 * provider; and the reusable LedgerPicker / GroupPicker (see README.md).
 */
import './accounts.css';
import type { ModuleDef } from '../../app/registry.ts';
import { BulkLedgerScreen } from './BulkLedgerScreen.tsx';
import { ChartScreen } from './ChartScreen.tsx';
import { CostCentresScreen } from './CostCentresScreen.tsx';
import { CurrenciesScreen } from './CurrenciesScreen.tsx';
import { installLedgerGoto } from './goto.ts';
import { GroupFormScreen, GroupListScreen } from './GroupScreens.tsx';
import { LedgerFormScreen } from './LedgerFormScreen.tsx';
import { LedgerListScreen } from './LedgerListScreen.tsx';
import { OpeningBalancesScreen } from './OpeningBalancesScreen.tsx';
import { VoucherTypeFormScreen, VoucherTypesScreen } from './VoucherTypeScreens.tsx';

export { GroupPicker, groupTrail, LedgerPicker, useGroups, useLedgerPicker } from './pickers.tsx';
export type { GroupPickerProps, LedgerPickerProps, UseLedgerPickerOptions, UseLedgerPickerResult } from './pickers.tsx';

installLedgerGoto();

export const accountsModule: ModuleDef = {
  id: 'accounts',
  screens: [
    { id: 'accounts.chart', title: 'Chart of Accounts', component: ChartScreen, access: 'masters.view', keywords: ['groups', 'ledgers', 'tree', 'coa'] },
    { id: 'accounts.ledger.list', title: 'Ledgers', component: LedgerListScreen, access: 'masters.view', keywords: ['accounts', 'party', 'customers', 'suppliers', 'banks'] },
    { id: 'accounts.ledger.form', title: 'Ledger', component: LedgerFormScreen, access: 'masters.view', keywords: ['create ledger', 'alter ledger', 'customer', 'supplier', 'party'] },
    { id: 'accounts.ledger.bulk', title: 'Multiple Ledger Creation', component: BulkLedgerScreen, access: 'masters.create', keywords: ['bulk', 'many ledgers', 'multi'] },
    { id: 'accounts.group.list', title: 'Groups', component: GroupListScreen, access: 'masters.view', keywords: ['account groups', 'heads'] },
    { id: 'accounts.group.form', title: 'Group', component: GroupFormScreen, access: 'masters.view', keywords: ['create group', 'alter group'] },
    { id: 'accounts.costCentres', title: 'Cost Centres', component: CostCentresScreen, access: 'masters.view', feature: 'costCentres', keywords: ['cost categories', 'projects', 'departments', 'branches'] },
    { id: 'accounts.currencies', title: 'Currencies', component: CurrenciesScreen, access: 'masters.view', feature: 'multiCurrency', keywords: ['foreign currency', 'exchange rates', 'forex', 'usd'] },
    { id: 'accounts.voucherTypes', title: 'Voucher Types', component: VoucherTypesScreen, access: 'masters.view', keywords: ['numbering', 'invoice number', 'series', 'prefix'] },
    { id: 'accounts.voucherType.form', title: 'Voucher Type', component: VoucherTypeFormScreen, access: 'masters.view', keywords: ['create voucher type'] },
    { id: 'accounts.openingBalances', title: 'Opening Balances', component: OpeningBalancesScreen, access: 'masters.view', keywords: ['opening trial balance', 'difference in opening balances'] },
  ],
  menu: [
    { section: 'masters', label: 'Ledgers', screen: 'accounts.ledger.list', order: 10, keywords: ['party', 'customers', 'suppliers'], description: 'Customers, suppliers, banks, income and expense heads' },
    { section: 'masters', label: 'Create Ledger', screen: 'accounts.ledger.form', order: 11, access: 'masters.create', keywords: ['new ledger', 'new party'], description: 'Add a customer, supplier, bank or expense head' },
    { section: 'masters', label: 'Groups', screen: 'accounts.group.list', order: 12, description: 'How ledgers are arranged in the Balance Sheet and P&L' },
    { section: 'masters', label: 'Chart of Accounts', screen: 'accounts.chart', order: 13, description: 'Every group and ledger with balances, as a tree' },
    { section: 'masters', label: 'Voucher Types', screen: 'accounts.voucherTypes', order: 14, description: 'Numbering, invoice series and print settings' },
    { section: 'masters', label: 'Opening Balances', screen: 'accounts.openingBalances', order: 15, description: 'Check that opening debits equal credits' },
    { section: 'masters', label: 'Multiple Ledgers', screen: 'accounts.ledger.bulk', order: 16, access: 'masters.create', description: 'Create many ledgers in one grid' },
    { section: 'masters', label: 'Cost Centres', screen: 'accounts.costCentres', order: 17, feature: 'costCentres', description: 'Branches, projects or departments to track' },
    { section: 'masters', label: 'Currencies', screen: 'accounts.currencies', order: 18, feature: 'multiCurrency', description: 'Foreign currencies and exchange rates' },
  ],
};
