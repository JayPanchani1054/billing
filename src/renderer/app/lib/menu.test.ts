import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Permission } from '../../../shared/constants.ts';
import type { ModuleDef } from '../registry.ts';
import { acceleratorOrder, assignAccelerators, buildGateway, collectMenu, filterMenu, sortMenu, splitAccelerator } from './menu.ts';

const Dummy = () => null;

const modules: ModuleDef[] = [
  {
    id: 'accounts',
    screens: [
      { id: 'accounts.ledger.form', title: 'Ledger', component: Dummy, access: 'masters.create' },
      { id: 'accounts.group.form', title: 'Group', component: Dummy },
    ],
    menu: [
      { section: 'masters', label: 'Ledgers', screen: 'accounts.ledger.form', order: 10 },
      { section: 'masters', label: 'Groups', screen: 'accounts.group.form', order: 20 },
      { section: 'masters', label: 'Chart of Accounts', screen: 'accounts.coa', order: 5 },
    ],
  },
  {
    id: 'reports',
    screens: [],
    menu: [
      { section: 'reports', label: 'Balance Sheet', screen: 'reports.bs', access: 'reports.financial', order: 1 },
      { section: 'reports', label: 'Day Book', screen: 'reports.daybook', order: 2 },
      { section: 'inventory_reports', label: 'Stock Summary', screen: 'stock.summary', feature: 'inventory' },
    ],
  },
  {
    id: 'gst',
    screens: [],
    menu: [{ section: 'gst', label: 'GSTR-1', screen: 'gst.gstr1', gstOnly: true }],
  },
];

const all = (): boolean => true;
const only =
  (...perms: Permission[]) =>
  (p: Permission): boolean =>
    perms.includes(p);

describe('collect/filter/sort', () => {
  test('collectMenu gives each item a module and unique id', () => {
    const items = collectMenu([...modules, { id: 'dup', screens: [], menu: [{ section: 'masters', label: 'X', screen: 's' }, { section: 'masters', label: 'X', screen: 's' }] }]);
    assert.equal(items.length, 9);
    assert.equal(new Set(items.map((i) => i.id)).size, 9);
    assert.equal(items[0].moduleId, 'accounts');
  });

  test('filterMenu applies permission, GST and feature rules (inheriting the screen access)', () => {
    const items = collectMenu(modules);
    const screens = new Map(modules.flatMap((m) => m.screens).map((s) => [s.id, s]));
    const labels = (ctx: Parameters<typeof filterMenu>[1]) => filterMenu(items, ctx, screens).map((i) => i.label);
    assert.deepEqual(labels({ can: all, gstEnabled: true }), ['Ledgers', 'Groups', 'Chart of Accounts', 'Balance Sheet', 'Day Book', 'Stock Summary', 'GSTR-1']);
    // No masters.create → the Ledgers item is hidden because its screen needs it.
    assert.deepEqual(labels({ can: only('reports.view'), gstEnabled: false, features: { inventory: false } }), ['Groups', 'Chart of Accounts', 'Day Book']);
  });

  test('gstRegistrations shows an item only for that registration type (unknown → shown)', () => {
    const items = [
      { section: 'gst' as const, label: 'GSTR-1', screen: 'gst.gstr1', gstRegistrations: ['regular' as const] },
      { section: 'gst' as const, label: 'CMP-08', screen: 'gst.cmp08', gstRegistrations: ['composition' as const] },
      { section: 'gst' as const, label: 'GST Set-off', screen: 'gst.setoff' },
    ];
    const labels = (gstRegistration: 'regular' | 'composition' | null) => filterMenu(items, { can: all, gstEnabled: true, gstRegistration }).map((i) => i.label);
    assert.deepEqual(labels('regular'), ['GSTR-1', 'GST Set-off']);
    assert.deepEqual(labels('composition'), ['CMP-08', 'GST Set-off']);
    assert.deepEqual(labels(null), ['GSTR-1', 'CMP-08', 'GST Set-off']);
  });

  test('sortMenu orders by section, order, then label', () => {
    const sorted = sortMenu(collectMenu(modules)).map((i) => i.label);
    assert.deepEqual(sorted, ['Chart of Accounts', 'Ledgers', 'Groups', 'Balance Sheet', 'Day Book', 'Stock Summary', 'GSTR-1']);
  });
});

