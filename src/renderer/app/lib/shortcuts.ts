/**
 * The global keyboard map — one table drives the global hotkey registration, the Keyboard
 * Shortcuts overlay and the README. Pure data (tested in shortcuts.test.ts for duplicates).
 */
import { PREDEFINED_VOUCHER_TYPES } from '../../../shared/constants.ts';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { CompanyFeatures } from '../../../shared/settings.ts';

export type ShortcutGroup = 'Navigation' | 'Vouchers' | 'Company' | 'Help' | 'Forms' | 'Lists & reports' | 'Pickers & dates' | 'Dialogs';

export interface ShortcutDef {
  /** Hotkey string ('Ctrl+G, Alt+G, Ctrl+K'). */
  keys: string;
  label: string;
  group: ShortcutGroup;
  /** Registered by the shell at the global scope (fenced while a dialog is open). */
  global: boolean;
  /** For voucher keys. */
  baseType?: VoucherBaseType;
  description?: string;
}

/** Voucher types and the company feature they need (the hotkey explains how to turn it on). */
export const VOUCHER_FEATURE: Readonly<Partial<Record<VoucherBaseType, keyof CompanyFeatures>>> = {
  sales_order: 'orderProcessing',
  purchase_order: 'orderProcessing',
  delivery_note: 'inventory',
  receipt_note: 'inventory',
  rejection_in: 'rejectionNotes',
  rejection_out: 'rejectionNotes',
  stock_journal: 'inventory',
  physical_stock: 'inventory',
};

/** Voucher hotkeys from the predefined types; F10 opens the "other vouchers" picker instead. */
export const VOUCHER_SHORTCUTS: readonly ShortcutDef[] = PREDEFINED_VOUCHER_TYPES.filter((t) => t.hotkey && t.hotkey !== 'F10').map((t) => ({
  keys: t.hotkey as string,
  label: t.name,
  group: 'Vouchers' as const,
  global: true,
  baseType: t.baseType,
}));

export const GLOBAL_SHORTCUTS: readonly ShortcutDef[] = [
  { keys: 'Ctrl+G, Alt+G, Ctrl+K', label: 'Go To — find any screen, report, master or voucher', group: 'Navigation', global: true },
  { keys: 'F2', label: 'Change working date', group: 'Navigation', global: true },
  { keys: 'Alt+F2', label: 'Change period', group: 'Navigation', global: true },
  { keys: 'Escape', label: 'Back / close (asks before discarding unsaved changes)', group: 'Navigation', global: false },
  ...VOUCHER_SHORTCUTS,
  { keys: 'F10', label: 'Other vouchers…', group: 'Vouchers', global: true },
  { keys: 'F3', label: 'Switch company', group: 'Company', global: true },
  { keys: 'F11', label: 'Features', group: 'Company', global: true },
  { keys: 'F12', label: 'Configuration', group: 'Company', global: true },
  { keys: 'F1, Ctrl+H', label: 'Keyboard shortcuts and help', group: 'Help', global: true },
  { keys: 'Ctrl+Q', label: 'Quit Bahi ERP', group: 'Help', global: true },
];

/**
 * Conventions every screen follows (documented, registered by screens/the UI kit — not global).
 * One meaning per key across modules; screens must not bind reservedGlobalKeys() (the voucher
 * screen's own F-keys and the GST screens' documented exceptions aside). Labels use Tally verbs
 * ("Create …", "Alter …", "Delete"); hints read "<Key> <Title Case action>".
 */
