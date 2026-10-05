/**
 * Role editor state: grouped permission checkboxes with tri-state groups, prerequisites ("Create
 * vouchers" needs "View vouchers") and the anti-escalation limit (someone who is not an Owner can only
 * grant permissions they hold — the server enforces this; the UI explains it up front). Pure.
 */
import { PERMISSIONS, type Permission } from '../../../../shared/constants.ts';
import type { PermissionCatalog, PermissionCatalogGroup, PermissionCatalogItem } from '../../../../shared/types/security.ts';

/** Turning on a key also turns on its prerequisites; turning a prerequisite off turns its dependants off. */
export const PERMISSION_PREREQUISITES: Readonly<Partial<Record<Permission, readonly Permission[]>>> = {
  'company.manage': ['company.view'],
  'period.lock': ['company.view'],
  'masters.create': ['masters.view'],
  'masters.alter': ['masters.view'],
  'masters.delete': ['masters.view'],
  'vouchers.create': ['vouchers.view'],
  'vouchers.alter': ['vouchers.view'],
  'vouchers.delete': ['vouchers.view'],
  'vouchers.backdate': ['vouchers.create'],
  'reports.financial': ['reports.view'],
  'gst.file': ['gst.view'],
};

export type GroupState = 'all' | 'some' | 'none';

/** Canonical (PERMISSIONS) order. */
export const ordered = (set: Iterable<Permission>): Permission[] => {
  const s = new Set(set);
  return PERMISSIONS.filter((p) => s.has(p));
};

/** All prerequisites of `p`, transitively. */
export function prerequisitesOf(p: Permission): Permission[] {
  const out = new Set<Permission>();
  const visit = (x: Permission) => {
    for (const q of PERMISSION_PREREQUISITES[x] ?? []) {
      if (!out.has(q)) {
        out.add(q);
        visit(q);
      }
    }
  };
  visit(p);
  return ordered(out);
}

/** All permissions that (transitively) require `p`. */
export function dependantsOf(p: Permission): Permission[] {
  return PERMISSIONS.filter((x) => prerequisitesOf(x).includes(p));
}

export interface ToggleResult {
  next: Set<Permission>;
  /** Other permissions switched as a consequence (to explain in the UI). */
  alsoOn: Permission[];
  alsoOff: Permission[];
}

/**
 * Switch one permission. Prerequisites are added with it (if grantable); dependants are removed with it.
 * `grantable` limits what may be ADDED (removing is always allowed).
 */
export function togglePermission(selected: ReadonlySet<Permission>, p: Permission, on: boolean, grantable: (p: Permission) => boolean = () => true): ToggleResult {
  const next = new Set(selected);
  const alsoOn: Permission[] = [];
  const alsoOff: Permission[] = [];
  if (on) {
    if (!grantable(p)) return { next, alsoOn, alsoOff };
    next.add(p);
    for (const q of prerequisitesOf(p)) {
      if (!next.has(q) && grantable(q)) {
        next.add(q);
        alsoOn.push(q);
      }
    }
  } else {
    next.delete(p);
    for (const d of dependantsOf(p)) {
      if (next.delete(d)) alsoOff.push(d);
    }
  }
  return { next, alsoOn, alsoOff };
}

export function groupState(group: PermissionCatalogGroup, selected: ReadonlySet<Permission>): GroupState {
  const n = group.items.filter((i) => selected.has(i.permission)).length;
  return n === 0 ? 'none' : n === group.items.length ? 'all' : 'some';
}

/** Group checkbox: anything less than "all" → select every grantable item; "all" → clear the group. */
export function toggleGroup(selected: ReadonlySet<Permission>, group: PermissionCatalogGroup, grantable: (p: Permission) => boolean = () => true): ToggleResult {
  const state = groupState(group, selected);
  let acc: ToggleResult = { next: new Set(selected), alsoOn: [], alsoOff: [] };
  const inGroup = new Set(group.items.map((i) => i.permission));
  for (const item of group.items) {
    const r = togglePermission(acc.next, item.permission, state !== 'all', grantable);
    acc = {
      next: r.next,
      alsoOn: [...acc.alsoOn, ...r.alsoOn.filter((x) => !inGroup.has(x))],
      alsoOff: [...acc.alsoOff, ...r.alsoOff.filter((x) => !inGroup.has(x))],
    };
  }
  return { next: acc.next, alsoOn: ordered(new Set(acc.alsoOn)), alsoOff: ordered(new Set(acc.alsoOff)) };
}

export interface PermissionChange {
  added: Permission[];
  removed: Permission[];
}

export function permissionChanges(saved: readonly Permission[], draft: ReadonlySet<Permission>): PermissionChange {
  const before = new Set(saved);
  return { added: ordered([...draft].filter((p) => !before.has(p))), removed: ordered(saved.filter((p) => !draft.has(p))) };
}

/** Labels lookup over the catalogue (falls back to the raw permission name). */
export function catalogIndex(catalog: PermissionCatalog | undefined): Map<Permission, PermissionCatalogItem> {
  const m = new Map<Permission, PermissionCatalogItem>();
  for (const g of catalog?.groups ?? []) for (const i of g.items) m.set(i.permission, i);
  return m;
}

export function labelOf(index: Map<Permission, PermissionCatalogItem>, p: Permission): string {
  return index.get(p)?.fullLabel ?? p;
}

/** "Also turned on: Vouchers › View vouchers" style note for the last toggle. */
export function toggleNote(index: Map<Permission, PermissionCatalogItem>, r: Pick<ToggleResult, 'alsoOn' | 'alsoOff'>): string | null {
  const parts: string[] = [];
  if (r.alsoOn.length) parts.push(`Also turned on (needed): ${r.alsoOn.map((p) => labelOf(index, p)).join(', ')}.`);
  if (r.alsoOff.length) parts.push(`Also turned off (depends on it): ${r.alsoOff.map((p) => labelOf(index, p)).join(', ')}.`);
  return parts.length ? parts.join(' ') : null;
}

/** Who may grant what: an Owner anything; others only what they hold. */
export function grantableFor(isOwner: boolean, held: readonly Permission[]): (p: Permission) => boolean {
  if (isOwner) return () => true;
  const set = new Set(held);
  return (p) => set.has(p);
}

/** Role name check (same limits as the server). */
export function roleNameProblem(name: string, others: readonly string[]): string | null {
  const n = name.trim();
  if (!n) return 'Enter a name for the role';
  if (n.length > 60) return 'Use at most 60 characters';
  if (others.some((o) => o.toLowerCase() === n.toLowerCase())) return 'A role with this name already exists';
  return null;
}
