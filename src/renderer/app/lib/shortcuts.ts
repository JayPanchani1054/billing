/**
 * The global keyboard map — one table drives the global hotkey registration, the Keyboard
 * Shortcuts overlay and the README. Pure data (tested in shortcuts.test.ts for duplicates).
 */
import { PREDEFINED_VOUCHER_TYPES } from '../../../shared/constants.ts';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { CompanyFeatures } from '../../../shared/settings.ts';
import { GRAPHS_KEY } from './graphsToggle.ts';

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
  { keys: 'Ctrl+Q', label: 'Quit Pevqori', group: 'Help', global: true },
];

/**
 * Conventions every screen follows (documented, registered by screens/the UI kit — not global).
 * One meaning per key across modules; screens must not bind reservedGlobalKeys() (the voucher
 * screen's own F-keys and the GST screens' documented exceptions aside). Labels use the conventional accounting verbs
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
  { keys: 'Alt+F1', label: 'Detailed / condensed', group: 'Lists & reports', global: false, description: 'Also Detailed on the voucher view; on ledger and stock item forms the same as Ctrl+I (More details)' },
  { keys: 'Alt+X', label: 'Expand / collapse all (tree reports)', group: 'Lists & reports', global: false },
  { keys: 'Alt+C', label: 'Comparison column (Balance Sheet, P&L — "New Column")', group: 'Lists & reports', global: false, description: 'Nothing is created from a report, so Alt+C adds a comparison column there' },
  { keys: 'Ctrl+1, Ctrl+2, Ctrl+3', label: 'Switch view or tab (Ctrl+1…9)', group: 'Lists & reports', global: false },
  { keys: 'Ctrl+F', label: "Search box of the screen", group: 'Lists & reports', global: false, description: 'Lists, reports, the Day Book and the voucher lists' },
  { keys: 'Alt+E', label: 'Export (Excel / CSV / PDF)', group: 'Lists & reports', global: false, description: 'Needs the Data › Export permission (also for Print)' },
  { keys: 'Alt+P', label: 'Print', group: 'Lists & reports', global: false, description: 'In voucher entry: the voucher being altered, or the one just saved' },
  { keys: 'Ctrl+P', label: 'Print the highlighted voucher (Day Book, voucher lists)', group: 'Lists & reports', global: false },
  { keys: 'Alt+W', label: 'Share as PDF by e-mail or WhatsApp (invoices, vouchers, statements)', group: 'Lists & reports', global: false, description: 'Needs the Data › Export permission' },
  { keys: 'Y, Ctrl+A', label: 'Yes / confirm', group: 'Dialogs', global: false },
  { keys: 'N, Escape', label: 'No / cancel', group: 'Dialogs', global: false },
  { keys: 'Ctrl+S', label: 'Accept / save (same as Ctrl+A)', group: 'Forms', global: false, description: 'Works wherever Ctrl+A accepts or saves' },
  { keys: 'Ctrl+R', label: 'Change the voucher number (voucher entry and view)', group: 'Forms', global: false, description: 'Needs the “Change voucher numbers and the next number” permission; kept in the edit log' },
  // 2.1 (SPEC-21 §3.3). Documentation rows: the bindings live with the screens (the graph strip, the forms)
  // and in the shell (the key peek); nothing here registers a key.
  { keys: 'Ctrl+I', label: 'More details (voucher entry, ledger and stock item forms)', group: 'Forms', global: false, description: 'Opens or closes the “More details” fields; Alt+F1 does the same on the forms' },
  { keys: GRAPHS_KEY, label: 'Hide / show the graphs', group: 'Lists & reports', global: false, description: 'Folds every graph of the same kind — all reports, Home and the Dashboard, or the detail reports (ledger, monthly summary…); the one-line answer stays. Remembered on this computer' },
  { keys: 'Hold Ctrl', label: 'Show the key of every button on screen', group: 'Help', global: false, description: 'Hold Ctrl alone for about a second; release it to hide the keys again' },
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

// ── F1 (2.1, SPEC-21 D32): the card's rows and groups — pure; rendered by app/ShortcutsOverlay.tsx ──

export interface ShortcutRow extends ShortcutDef {
  id: string;
  /** Overrides the group heading (e.g. "This screen — Day Book"). */
  groupLabel?: string;
}

/** The screen on top: its title and its one-line keyboard hint (the 2.0 status-bar text), if any. */
export interface ThisScreen {
  title: string;
  hint?: string;
}

/** Heading of the first group of F1. */
export function thisScreenLabel(title: string): string {
  return `This screen — ${title}`;
}

/**
 * Rows of F1: the visible actions of the screen on top that have a key (menu-only items, whose key is
 * '', register nothing and are left out; hidden actions register no key either), then the global keys
 * and the conventions. A screen row's description ("<title> screen") is kept for the search only.
 */
export function shortcutRows(screenItems: ReadonlyArray<{ key: string; label: string; hidden?: boolean }>, title: string): ShortcutRow[] {
  const screen: ShortcutRow[] = screenItems
    .filter((i) => !i.hidden && i.key.trim() !== '')
    .map((i, n) => ({ id: `screen-${n}`, keys: i.key, label: i.label, group: 'Navigation' as const, global: false, description: `${title} screen`, groupLabel: thisScreenLabel(title) }));
  return [...screen, ...GLOBAL_SHORTCUTS.map((s, n) => ({ ...s, id: `g-${n}` })), ...CONVENTION_SHORTCUTS.map((s, n) => ({ ...s, id: `c-${n}` }))];
}

export interface ShortcutGroupView {
  label: string;
  /** The screen's hint line (first group only). */
  hint?: string;
  rows: ShortcutRow[];
}

/**
 * F1's groups for a search: "This screen — <title>" first — with the screen's hint line when it has one
 * (and the search matches it), even when the screen has no keyed action (Home) — then the groups of the
 * matching rows in table order.
 */
export function shortcutGroups(rows: readonly ShortcutRow[], query: string, thisScreen?: ThisScreen): ShortcutGroupView[] {
  const groups = new Map<string, ShortcutGroupView>();
  const q = query.trim().toLowerCase();
  if (thisScreen) {
    const label = thisScreenLabel(thisScreen.title);
    if (thisScreen.hint && (!q || thisScreen.hint.toLowerCase().includes(q))) groups.set(label, { label, hint: thisScreen.hint, rows: [] });
  }
  for (const r of filterShortcuts(rows, query)) {
    const g = r.groupLabel ?? r.group;
    const entry = groups.get(g);
    if (entry) entry.rows.push(r);
    else groups.set(g, { label: g, rows: [r] });
  }
  return [...groups.values()];
}