export const CONVENTION_SHORTCUTS: readonly ShortcutDef[] = [
  { keys: 'Enter', label: 'Next field', group: 'Forms', global: false },
  { keys: 'Shift+Enter', label: 'Previous field', group: 'Forms', global: false },
  { keys: 'Ctrl+A', label: 'Accept / save', group: 'Forms', global: false },
  { keys: 'Ctrl+Enter', label: 'Next field from a multi-line box', group: 'Forms', global: false },
  { keys: 'Alt+D', label: 'Delete the master or voucher on screen', group: 'Forms', global: false, description: 'In master lists Ctrl+D also deletes (an alias kept for habit)' },
  { keys: 'Ctrl+D', label: 'Remove the line (voucher and grid rows)', group: 'Forms', global: false },
  { keys: 'Alt+N, Ctrl+N', label: 'Insert a line above', group: 'Forms', global: false },
  { keys: 'Alt+2', label: 'Duplicate the voucher', group: 'Forms', global: false },
  { keys: 'Alt+X', label: 'Cancel the voucher (keeps its number)', group: 'Forms', global: false },
  { keys: 'Alt+H', label: 'Edit history of the voucher or master', group: 'Forms', global: false, description: 'Needs the Edit Log permission' },
  { keys: 'Alt+C', label: 'Create a new master from a list (ledger, item…)', group: 'Pickers & dates', global: false },
  { keys: 'Alt+ArrowDown', label: 'Open the list or calendar', group: 'Pickers & dates', global: false },
  { keys: 't', label: 'Today (in a date box)', group: 'Pickers & dates', global: false, description: 'Also: 5 = 5th of this month, 5-10 = 5 Oct, + / − change by a day' },
  { keys: 'ArrowUp, ArrowDown', label: 'Move in lists and reports', group: 'Lists & reports', global: false },
  { keys: 'Enter', label: 'Open / drill down', group: 'Lists & reports', global: false },
  { keys: 'Alt+Enter', label: 'View the voucher (read-only)', group: 'Lists & reports', global: false },
  { keys: 'Alt+A', label: 'Alter the selected voucher or master', group: 'Lists & reports', global: false, description: 'Tick lists with nothing to alter (Print Cheques, E-payment File, Print batch, Reminders): tick / untick everything' },
  { keys: 'Alt+M', label: "Open the report subject's master (ledger, item)", group: 'Lists & reports', global: false },
  { keys: 'Alt+F1', label: 'Detailed / condensed', group: 'Lists & reports', global: false },
  { keys: 'Alt+X', label: 'Expand / collapse all (tree reports)', group: 'Lists & reports', global: false },
  { keys: 'Alt+C', label: 'Comparison column (Balance Sheet, P&L — Tally "New Column")', group: 'Lists & reports', global: false, description: 'Nothing is created from a report, so Alt+C keeps its Tally meaning there' },
  { keys: 'Ctrl+1, Ctrl+2, Ctrl+3', label: 'Switch view or tab (Ctrl+1…9)', group: 'Lists & reports', global: false },
  { keys: 'Ctrl+F', label: "Search box of the screen", group: 'Lists & reports', global: false },
  { keys: 'Alt+E', label: 'Export (Excel / CSV / PDF)', group: 'Lists & reports', global: false, description: 'Needs the Data › Export permission (also for Print)' },
  { keys: 'Alt+P', label: 'Print', group: 'Lists & reports', global: false, description: 'In voucher entry: the voucher being altered, or the one just saved' },
  { keys: 'Ctrl+P', label: 'Print the highlighted voucher (Day Book, voucher lists)', group: 'Lists & reports', global: false },
  { keys: 'Alt+W', label: 'Share as PDF by e-mail or WhatsApp (invoices, vouchers, statements)', group: 'Lists & reports', global: false, description: 'Needs the Data › Export permission' },
  { keys: 'Y, Ctrl+A', label: 'Yes / confirm', group: 'Dialogs', global: false },
  { keys: 'N, Escape', label: 'No / cancel', group: 'Dialogs', global: false },
];

/** Keys feature screens must NOT bind (they belong to the shell). */
export function reservedGlobalKeys(): string[] {
  return GLOBAL_SHORTCUTS.filter((s) => s.global).flatMap((s) => s.keys.split(',').map((k) => k.trim()));
}

/** Case/space-insensitive text filter for the shortcuts overlay. */
export function filterShortcuts<T extends ShortcutDef>(list: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((s) => `${s.label} ${s.keys} ${s.group} ${s.description ?? ''}`.toLowerCase().includes(q));
}
