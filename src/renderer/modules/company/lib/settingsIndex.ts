/**
 * The Settings hub ('company.settings', 2.0): every setting of the app in one index. The hub never
 * embeds a settings form (two Screens in one entry would fight over the title and the actions); each
 * row opens the existing screen with nav.push. Rows are data here, pure and tested
 * (settingsIndex.test.ts): which rows the viewer sees, the search, and the one-line status of a row
 * computed from data the shell already holds (company, features, the cached F12 configuration).
 *
 * Visibility: a row shows only when its screen is registered AND the viewer may open it
 * (nav.isRegistered && nav.canOpen — permission, F11 feature, GST registration); a category with no
 * row left is hidden, so a feature that is off leaves no trace. Two categories hold inline content
 * instead of rows only: Appearance (app/AppearancePanel.tsx) and the data folder line of Data & backup.
 */
import { formatDate } from '../../../../shared/dates.ts';
import type { CompanyConfig, CompanyFeatures } from '../../../../shared/settings.ts';
import type { GstRegistrationType } from '../../../../shared/types/company.ts';
import type { IconName } from '../../../ui/icons.ts';

export type SettingsCategoryId = 'business' | 'invoices' | 'gst' | 'banking' | 'security' | 'data' | 'modules' | 'appearance' | 'about';

export interface SettingsRow {
  /** Stable id (status lookup, React key, e2e). */
  id: string;
  title: string;
  /** One line under the title: what you change there. */
  description: string;
  /** Screen opened with nav.push (must be registered — settingsIndex.test.ts checks every id). */
  screen: string;
  params?: Record<string, unknown>;
  /** Key that opens the same screen anywhere (shown as a chip; the hub binds no global key). */
  shortcut?: string;
  /** Extra search words (plain language and the accountant's terms). */
  keywords?: readonly string[];
  /** Shown only when GST is on for the company (the screen itself would only say "GST is off"). */
  gstOnly?: boolean;
  /** Shown only to a signed-in user of a password-protected company (Change password). */
  securedOnly?: boolean;
  /** Shown only for these GST registrations (Composition rates: composition dealers only). */
  gstRegistrations?: readonly GstRegistrationType[];
}

/**
 * A narrower name for a topic when only some of its rows are left — a feature that is off leaves no
 * trace in the topic's name either ("GST & TDS" with TDS / TCS off reads "GST").
 */
export interface SettingsTopicName {
  /** Applies when every visible row of the topic is one of these. */
  rows: readonly string[];
  title: string;
  description: string;
}

export interface SettingsCategory {
  id: SettingsCategoryId;
  title: string;
  description: string;
  icon: IconName;
  rows: readonly SettingsRow[];
  /** Inline content rendered by the hub (not a screen): shown whatever the rows. */
  inline?: 'appearance' | 'dataFolder';
  /** Search words for the inline content (it has no rows to match): Ctrl+F finds the topic itself. */
  inlineKeywords?: readonly string[];
  /** Narrower names when some rows are hidden (first match wins); see SettingsTopicName. */
  narrow?: readonly SettingsTopicName[];
}

