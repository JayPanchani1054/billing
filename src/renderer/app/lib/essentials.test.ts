/**
 * Home's Essentials view against the REAL module menus (read from the module index sources, as
 * gatewayLabels.test.ts does, plus the generated voucher-entry and register entries): every entry
 * resolves on a fully-featured company, a default GST company gets at most 20, nothing twice, and the
 * view is always a subset of All menus (F11 off, missing permissions, composition registration).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Permission } from '../../../shared/constants.ts';
import { DEFAULT_FEATURES } from '../../../shared/settings.ts';
import type { CompanyFeatures } from '../../../shared/settings.ts';
import { REGISTERS } from '../../modules/reports/lib/model.ts';
import { voucherMenuEntries } from '../../modules/vouchers/lib/menu.ts';
import type { MenuItem, MenuSection, ModuleDef, ScreenDef } from '../registry.ts';
import { buildEssentials, essentialIds, essentialName, essentialsFirst, ESSENTIALS, matchesEssential } from './essentials.ts';
import { buildGateway } from './menu.ts';
import type { MenuContext } from './menu.ts';
import { VOUCHER_FEATURE } from './shortcuts.ts';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../modules');

/** Static menu items of one module's index.ts, with their gating fields. */
function scanMenu(source: string): MenuItem[] {
  const out: MenuItem[] = [];
  const re = /section:\s*'([a-z_]+)'\s*,\s*label:\s*'([^']+)'\s*,\s*screen:\s*'([^']+)'([^}]*?(?:\{[^}]*\}[^}]*?)?)\}/g;
  for (const m of source.matchAll(re)) {
    const rest = m[4];
    const item: MenuItem = { section: m[1] as MenuSection, label: m[2], screen: m[3] };
    const str = (key: string) => new RegExp(`\\b${key}:\\s*'([^']+)'`).exec(rest)?.[1];
    const list = (key: string) =>
      new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`)
        .exec(rest)?.[1]
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter(Boolean);
    const hotkey = str('hotkey');
    if (hotkey) item.hotkey = hotkey;
    const access = str('access');
    if (access) item.access = access as Permission;
    const feature = str('feature');
    if (feature) item.feature = feature as keyof CompanyFeatures;
    const anyFeature = list('anyFeature');
    if (anyFeature) item.anyFeature = anyFeature as Array<keyof CompanyFeatures>;
    const regs = list('gstRegistrations');
    if (regs) item.gstRegistrations = regs as Array<'regular' | 'composition' | 'unregistered'>;
    if (/\bgstOnly:\s*true/.test(rest)) item.gstOnly = true;
    if (/params:\s*\{/.test(rest)) item.params = { scanned: true };
    const order = /order:\s*([\d.]+)/.exec(rest);
    if (order) item.order = Number(order[1]);
    out.push(item);
  }
  return out;
}

const Dummy = (): null => null;

/** Screen definitions of one module's index.ts with their gating (a menu item inherits its screen's). */
function scanScreens(source: string): ScreenDef[] {
  const out: ScreenDef[] = [];
  for (const m of source.matchAll(/\{\s*id:\s*'([^']+)'\s*,\s*title:\s*'[^']*'([^}]*)\}/g)) {
    const rest = m[2];
    const screen: ScreenDef = { id: m[1], title: m[1], component: Dummy };
    const access = /\baccess:\s*'([^']+)'/.exec(rest)?.[1];
    if (access) screen.access = access as Permission;
    const feature = /\bfeature:\s*'([^']+)'/.exec(rest)?.[1];
    if (feature) screen.feature = feature as keyof CompanyFeatures;
    if (/\bgstOnly:\s*true/.test(rest)) screen.gstOnly = true;
    out.push(screen);
  }
  return out;
}

function realModules(): ModuleDef[] {
  const mods: ModuleDef[] = [];
  for (const dir of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    const file = path.join(modulesDir, dir.name, 'index.ts');
    if (!dir.isDirectory() || !fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    mods.push({ id: dir.name, screens: scanScreens(source), menu: scanMenu(source) });
  }
  const generated: MenuItem[] = [
    ...REGISTERS.map((r, i): MenuItem => ({ section: 'reports', label: r.label, screen: 'reports.register', params: { baseType: r.baseType }, order: 20 + i })),
    ...voucherMenuEntries(VOUCHER_FEATURE).map(
      (e): MenuItem => ({
        section: 'transactions',
        label: e.label,
        screen: 'vouchers.entry',
        params: { baseType: e.baseType },
        order: e.order,
        access: 'vouchers.create',
        voucherBaseType: e.baseType,
        ...(e.hotkey ? { hotkey: e.hotkey } : {}),
        ...(e.feature ? { feature: e.feature } : {}),
      }),
    ),
  ];
  mods.push({ id: 'generated', screens: [], menu: generated });
  return mods;
}

const mods = realModules();
const everything = Object.fromEntries(Object.keys(DEFAULT_FEATURES).map((k) => [k, true])) as unknown as CompanyFeatures;
const nothing = Object.fromEntries(Object.keys(DEFAULT_FEATURES).map((k) => [k, false])) as unknown as CompanyFeatures;
const all = (): boolean => true;

const contexts: Record<string, MenuContext> = {
  'fully featured, regular GST': { can: all, gstEnabled: true, features: everything, gstRegistration: 'regular' },
  'fully featured, composition': { can: all, gstEnabled: true, features: everything, gstRegistration: 'composition' },
  'default GST company': { can: all, gstEnabled: true, features: DEFAULT_FEATURES, gstRegistration: 'regular' },
  'every F11 feature off': { can: all, gstEnabled: false, features: nothing, gstRegistration: 'unregistered' },
  'data entry (vouchers only)': { can: (p) => p === 'vouchers.create' || p === 'vouchers.view', gstEnabled: true, features: DEFAULT_FEATURES, gstRegistration: 'regular' },
  'auditor (reports only)': { can: (p) => p.startsWith('reports.') || p === 'vouchers.view', gstEnabled: true, features: DEFAULT_FEATURES, gstRegistration: 'regular' },
  'sales deactivated': { can: all, gstEnabled: true, features: DEFAULT_FEATURES, gstRegistration: 'regular', inactiveBaseTypes: new Set(['sales']) },
};

const essentialsOf = (ctx: MenuContext) => buildEssentials(buildGateway(mods, ctx));
const labelsOf = (ctx: MenuContext) => essentialsOf(ctx).flatMap((s) => s.items.map((i) => i.label));

describe('Essentials (Home)', () => {
  test('the menu scan finds the real menus and screens', () => {
    const items = mods.flatMap((m) => m.menu ?? []);
    assert.ok(items.length > 60, `only ${items.length} items scanned`);
    const screens = mods.flatMap((m) => m.screens);
    assert.ok(screens.length > 100, `only ${screens.length} screens scanned`);
    assert.equal(screens.find((s) => s.id === 'stock.summary')?.feature, 'inventory');
  });

  test('every entry resolves on a fully-featured company (composition-only returns on a composition one)', () => {
    const regular = buildGateway(mods, contexts['fully featured, regular GST']).flatMap((s) => s.items);
    const composition = buildGateway(mods, contexts['fully featured, composition']).flatMap((s) => s.items);
    // Strict since the 2.0 integration step: no entry may wait for a screen that is not registered.
    const missing: string[] = [];
    for (const g of ESSENTIALS) {
      for (const ref of g.entries) {
        if (!regular.some((i) => matchesEssential(i, ref)) && !composition.some((i) => matchesEssential(i, ref))) missing.push(essentialName(ref));
      }
    }
    assert.deepEqual(missing, []);
  });

  test('the list has five groups in the agreed order and names nothing twice', () => {
    assert.deepEqual(
      ESSENTIALS.map((g) => g.label),
      ['Create', 'Look up', 'Reports', 'GST', 'Company'],
    );
    const names = ESSENTIALS.flatMap((g) => g.entries.map(essentialName));
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.length, 22);
    // 2.1 (SPEC-21 D9): the Company group is Settings and Backup; the rest of 2.0's group stays in All menus.
    assert.deepEqual(
      ESSENTIALS.find((g) => g.id === 'company')?.entries.map(essentialName),
      ['Settings', 'Backup'],
    );
  });

  test('a default GST company gets at most 20 entries, each menu item once, in Essentials order', () => {
    const sections = essentialsOf(contexts['default GST company']);
    const items = sections.flatMap((s) => s.items);
    assert.ok(items.length <= 20, `${items.length} entries`);
    assert.ok(items.length >= 16, `only ${items.length} entries — has a menu label changed?`);
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);
    assert.deepEqual(
      sections.map((s) => s.id),
      ['create', 'lookup', 'reports', 'gst', 'company'],
    );
    const create = sections[0].items.map((i) => i.params?.baseType ?? i.label);
    assert.deepEqual(create, ['sales', 'receipt', 'purchase', 'payment', 'Create Ledger', 'Create Stock Item']);
    // Regular registration: GSTR-1 and GSTR-3B, not the composition returns.
    assert.deepEqual(
      sections.find((s) => s.id === 'gst')?.items.map((i) => i.label),
      ['GSTR-1', 'GSTR-3B'],
    );
    assert.deepEqual(
      essentialsOf(contexts['fully featured, composition'])
        .find((s) => s.id === 'gst')
        ?.items.map((i) => i.label),
      ['CMP-08', 'GSTR-4'],
    );
  });

  test('always a subset of All menus (F11 off, permissions, composition, deactivated types), with unique letters', () => {
    for (const [name, ctx] of Object.entries(contexts)) {
      const allMenus = new Set(buildGateway(mods, ctx).flatMap((s) => s.items.map((i) => i.id)));
      const items = essentialsOf(ctx).flatMap((s) => s.items);
      for (const it of items) assert.ok(allMenus.has(it.id), `${name}: ${it.label} is not in All menus`);
      const letters = items.map((i) => i.accelerator).filter((l): l is string => l !== null);
      assert.equal(new Set(letters).size, letters.length, `${name}: a letter is used twice`);
    }
    // F11 off: no stock entries; no permission: no create entries; deactivated Sales: no Sales.
    assert.ok(!labelsOf(contexts['every F11 feature off']).some((l) => /Stock/.test(l)));
    assert.ok(!labelsOf(contexts['every F11 feature off']).some((l) => /^GSTR|^CMP/.test(l)));
    assert.ok(!labelsOf(contexts['data entry (vouchers only)']).includes('Create Ledger'));
    assert.ok(!labelsOf(contexts['auditor (reports only)']).includes('Sales'));
    assert.ok(!labelsOf(contexts['sales deactivated']).includes('Sales'));
    assert.ok(labelsOf(contexts['sales deactivated']).includes('Receipt'));
  });

  test('letters are stable within the view: the everyday reports keep theirs, keyed vouchers get none', () => {
    const items = essentialsOf(contexts['default GST company']).flatMap((s) => s.items);
    const letter = (label: string) => items.find((i) => i.label === label)?.accelerator;
    assert.equal(letter('Balance Sheet'), 'b');
    assert.equal(letter('Profit & Loss A/c'), 'p');
    assert.equal(letter('Trial Balance'), 't');
    assert.equal(letter('Day Book'), 'd');
    assert.equal(letter('Sales'), null); // F8 is its key
    // 2.1: the Company group is Settings and Backup; Backup's letter is pinned anew (USER_GUIDE §1, Home).
    assert.equal(letter('Settings'), 'n');
    assert.equal(letter('Backup'), 'k');
    // Features (F11), Invoice Printing and Invoice Numbering left Essentials; All menus still lists them.
    for (const gone of ['Features', 'Invoice Printing', 'Invoice Numbering']) {
      assert.equal(items.find((i) => i.label === gone), undefined, `${gone} is not an Essentials entry`);
      assert.ok(
        buildGateway(mods, contexts['default GST company']).some((s) => s.items.some((i) => i.label === gone)),
        `${gone} is still in All menus`,
      );
    }
    // Letters are assigned over the subset, not copied from All menus: with ~20 entries every entry
    // without a key of its own gets one ("Ledgers" is L here; All menus gives L to another item).
    for (const it of items) if (!it.hotkey) assert.notEqual(it.accelerator, null, `${it.label} has no letter`);
    assert.equal(letter('Ledgers'), 'l');
    // Recomputing gives the same letters.
    assert.deepEqual(
      essentialsOf(contexts['default GST company']).flatMap((s) => s.items.map((i) => i.accelerator)),
      items.map((i) => i.accelerator),
    );
  });

  test('a company-defined voucher type never stands in for the predefined one', () => {
    const custom = { label: 'Sales (Counter)', screen: 'vouchers.entry', params: { baseType: 'sales', voucherTypeId: 7 } };
    assert.equal(matchesEssential(custom, { baseType: 'sales' }), false);
    assert.equal(matchesEssential({ label: 'Sales', screen: 'vouchers.entry', params: { baseType: 'sales' } }, { baseType: 'sales' }), true);
    assert.equal(matchesEssential({ label: 'Day Book', screen: 'vouchers.daybook' }, { label: 'Day Book' }), true);
  });

  test('Go To with an empty query lists the Essentials first, in their order, under "Essentials"', () => {
    const items = [
      { id: 'menu:a', group: 'Masters' },
      { id: 'menu:b', group: 'Reports' },
      { id: 'screen:x', group: 'Screens' },
      { id: 'menu:c', group: 'Reports' },
    ];
    const out = essentialsFirst(items, ['c', 'a', 'zz']);
    assert.deepEqual(
      out.map((i) => `${i.id}/${i.group}`),
      ['menu:c/Essentials', 'menu:a/Essentials', 'menu:b/Reports', 'screen:x/Screens'],
    );
    assert.deepEqual(essentialsFirst(items, []), items);
    const sections = essentialsOf(contexts['default GST company']);
    assert.equal(essentialIds(sections).length, sections.flatMap((s) => s.items).length);
  });
});
