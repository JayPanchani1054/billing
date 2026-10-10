/**
 * Human-readable permission catalogue for the role editor: every permission in shared/constants.ts
 * PERMISSIONS, grouped, with a short label and a one-line description. Permissions added to
 * PERMISSIONS later without an entry here still appear (in 'Other'), so the role editor never hides one.
 */
import { PERMISSIONS, type Permission } from '../../../shared/constants.ts';
import type { PermissionCatalog, PermissionCatalogGroup } from '../../../shared/types/security.ts';

interface Entry {
  group: string;
  label: string;
  description: string;
}

const GROUPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'company', label: 'Company' },
  { key: 'masters', label: 'Masters' },
  { key: 'vouchers', label: 'Vouchers' },
  { key: 'reports', label: 'Reports' },
  { key: 'gst', label: 'GST' },
  { key: 'tds', label: 'TDS / TCS' },
  { key: 'banking', label: 'Banking' },
  { key: 'data', label: 'Data' },
  { key: 'security', label: 'Security' },
  { key: 'other', label: 'Other' },
];

const ENTRIES: Partial<Record<Permission, Entry>> = {
  'company.view': { group: 'company', label: 'View company details', description: 'See the company profile, GSTIN and address.' },
  'company.manage': {
    group: 'company',
    label: 'Change company settings',
    description: 'Alter the company profile, features (F11) and configuration (F12).',
  },
  'period.lock': { group: 'company', label: 'Lock and unlock books', description: 'Lock the books up to a date so older entries cannot be changed.' },
  'masters.view': { group: 'masters', label: 'View masters', description: 'See groups, ledgers, stock items and other masters.' },
  'masters.create': { group: 'masters', label: 'Create masters', description: 'Create new ledgers, groups, stock items and other masters.' },
  'masters.alter': { group: 'masters', label: 'Alter masters', description: 'Change existing masters, including opening balances.' },
  'masters.delete': { group: 'masters', label: 'Delete masters', description: 'Delete masters that are not used in any voucher.' },
  'vouchers.view': { group: 'vouchers', label: 'View vouchers', description: 'See vouchers, the Day Book and invoices.' },
  'vouchers.create': { group: 'vouchers', label: 'Create vouchers', description: 'Enter new sales, purchases, payments, receipts and journals.' },
  'vouchers.alter': { group: 'vouchers', label: 'Alter vouchers', description: 'Change or cancel vouchers that were already saved.' },
  'vouchers.delete': { group: 'vouchers', label: 'Delete vouchers', description: 'Delete vouchers permanently (recorded in the edit log).' },
  'vouchers.backdate': { group: 'vouchers', label: 'Back-date vouchers', description: 'Create or alter vouchers dated before today.' },
  'vouchers.renumber': {
    group: 'vouchers',
    label: 'Change voucher numbers and the next number',
    description: 'Give an invoice or voucher a different number (with a reason in the edit log) and set the next number of a series.',
  },
  'reports.view': { group: 'reports', label: 'View reports', description: 'Ledger statements, registers, stock and outstanding reports.' },
  'reports.financial': {
    group: 'reports',
    label: 'View financial statements',
    description: 'Balance Sheet, Profit & Loss, cash flow and ratio analysis.',
  },
  'gst.view': { group: 'gst', label: 'View GST reports', description: 'GSTR-1, GSTR-3B and other GST reports.' },
  'gst.file': {
    group: 'gst',
    label: 'Prepare GST filings',
    description: 'Export return JSON and generate e-invoice and e-way bill files.',
  },
  'tds.view': {
    group: 'tds',
    label: 'View TDS/TCS reports',
    description: 'TDS/TCS computation, outstanding with interest, challan register, return data and exceptions.',
  },
  'tds.manage': {
    group: 'tds',
    label: 'Manage TDS/TCS setup',
    description: 'Natures of payment and goods, ledger TDS details, TAN and setup, and Form 26AS import.',
  },
  'tds.file': {
    group: 'tds',
    label: 'Prepare TDS/TCS statements',
    description: 'Export 26Q, 27Q and 27EQ data and record the filing of quarterly statements.',
  },
  'attachments.add': {
    group: 'data',
    label: 'Attach files',
    description: 'Attach scanned bills, challans and other documents to vouchers, ledgers and stock items.',
  },
  'attachments.remove': {
    group: 'data',
    label: 'Remove attachments',
    description: 'Remove files attached to vouchers and masters (recorded in the edit log).',
  },
  'banking.reconcile': { group: 'banking', label: 'Reconcile bank accounts', description: 'Bank reconciliation and statement import.' },
  'data.export': { group: 'data', label: 'Export data', description: 'Export reports and records to Excel, CSV, JSON or PDF.' },
  'data.import': { group: 'data', label: 'Import data', description: 'Import masters and vouchers from Excel, CSV or another accounting program (XML).' },
  'data.backup': { group: 'data', label: 'Back up', description: 'Create backups of the company.' },
  'data.restore': { group: 'data', label: 'Restore backups', description: 'Restore a backup, replacing data. Give this only to trusted people.' },
  'security.manage': {
    group: 'security',
    label: 'Manage users and security',
    description: 'Create users, assign roles, reset passwords and change security settings.',
  },
  'audit.view': { group: 'security', label: 'View the edit log', description: 'See who created, changed or deleted what, and when.' },
};

const groupLabel = (key: string): string => GROUPS.find((g) => g.key === key)?.label ?? 'Other';

/** Catalogue entry for one permission (falls back to the raw name for unknown ones). */
export function describePermission(p: Permission): { label: string; fullLabel: string; description: string } {
  const e = ENTRIES[p];
  if (!e) return { label: p, fullLabel: `Other › ${p}`, description: p };
  return { label: e.label, fullLabel: `${groupLabel(e.group)} › ${e.label}`, description: e.description };
}

export function permissionCatalog(): PermissionCatalog {
  const groups: PermissionCatalogGroup[] = GROUPS.map((g) => ({ key: g.key, label: g.label, items: [] }));
  for (const p of PERMISSIONS) {
    const e = ENTRIES[p];
    const key = e ? e.group : 'other';
    const group = groups.find((g) => g.key === key) ?? groups[groups.length - 1];
    group.items.push({ permission: p, ...describePermission(p) });
  }
  return { groups: groups.filter((g) => g.items.length > 0) };
}