/** The index (§3.5 of the 2.0 build spec). Order is the order on screen. */
export const SETTINGS_INDEX: readonly SettingsCategory[] = [
  {
    id: 'business',
    title: 'Business',
    description: 'Who you are and what the books keep track of.',
    icon: 'building',
    rows: [
      { id: 'profile', title: 'Company details', description: 'Name, address, GSTIN, PAN, contact details and logo', screen: 'company.profile', keywords: ['alter company', 'address', 'gstin', 'pan', 'logo', 'phone', 'email'] },
      { id: 'features', title: 'Features', description: 'Turn stock, orders, GST, TDS and more on or off', screen: 'company.features', shortcut: 'F11', keywords: ['f11', 'enable', 'inventory', 'godowns', 'batches', 'modules'] },
      { id: 'config', title: 'Configuration', description: 'Round-off, checks before saving, display and amounts', screen: 'company.config', shortcut: 'F12', keywords: ['f12', 'round off', 'negative stock', 'checks', 'display'] },
    ],
  },
  {
    id: 'invoices',
    title: 'Invoices & printing',
    description: 'How invoices are numbered and what they look like on paper.',
    icon: 'print',
    rows: [
      { id: 'printing', title: 'Invoice printing', description: 'Template, paper size, logo, bank details, UPI QR code, terms and declaration', screen: 'print.settings', keywords: ['template', 'paper', 'a4', 'a5', 'thermal', 'upi', 'qr', 'bank details', 'declaration', 'terms', 'copies', 'layout'] },
      { id: 'numbering', title: 'Invoice numbering', description: 'Prefix, suffix, starting number and a fresh series every financial year', screen: 'accounts.numbering', keywords: ['invoice number', 'series', 'prefix', 'suffix', 'restart', 'next number'] },
      { id: 'voucherTypes', title: 'Voucher types', description: 'Every voucher type with all its options, for experts', screen: 'accounts.voucherTypes', keywords: ['voucher type', 'numbering method', 'prefix', 'series', 'print after save'] },
    ],
  },
  {
    id: 'gst',
    title: 'GST & TDS',
    description: 'Tax settings used by invoices and returns.',
    icon: 'gst',
    rows: [
      { id: 'gstConfig', title: 'GST settings', description: 'Return filing (monthly or quarterly), HSN digits, LUT, B2C large and e-way bill limits', screen: 'company.config', params: { tab: 'gst' }, gstOnly: true, keywords: ['gst', 'qrmp', 'quarterly', 'hsn', 'lut', 'e-way bill', 'b2cl'] },
      {
        id: 'composition',
        title: 'Composition rates',
        description: 'Your composition category and the rate of tax on turnover',
        screen: 'gst.composition',
        gstOnly: true,
        gstRegistrations: ['composition'],
        keywords: ['composition', 'category', 'rate', 'turnover', 'cmp-08', 'rule 7'],
      },
      { id: 'tds', title: 'TDS / TCS setup', description: 'TAN, deductor details and the sections you deduct or collect under', screen: 'tds.setup', keywords: ['tds', 'tcs', 'tan', 'deductor', '194q', '206c'] },
    ],
    narrow: [
      { rows: ['gstConfig', 'composition'], title: 'GST', description: 'Tax settings used by invoices and returns.' },
      { rows: ['tds'], title: 'TDS / TCS', description: 'Tax deducted or collected at source.' },
    ],
  },
  {
    id: 'banking',
    title: 'Banking & cheques',
    description: 'Cheque printing and the bank details of the people you pay.',
    icon: 'bank',
    rows: [
      { id: 'chequePrinting', title: 'Cheque printing settings', description: 'Signatory, A/c payee crossing and the cheque layout of each bank', screen: 'cheques.bank', keywords: ['cheque', 'signatory', 'crossing', 'a/c payee'] },
      { id: 'chequeBooks', title: 'Cheque books', description: 'Cheque book series and the leaves still unused', screen: 'cheques.books', keywords: ['cheque book', 'leaves', 'series'] },
      { id: 'payees', title: 'Payee bank details', description: 'Account number and IFSC of suppliers for NEFT / RTGS and e-payments', screen: 'cheques.payees', keywords: ['beneficiary', 'ifsc', 'neft', 'rtgs', 'vendor bank'] },
      { id: 'chequeLayouts', title: 'Cheque layouts', description: 'Where the date, payee and amount print on each bank’s cheque, with a test print', screen: 'cheques.layouts', keywords: ['cheque format', 'calibration', 'cts-2010', 'alignment'] },
    ],
    narrow: [{ rows: ['payees'], title: 'Banking', description: 'The bank details of the people you pay, for transfers and e-payments.' }],
  },
  {
    id: 'security',
    title: 'Users & security',
    description: 'Who may open the books and what they may change.',
    icon: 'shield',
    rows: [
      { id: 'users', title: 'Users & roles', description: 'Add people, give each a role, reset passwords', screen: 'security.users', keywords: ['users', 'roles', 'permissions', 'access'] },
      { id: 'securitySettings', title: 'Security settings', description: 'Password protection, password rules, lock after idle time', screen: 'security.settings', keywords: ['password', 'idle', 'auto log out', 'lockout'] },
      { id: 'periodLock', title: 'Lock books', description: 'Stop changes to entries up to a date', screen: 'company.periodLock', keywords: ['period lock', 'freeze', 'close books'] },
      { id: 'password', title: 'Change password', description: 'Your own password for this company', screen: 'company.changePassword', securedOnly: true, keywords: ['password', 'my password'] },
    ],
  },
  {
    id: 'data',
    title: 'Data & backup',
    description: 'Keep your books safe and move data in or out.',
    icon: 'database',
    inline: 'dataFolder',
    inlineKeywords: ['data folder', 'where is my data', 'location', 'path'],
    rows: [
      { id: 'backup', title: 'Backup', description: 'Take a backup now and see the backups taken', screen: 'data.backup', keywords: ['backup', 'copy', 'usb', 'pen drive'] },
      { id: 'backupSettings', title: 'Automatic backups', description: 'Backup folder, automatic backups and how many to keep', screen: 'company.config', params: { tab: 'backup' }, keywords: ['backup folder', 'auto backup', 'keep last'] },
      { id: 'restore', title: 'Restore a backup', description: 'Bring back the books from a backup file', screen: 'data.restore', keywords: ['restore', 'recover'] },
      { id: 'import', title: 'Import from Excel', description: 'Masters and vouchers from an Excel or CSV template', screen: 'data.import', keywords: ['excel', 'csv', 'import', 'upload'] },
      { id: 'xmlImport', title: 'XML data import', description: 'Masters and vouchers from another accounting program', screen: 'data.xmlImport', keywords: ['xml', 'migration', 'another accounting program'] },
      { id: 'export', title: 'Export data', description: 'Masters and vouchers to Excel or CSV for your CA', screen: 'data.export', keywords: ['excel', 'csv', 'export', 'ca'] },
      { id: 'xmlExport', title: 'XML data export', description: 'Masters and vouchers as XML for another program or your auditor', screen: 'data.xmlExport', keywords: ['xml', 'export', 'auditor'] },
    ],
  },
  {
    id: 'modules',
    title: 'Modules',
    description: 'Settings of the optional parts you switched on.',
    icon: 'grid',
    rows: [
      { id: 'pos', title: 'POS settings', description: 'Counter billing: tender modes, walk-in customer, receipt printer', screen: 'pos.settings', keywords: ['pos', 'counter', 'tender', 'upi', 'card'] },
      { id: 'forex', title: 'Multi-currency settings', description: 'Exchange gain / loss ledgers and foreign-currency rules', screen: 'forex.settings', keywords: ['forex', 'foreign currency', 'exchange'] },
    ],
  },
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Theme, density, Home view and the shortcut bar — for you on this computer.',
    icon: 'sliders',
    inline: 'appearance',
    inlineKeywords: ['appearance', 'theme', 'dark', 'light', 'dark mode', 'match windows', 'density', 'compact', 'comfortable', 'home view', 'essentials', 'all menus', 'shortcut bar', 'colour', 'color', 'look'],
    rows: [],
  },
  {
    id: 'about',
    title: 'About & updates',
    description: 'Version, data folder and updates.',
    icon: 'info',
    rows: [{ id: 'about', title: 'About Pevqori and updates', description: 'Version, where your data is kept, check for updates', screen: 'company.about', keywords: ['version', 'update', 'about', 'release notes'] }],
  },
];

