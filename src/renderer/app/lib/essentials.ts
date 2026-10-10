/**
 * Home's Essentials view (docs/ARCHITECTURE.md §7) — pure, tested in essentials.test.ts.
 *
 * Essentials is ONE central list of about 23 everyday entries in five groups, matched against the
 * Gateway's All-menus output by menu label (labels are unique — gatewayLabels.test.ts) or, for voucher
 * entry, by the `vouchers.entry` base type. It never gates anything itself: an entry that All menus
 * does not offer (F11 feature off, no permission, other GST registration, deactivated voucher type)
 * is simply absent here too. Accelerator letters are assigned over the Essentials subset only (the
 * same rules as All menus, lib/menu.ts `withAccelerators`), so they are stable within the view.
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { MenuItem } from '../registry.ts';
import { withAccelerators } from './menu.ts';
import type { BuiltMenuItem, BuiltSection } from './menu.ts';

/** One Essentials entry: a menu label, or the voucher-entry item of a predefined base type. */
export type EssentialRef = { label: string; baseType?: undefined } | { baseType: VoucherBaseType; label?: undefined };

export type EssentialGroupId = 'create' | 'lookup' | 'reports' | 'gst' | 'company';

export interface EssentialGroup {
  id: EssentialGroupId;
  label: string;
  entries: readonly EssentialRef[];
}

/** The Essentials list, exact and in order (docs/USER_GUIDE.md §1, Home). */
export const ESSENTIALS: readonly EssentialGroup[] = [
  {
    id: 'create',
    label: 'Create',
    entries: [{ baseType: 'sales' }, { baseType: 'receipt' }, { baseType: 'purchase' }, { baseType: 'payment' }, { label: 'Create Ledger' }, { label: 'Create Stock Item' }],
  },
  {
    id: 'lookup',
    label: 'Look up',
    entries: [{ label: 'Day Book' }, { label: 'Ledgers' }, { label: 'Stock Items' }, { label: 'Receivables' }, { label: 'Payables' }],
  },
  {
    id: 'reports',
    label: 'Reports',
    entries: [{ label: 'Profit & Loss A/c' }, { label: 'Balance Sheet' }, { label: 'Trial Balance' }, { label: 'Stock Summary' }, { label: 'Cash/Bank Books' }],
  },
  {
    id: 'gst',
    label: 'GST',
    entries: [{ label: 'GSTR-1' }, { label: 'GSTR-3B' }, { label: 'CMP-08' }, { label: 'GSTR-4' }],
  },
  {
    id: 'company',
    label: 'Company',
    // Invoice Printing before Invoice Numbering: with Settings taking N, Printing needs V and
    // Numbering can still take U — the other order leaves Printing without any free letter.
    entries: [{ label: 'Settings' }, { label: 'Invoice Printing' }, { label: 'Invoice Numbering' }, { label: 'Features' }, { label: 'Backup' }],
  },
];

/** Screen id of voucher entry (the vouchers module; shell.tsx VOUCHER_ENTRY_SCREEN). */
const VOUCHER_ENTRY = 'vouchers.entry';

/** Does a menu item stand for this Essentials entry? */
export function matchesEssential(item: Pick<MenuItem, 'label' | 'screen' | 'params'>, ref: EssentialRef): boolean {
  if (ref.baseType !== undefined) {
    const params = item.params ?? {};
    // The predefined type only — a company-defined voucher type of the same base type carries its id.
    return item.screen === VOUCHER_ENTRY && params.baseType === ref.baseType && params.voucherTypeId === undefined;
  }
  return item.label === ref.label;
}

/** A readable name of an entry (tests, messages). */
export function essentialName(ref: EssentialRef): string {
  return ref.baseType !== undefined ? `voucher entry: ${ref.baseType}` : ref.label;
}

export interface EssentialSection {
  id: EssentialGroupId;
  label: string;
  items: BuiltMenuItem[];
}

/**
 * Essentials from the All-menus sections the user may see (buildGateway output). Groups with no
 * entry left are omitted; an item is used at most once; letters are re-assigned over the subset.
 */
export function buildEssentials(sections: readonly BuiltSection[], groups: readonly EssentialGroup[] = ESSENTIALS): EssentialSection[] {
  const all = sections.flatMap((s) => s.items);
  const used = new Set<string>();
  const picked: Array<{ group: EssentialGroup; items: BuiltMenuItem[] }> = [];
  for (const group of groups) {
    const items: BuiltMenuItem[] = [];
    for (const ref of group.entries) {
      const hit = all.find((it) => !used.has(it.id) && matchesEssential(it, ref));
      if (!hit) continue;
      used.add(hit.id);
      items.push(hit);
    }
    if (items.length > 0) picked.push({ group, items });
  }
  // Letters over the subset, in display order (the same rules as All menus).
  const flat = picked.flatMap((p) => p.items);
  const lettered = withAccelerators(flat);
  let k = 0;
  return picked.map(({ group, items }) => ({
    id: group.id,
    label: group.label,
    items: items.map(() => lettered[k++]),
  }));
}

/** Menu-item ids of the Essentials (in Essentials order), for Go To's empty-query list. */
export function essentialIds(sections: readonly EssentialSection[]): string[] {
  return sections.flatMap((s) => s.items.map((i) => i.id));
}

/**
 * Go To with an empty query lists the Essentials' targets first (in Essentials order, under the
 * heading "Essentials"), then everything else unchanged. `menuIds` are menu-item ids; Go To's own
 * ids for menu items are `menu:<menu id>` (lib/gotoItems.ts).
 */
export function essentialsFirst<T extends { id: string; group: string }>(items: readonly T[], menuIds: readonly string[], group = 'Essentials'): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const first: T[] = [];
  const taken = new Set<string>();
  for (const id of menuIds) {
    const it = byId.get(`menu:${id}`);
    if (!it || taken.has(it.id)) continue;
    taken.add(it.id);
    first.push({ ...it, group });
  }
  return [...first, ...items.filter((i) => !taken.has(i.id))];
}
