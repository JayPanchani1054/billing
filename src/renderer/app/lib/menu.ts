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
  'tds',
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
  tds: 'TDS / TCS',
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
  req: { access?: Permission; gstOnly?: boolean; feature?: keyof CompanyFeatures; anyFeature?: ReadonlyArray<keyof CompanyFeatures> },
  ctx: MenuContext,
): boolean {
  if (req.access && !ctx.can(req.access)) return false;
  if (req.gstOnly && !ctx.gstEnabled) return false;
  if (req.feature && ctx.features && ctx.features[req.feature] === false) return false;
  // (additive) At least one of these features must be on (e.g. TDS or TCS).
  const feats = ctx.features;
  if (req.anyFeature && req.anyFeature.length > 0 && feats && req.anyFeature.every((f) => feats[f] === false)) return false;
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
const isDigit = (c: string): boolean => /^[0-9]$/.test(c);

/**
 * Screens whose Gateway item gets its accelerator first (the reports and masters people open every
 * day), in this order; then every other item in display order. Only items without params count
 * (e.g. 'Receivables', not 'Receivables Ageing').
 */
export const GATEWAY_PRIORITY: readonly string[] = [
  'reports.balanceSheet',
  'reports.profitLoss',
  'reports.trialBalance',
  'vouchers.daybook',
  'reports.ledger',
  'stock.summary',
  'outstanding.receivables',
  'outstanding.payables',
  'gst.gstr1',
  'gst.gstr3b',
  'banking.brs',
  'reports.cashBank',
  'accounts.ledger.list',
  'inventory.item.list',
  'data.backup',
];

/**
 * Tally-style accelerators: each label gets a unique letter, preferring (1) its first letter,
 * (2) the first letter of a later word, (3) any other letter in the label, (4) a digit in the
 * label. Labels are processed in
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
    // 4. Last resort: a digit of the label ('GSTR-3B' → 3).
    for (let i = 0; i < label.length; i++) if (isDigit(label[i])) candidates.push(i);
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

/**
 * Order in which items claim accelerators: items with a global `hotkey` (voucher entry F4–F9,
 * F11, F12…) get none — they already have a key; `priority` screens (GATEWAY_PRIORITY) go first;
 * then the rest in display order. Returns indices into `items`.
 */
export function acceleratorOrder(items: readonly MenuItem[], priority: readonly string[] = GATEWAY_PRIORITY): number[] {
  const rank = new Map(priority.map((id, i) => [id, i]));
  const noParams = (m: MenuItem) => !m.params || Object.keys(m.params).length === 0;
  const eligible = items.map((m, i) => ({ m, i })).filter(({ m }) => !m.hotkey);
  const first = eligible.filter(({ m }) => noParams(m) && rank.has(m.screen)).sort((a, b) => (rank.get(a.m.screen) ?? 0) - (rank.get(b.m.screen) ?? 0) || a.i - b.i);
  const taken = new Set(first.map((x) => x.i));
  return [...first.map((x) => x.i), ...eligible.filter((x) => !taken.has(x.i)).map((x) => x.i)];
}

/** Group sorted items into Gateway sections (empty sections omitted) with accelerators. */
export function buildGateway(
  modules: readonly ModuleDef[],
  ctx: MenuContext,
  options: { reservedLetters?: Iterable<string>; priority?: readonly string[] } = {},
): BuiltSection[] {
  const screens = screenIndex(modules);
  const items = sortMenu(filterMenu(collectMenu(modules), ctx, screens));
  const order = acceleratorOrder(items, options.priority);
  const assigned = assignAccelerators(
    order.map((i) => items[i].label),
    options.reservedLetters,
  );
  const accel = items.map(() => -1);
  order.forEach((itemIndex, k) => {
    accel[itemIndex] = assigned[k];
  });
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