/** What decides whether a row is shown to this viewer. */
export interface SettingsViewer {
  /** nav.isRegistered(id) && nav.canOpen(id). */
  canOpen: (screen: string) => boolean;
  gstEnabled: boolean;
  /** A signed-in user of a password-protected company (not the implicit owner session). */
  secured: boolean;
  /** The company's GST registration (rows limited to some registrations need it). */
  gstRegistration?: GstRegistrationType | null;
}

/**
 * The categories and rows this viewer may use, in index order. A category keeps only its allowed rows
 * and is dropped when none is left; Appearance (per-user preferences, no screen) always shows.
 */
export function visibleSettings(index: readonly SettingsCategory[], viewer: SettingsViewer): SettingsCategory[] {
  const out: SettingsCategory[] = [];
  for (const c of index) {
    const rows = c.rows.filter(
      (r) =>
        viewer.canOpen(r.screen) &&
        (!r.gstOnly || viewer.gstEnabled) &&
        (!r.securedOnly || viewer.secured) &&
        (!r.gstRegistrations || (viewer.gstRegistration != null && r.gstRegistrations.includes(viewer.gstRegistration))),
    );
    if (rows.length === 0 && c.inline !== 'appearance') continue;
    // A topic keeps no trace of a feature that is off in its name either (first narrower name that fits).
    const name = rows.length > 0 ? c.narrow?.find((n) => rows.every((r) => n.rows.includes(r.id))) : undefined;
    out.push(name ? { ...c, title: name.title, description: name.description, rows } : { ...c, rows });
  }
  return out;
}

