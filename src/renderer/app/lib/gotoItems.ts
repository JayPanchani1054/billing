/**
 * Static Go To entries: every allowed menu item, screens flagged `goto: true`, and shell commands.
 * Pure (tested in goto.test.ts).
 */
import { PREDEFINED_VOUCHER_TYPES } from '../../../shared/constants.ts';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { ModuleDef } from '../registry.ts';
import type { GotoItem } from './goto.ts';
import { collectMenu, filterMenu, isAllowed, screenIndex, SECTION_LABELS, sortMenu } from './menu.ts';
import { parseVoucherCommand, voucherCommand } from './voucherTypes.ts';
import type { MenuContext } from './menu.ts';

export const SHELL_COMMANDS: readonly GotoItem[] = [
  { id: 'cmd:date', label: 'Change working date', group: 'Commands', hotkey: 'F2', screen: '', command: 'date', keywords: ['date', 'today'] },
  { id: 'cmd:period', label: 'Change period', group: 'Commands', hotkey: 'Alt+F2', screen: '', command: 'period', keywords: ['dates', 'range', 'financial year'] },
  { id: 'cmd:switch', label: 'Switch company', group: 'Commands', hotkey: 'F3', screen: '', command: 'switch-company', keywords: ['close company', 'select company'] },
  { id: 'cmd:vouchers', label: 'Other vouchers', group: 'Commands', hotkey: 'F10', screen: '', command: 'vouchers', keywords: ['voucher types'] },
  { id: 'cmd:shortcuts', label: 'Keyboard shortcuts', group: 'Commands', hotkey: 'F1', screen: '', command: 'shortcuts', keywords: ['help', 'keys', 'hotkeys'] },
];

/**
 * Voucher entry commands ('Sales' F8 …) — open voucher entry through the shell's checks. Only the
 * types the user can enter now (`available`: permission + F11 features) are offered.
 */
export function voucherCommands(available: (baseType: VoucherBaseType) => boolean = () => true): GotoItem[] {
  return PREDEFINED_VOUCHER_TYPES.filter((t) => available(t.baseType)).map((t) => ({
    id: `voucher:${t.baseType}`,
    label: t.name,
    group: 'Vouchers',
    description: 'New voucher',
    hotkey: t.hotkey && t.hotkey !== 'F10' ? t.hotkey : undefined,
    screen: '',
    command: voucherCommand(t.baseType),
    keywords: ['voucher', 'entry', t.abbreviation],
  }));
}

export interface StaticGotoOptions {
  /**
   * Add the predefined voucher commands. Pass false when the vouchers module registers
   * 'vouchers.entry' — its Transactions menu items already list them (with permission and feature
   * filtering), and listing both shows every voucher type twice.
   */
  includeVouchers?: boolean;
  /** Filter for the voucher commands (shell.voucherAvailability(b).ok). */
  voucherAvailable?: (baseType: VoucherBaseType) => boolean;
  /** Extra entries, e.g. company-defined voucher types (customVoucherGotoItems). */
  extra?: readonly GotoItem[];
}

export function buildStaticGotoItems(modules: readonly ModuleDef[], ctx: MenuContext, options: StaticGotoOptions = {}): GotoItem[] {
  const screens = screenIndex(modules);
  const menu = sortMenu(filterMenu(collectMenu(modules), ctx, screens));
  const items: GotoItem[] = menu.map((m) => ({
    id: `menu:${m.id}`,
    label: m.label,
    group: SECTION_LABELS[m.section],
    description: m.description ?? SECTION_LABELS[m.section],
    keywords: [...(m.keywords ?? []), ...(screens.get(m.screen)?.keywords ?? [])],
    hotkey: m.hotkey,
    screen: m.screen,
    params: m.params,
  }));
  const inMenu = new Set(menu.filter((m) => !m.params || Object.keys(m.params).length === 0).map((m) => m.screen));
  for (const s of screens.values()) {
    if (!s.goto || inMenu.has(s.id) || !isAllowed(s, ctx)) continue;
    items.push({ id: `screen:${s.id}`, label: s.title, group: 'Screens', keywords: s.keywords, screen: s.id });
  }
  if (options.includeVouchers !== false) items.push(...voucherCommands(options.voucherAvailable));
  if (options.extra) items.push(...options.extra);
  items.push(...SHELL_COMMANDS);
  return items;
}

/** Validate recents read from storage (anything malformed is dropped). */
export function parseRecent(raw: unknown): GotoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: GotoItem[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.label !== 'string' || typeof o.screen !== 'string') continue;
    const params = typeof o.params === 'object' && o.params !== null && !Array.isArray(o.params) ? (o.params as Record<string, unknown>) : undefined;
    out.push({
      id: o.id,
      label: o.label,
      group: typeof o.group === 'string' ? o.group : 'Recent',
      description: typeof o.description === 'string' ? o.description : undefined,
      hotkey: typeof o.hotkey === 'string' ? o.hotkey : undefined,
      screen: o.screen,
      params,
      command: typeof o.command === 'string' ? o.command : undefined,
    });
  }
  return out;
}

export interface RecentCheck {
  /** nav.canOpen — permission, features and registration of the screen. */
  canOpen: (screen: string) => boolean;
  /** shell.voucherAvailability(b).ok — vouchers.create and F11 features. */
  voucherAvailable: (baseType: VoucherBaseType) => boolean;
  /** Company-defined voucher types offered right now (active, readable); null = not known. */
  voucherTypeIds: ReadonlySet<number> | null;
}

/**
 * Recents as the CURRENT user may open them. Recents are remembered per company, not per user, so
 * an Owner's "Users & Roles" must not be offered to a Data Entry user who logs in next; nor a
 * voucher type the company has since deactivated, or a feature turned off in F11. The stored list
 * itself is kept (the Owner still sees their recents).
 */
export function usableRecents(recent: readonly GotoItem[], check: RecentCheck): GotoItem[] {
  return recent.filter((item) => {
    if (item.command) {
      const v = parseVoucherCommand(item.command);
      if (!v) return !/^voucher(-type)?:/.test(item.command); // a malformed voucher command is dropped; shell commands stay
      if (!check.voucherAvailable(v.baseType)) return false;
      return v.voucherTypeId === undefined || (check.voucherTypeIds !== null && check.voucherTypeIds.has(v.voucherTypeId));
    }
    return item.screen !== '' && check.canOpen(item.screen);
  });
}