describe('accelerators', () => {
  test('prefer first letters, then word starts, then any letter', () => {
    const labels = ['Create', 'Chart of Accounts', 'Change Period', 'Display', 'Day Book'];
    const idx = assignAccelerators(labels);
    const keys = idx.map((i, n) => (i >= 0 ? labels[n][i].toLowerCase() : null));
    assert.deepEqual(keys, ['c', 'o', 'p', 'd', 'b']);
  });

  test('unique letters, reserved letters skipped, -1 when exhausted', () => {
    const idx = assignAccelerators(['Alpha', 'Aaa', 'Bb'], ['b']);
    assert.equal(idx[0], 0); // a
    assert.equal(idx[1], -1); // only 'a' available and taken
    assert.equal(idx[2], -1); // only 'b', reserved
    const many = assignAccelerators(Array.from({ length: 30 }, (_, i) => `Item ${String.fromCharCode(97 + (i % 26))}x`));
    const letters = many.filter((i) => i >= 0);
    assert.ok(letters.length <= 26);
  });

  test('ignores leading digits and punctuation', () => {
    const [i] = assignAccelerators(['2A Reconciliation']);
    assert.equal(i, 1);
    assert.deepEqual(assignAccelerators(['GSTR-1', 'GSTR-3B']), [0, 1]);
  });

  test('splitAccelerator', () => {
    assert.deepEqual(splitAccelerator('Day Book', 4), ['Day ', 'B', 'ook']);
    assert.deepEqual(splitAccelerator('Day Book', -1), ['Day Book', '', '']);
  });
});

describe('buildGateway', () => {
  test('groups into sections in display order with accelerators across the whole gateway', () => {
    const sections = buildGateway(modules, { can: all, gstEnabled: true });
    assert.deepEqual(
      sections.map((s) => s.label),
      ['Masters', 'Reports', 'Inventory Reports', 'GST'],
    );
    const accels = sections.flatMap((s) => s.items.map((i) => i.accelerator));
    // Priority screens (GATEWAY_PRIORITY: Stock Summary, GSTR-1) claim their letters first, so
    // GSTR-1 keeps G and Groups takes its next letter.
    assert.deepEqual(accels, ['c', 'l', 'r', 'b', 'd', 's', 'g']);
    assert.equal(new Set(accels).size, accels.length);
  });

  test('empty sections disappear', () => {
    const sections = buildGateway(modules, { can: only(), gstEnabled: false, features: { inventory: false } });
    assert.deepEqual(
      sections.map((s) => s.id),
      ['masters', 'reports'],
    );
  });
});

describe('accelerator priority', () => {
  const items = [
    { section: 'masters' as const, label: 'Ledgers', screen: 'accounts.ledger.list' },
    { section: 'transactions' as const, label: 'Sales', screen: 'vouchers.entry', params: { baseType: 'sales' }, hotkey: 'F8' },
    { section: 'transactions' as const, label: 'Day Book', screen: 'vouchers.daybook' },
    { section: 'reports' as const, label: 'Receivables Ageing', screen: 'outstanding.receivables', params: { view: 'ageing' } },
    { section: 'reports' as const, label: 'Balance Sheet', screen: 'reports.balanceSheet' },
  ];

  test('priority screens first (in priority order), items with a global hotkey never, then display order', () => {
    // Balance Sheet (prio 0), Day Book (3), Ledgers (12), then the rest; Sales (F8) is skipped.
    assert.deepEqual(acceleratorOrder(items), [4, 2, 0, 3]);
  });

  test('buildGateway: Balance Sheet keeps B even when an earlier section has a B item; F-key items get none', () => {
    const mods: ModuleDef[] = [
      { id: 'm', screens: [], menu: [{ section: 'masters', label: 'Bank Overview', screen: 'banking.summary', order: 1 }, ...items] },
    ];
    const built = buildGateway(mods, { can: all, gstEnabled: true }).flatMap((s) => s.items);
    const accel = (label: string) => built.find((i) => i.label === label)?.accelerator;
    assert.equal(accel('Balance Sheet'), 'b');
    assert.equal(accel('Day Book'), 'd');
    assert.equal(accel('Sales'), null);
    assert.notEqual(accel('Bank Overview'), 'b');
  });

  test('a digit is the last resort (GSTR-3B after G, S, T, R and B are taken)', () => {
    const idx = assignAccelerators(['G', 'S', 'T', 'R', 'B', 'GSTR-3B']);
    assert.equal('GSTR-3B'[idx[5]], '3');
  });
});