/** Lower-case words of a query ('  Invoice  NUMBER ' → ['invoice', 'number']). */
function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export interface SettingsMatch {
  category: SettingsCategory;
  row: SettingsRow;
}

/**
 * Ctrl+F search: rows whose title, description, keywords, shortcut or category title contain every
 * word of the query (any order), in index order. A blank query matches nothing (the hub then shows
 * the selected category instead).
 */
export function searchSettings(categories: readonly SettingsCategory[], query: string): SettingsMatch[] {
  const q = words(query);
  if (q.length === 0) return [];
  const out: SettingsMatch[] = [];
  for (const category of categories) {
    for (const row of category.rows) {
      const hay = [row.title, row.description, row.shortcut ?? '', category.title, ...(row.keywords ?? [])].join(' \u0001 ').toLowerCase();
      if (q.every((w) => hay.includes(w))) out.push({ category, row });
    }
  }
  return out;
}

/**
 * Ctrl+F also finds the topics whose content sits on the hub itself (Appearance, the data folder line
 * of Data & backup) — they have no rows for searchSettings to match: "dark", "theme", "data folder".
 * Matched against the topic's inline keywords only (every word of the query), in index order.
 */
export function searchTopics(categories: readonly SettingsCategory[], query: string): SettingsCategory[] {
  const q = words(query);
  if (q.length === 0) return [];
  return categories.filter((c) => {
    if (!c.inline || !c.inlineKeywords || c.inlineKeywords.length === 0) return false;
    const hay = c.inlineKeywords.join(' \u0001 ').toLowerCase();
    return q.every((w) => hay.includes(w));
  });
}

/** Facts the hub already has (app state, features, the cached F12 configuration). */
export interface SettingsFacts {
  companyName: string;
  gstin: string | null;
  features: CompanyFeatures;
  /** undefined while the configuration loads (statuses that need it are left out). */
  config?: CompanyConfig;
}

const TEMPLATE_LABELS: Readonly<Record<string, string>> = { modern: 'Modern', classic: 'Classic', compact: 'Compact receipt' };

/** Feature switches counted for the Features status (password protection is shown under Users & security). */
function featuresOn(f: CompanyFeatures): number {
  return (Object.keys(f) as Array<keyof CompanyFeatures>).filter((k) => k !== 'security' && f[k] === true).length;
}

/**
 * The one-line status shown on a row, or null when there is nothing cheap and certain to say.
 * Never makes a request: only the facts passed in.
 */
export function settingStatus(rowId: string, f: SettingsFacts): string | null {
  const c = f.config;
  switch (rowId) {
    case 'profile':
      return f.gstin ? `${f.companyName} · GSTIN ${f.gstin}` : f.companyName;
    case 'features': {
      const n = featuresOn(f.features);
      return `${n} ${n === 1 ? 'feature' : 'features'} on`;
    }
    case 'printing':
      return c ? `${TEMPLATE_LABELS[c.invoice.template] ?? c.invoice.template} template` : null;
    case 'securitySettings':
      return f.features.security ? 'Password protection on' : 'Password protection off';
    case 'periodLock':
      return c ? (c.lockedUpTo ? `Locked up to ${formatDate(c.lockedUpTo)}` : 'Not locked') : null;
    case 'backupSettings':
      if (!c) return null;
      if (!c.backup.folder) return 'No backup folder chosen';
      return c.backup.auto ? `Automatic · keeps the last ${c.backup.keepLast}` : 'Automatic backups off';
    default:
      return null;
  }
}
