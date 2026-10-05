/**
 * Gateway menu building — pure (tested in menu.test.ts): collect ModuleDef.menu entries, filter by
 * permission / GST / feature, sort into sections, and assign Tally-style single-letter accelerators.
 */
import type { Permission } from '../../../shared/constants.ts';
import type { CompanyFeatures } from '../../../shared/settings.ts';
import type { MenuItem, MenuSection, ModuleDef, ScreenDef } from '../registry.ts';

/** Display order of Gateway sections. */
export const SECTION_ORDER: readonly MenuSection[] = [
  'masters',
  'transactions',
  'banking',
  'utilities',
  'reports',
  'inventory_reports',
  'gst',
  'data',
  'security',
  'company',
];

export const SECTION_LABELS: Readonly<Record<MenuSection, string>> = {
  masters: 'Masters',
  transactions: 'Transactions',
  banking: 'Banking',
  utilities: 'Utilities',
  reports: 'Reports',
  inventory_reports: 'Inventory Reports',
  gst: 'GST',
  data: 'Data',
  security: 'Security',
  company: 'Company',
};

export interface MenuContext {
  can: (permission: Permission) => boolean;
  gstEnabled: boolean;
  features?: Partial<CompanyFeatures> | null;
}

export interface CollectedMenuItem extends MenuItem {
  /** Stable id: '<moduleId>:<screen>:<label>'. */
  id: string;
  moduleId: string;
}

export interface BuiltMenuItem extends CollectedMenuItem {
  /** Lower-case accelerator letter, or null when none could be assigned. */
  accelerator: string | null;
  /** Index into `label` of the highlighted accelerator character (-1 = none). */
  accelIndex: number;
}

export interface BuiltSection {
  id: MenuSection;
  label: string;
  items: BuiltMenuItem[];
}

export function screenIndex(modules: readonly ModuleDef[]): Map<string, ScreenDef & { moduleId: string }> {
  const map = new Map<string, ScreenDef & { moduleId: string }>();
  for (const m of modules) for (const s of m.screens) if (!map.has(s.id)) map.set(s.id, { ...s, moduleId: m.id });
  return map;
}

export function collectMenu(modules: readonly ModuleDef[]): CollectedMenuItem[] {
  const out: CollectedMenuItem[] = [];
  const seen = new Set<string>();
  for (const m of modules) {
    for (const item of m.menu ?? []) {
      let id = `${m.id}:${item.screen}:${item.label}`;
      for (let n = 2; seen.has(id); n++) id = `${m.id}:${item.screen}:${item.label}#${n}`;
      seen.add(id);
      out.push({ ...item, id, moduleId: m.id });
    }
  }
  return out;
}

/** Is an item (or a screen) allowed for this user/company? */
export function isAllowed(
  req: { access?: Permission; gstOnly?: boolean; feature?: keyof CompanyFeatures },
  ctx: MenuContext,
): boolean {
  if (req.access && !ctx.can(req.access)) return false;
  if (req.gstOnly && !ctx.gstEnabled) return false;
  if (req.feature && ctx.features && ctx.features[req.feature] === false) return false;
  return true;
}

/**
 * Drop items the user may not use. An item inherits its screen's access/gstOnly/feature when it
 * does not set its own (so a menu entry can never offer a screen that would be refused).
 */
export function filterMenu<T extends MenuItem>(items: readonly T[], ctx: MenuContext, screens?: ReadonlyMap<string, ScreenDef>): T[] {
  return items.filter((item) => {
    if (!isAllowed(item, ctx)) return false;
    const screen = screens?.get(item.screen);
    if (screen && !isAllowed(screen, ctx)) return false;
    return true;
  });
}

export function sortMenu<T extends MenuItem>(items: readonly T[]): T[] {
  const rank = new Map(SECTION_ORDER.map((s, i) => [s, i]));
  return [...items].sort(
    (a, b) =>
      (rank.get(a.section) ?? 99) - (rank.get(b.section) ?? 99) ||
      (a.order ?? 1000) - (b.order ?? 1000) ||
      a.label.localeCompare(b.label, 'en-IN'),
  );
}

const isLetter = (c: string): boolean => /^[a-z]$/i.test(c);

/**
 * Tally-style accelerators: each label gets a unique letter, preferring (1) its first letter,
 * (2) the first letter of a later word, (3) any other letter in the label. Labels are processed in
 * order, so earlier (more important) items win their natural letter. `reserved` letters are never
 * assigned. Returns the index into each label of the chosen character, or -1.
 */
export function assignAccelerators(labels: readonly string[], reserved: Iterable<string> = []): number[] {
  const used = new Set<string>([...reserved].map((c) => c.toLowerCase()));
  return labels.map((label) => {
    const candidates: number[] = [];
    // 1. First letter of the label (skipping leading punctuation/digits).
    const first = [...label].findIndex((c) => isLetter(c));
    if (first >= 0) candidates.push(first);
    // 2. Word starts.
    for (let i = 1; i < label.length; i++) {
      if (isLetter(label[i]) && !isLetter(label[i - 1]) && !/[0-9']/.test(label[i - 1])) candidates.push(i);
    }
    // 3. Any letter.
    for (let i = 0; i < label.length; i++) if (isLetter(label[i])) candidates.push(i);
    for (const i of candidates) {
      const c = label[i].toLowerCase();
      if (!used.has(c)) {
        used.add(c);
        return i;
      }
    }
    return -1;
  });
}

/** Group sorted items into Gateway sections (empty sections omitted) with accelerators. */
export function buildGateway(
  modules: readonly ModuleDef[],
  ctx: MenuContext,
  options: { reservedLetters?: Iterable<string> } = {},
): BuiltSection[] {
  const screens = screenIndex(modules);
  const items = sortMenu(filterMenu(collectMenu(modules), ctx, screens));
  const accel = assignAccelerators(
    items.map((i) => i.label),
    options.reservedLetters,
  );
  const built: BuiltMenuItem[] = items.map((item, i) => ({
    ...item,
    accelIndex: accel[i],
    accelerator: accel[i] >= 0 ? item.label[accel[i]].toLowerCase() : null,
  }));
  const sections: BuiltSection[] = [];
  for (const id of SECTION_ORDER) {
    const list = built.filter((i) => i.section === id);
    if (list.length) sections.push({ id, label: SECTION_LABELS[id], items: list });
  }
  return sections;
}

/** Split a label around its accelerator for rendering: ['Cre', 'a', 'te Ledger']. */
export function splitAccelerator(label: string, index: number): [before: string, key: string, after: string] {
  if (index < 0 || index >= label.length) return [label, '', ''];
  return [label.slice(0, index), label[index], label.slice(index + 1)];
}
