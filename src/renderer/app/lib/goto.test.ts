import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getGotoProviders, pushRecent, rankGoto, registerGotoProvider, resolveGotoTarget, searchProviders, subsequenceMatch, uniqueById, usableProviders } from './goto.ts';
import type { GotoItem } from './goto.ts';
import { buildStaticGotoItems, parseRecent, voucherCommands } from './gotoItems.ts';
import type { ModuleDef } from '../registry.ts';

const item = (label: string, extra: Partial<GotoItem> = {}): GotoItem => ({ id: label, label, group: 'Screens', screen: label, ...extra });

const items: GotoItem[] = [
  item('Balance Sheet'),
  item('Profit & Loss A/c', { keywords: ['p&l', 'income statement'] }),
  item('Trial Balance'),
  item('Sales', { hotkey: 'F8', keywords: ['invoice'] }),
  item('Sales Register'),
  item('Stock Summary'),
  item('Day Book'),
];

const labels = (r: ReturnType<typeof rankGoto>) => r.map((x) => x.item.label);

describe('rankGoto', () => {
  test('prefix beats infix; exact beats prefix', () => {
    assert.deepEqual(labels(rankGoto(items, 'bal')), ['Balance Sheet', 'Trial Balance']);
    assert.deepEqual(labels(rankGoto(items, 'sales')).slice(0, 2), ['Sales', 'Sales Register']);
  });

  test('keywords and initials match', () => {
    assert.equal(labels(rankGoto(items, 'income'))[0], 'Profit & Loss A/c');
    assert.equal(labels(rankGoto(items, 'invoice'))[0], 'Sales');
    assert.equal(labels(rankGoto(items, 'bs'))[0], 'Balance Sheet');
  });

  test('sloppy subsequence typing still finds items, ranked below real matches', () => {
    const r = rankGoto(items, 'blsht');
    assert.equal(labels(r)[0], 'Balance Sheet');
    assert.ok(r[0].ranges.length > 0);
    assert.deepEqual(labels(rankGoto(items, 'zzz')), []);
  });

  test('recent items get a boost; empty query lists recents first', () => {
    // Equally good matches: the recent one wins. A recent weak match never beats a prefix match.
    assert.deepEqual(labels(rankGoto(items, 'sal', ['Sales Register'])), ['Sales Register', 'Sales']);
    assert.deepEqual(labels(rankGoto(items, 'bal', ['Trial Balance'])), ['Balance Sheet', 'Trial Balance']);
    assert.deepEqual(labels(rankGoto(items, '', ['Day Book', 'Sales'])).slice(0, 3), ['Day Book', 'Sales', 'Balance Sheet']);
  });

  test('limit', () => {
    assert.equal(rankGoto(items, '', [], 3).length, 3);
  });

  test('highlight ranges point into the label', () => {
    const [top] = rankGoto(items, 'day');
    assert.deepEqual(top.ranges, [[0, 3]]);
  });
});

describe('helpers', () => {
  test('subsequenceMatch', () => {
    assert.equal(subsequenceMatch('Balance Sheet', ''), null);
    assert.equal(subsequenceMatch('Balance', 'xb'), null);
    const contiguous = subsequenceMatch('Balance Sheet', 'bal');
    const spread = subsequenceMatch('Balance Sheet', 'bet');
    assert.ok(contiguous && spread && contiguous.score > spread.score);
  });

  test('pushRecent de-duplicates and caps', () => {
    let list: Array<{ id: string }> = [];
    for (const id of ['a', 'b', 'c', 'a']) list = pushRecent(list, { id }, 3);
    assert.deepEqual(
      list.map((x) => x.id),
      ['a', 'c', 'b'],
    );
  });

  test('uniqueById keeps the first', () => {
    assert.deepEqual(uniqueById([item('x', { group: 'A' }), item('x', { group: 'B' })]).map((i) => i.group), ['A']);
  });
});

describe('providers', () => {
  test('register, replace by id, unregister', async () => {
    const off1 = registerGotoProvider({ id: 'ledgers', label: 'Ledgers', search: async () => [item('Cash')] });
    const off2 = registerGotoProvider({ id: 'ledgers', label: 'Ledgers', search: async (q) => [item(`HDFC ${q}`)] });
    assert.equal(getGotoProviders().filter((p) => p.id === 'ledgers').length, 1);
    const res = await searchProviders('ba', new AbortController().signal);
    assert.deepEqual(
      res.map((r) => r.label),
      ['HDFC ba'],
    );
    off1(); // stale unregister does not remove the replacement
    assert.equal(getGotoProviders().some((p) => p.id === 'ledgers'), true);
    off2();
    assert.equal(getGotoProviders().some((p) => p.id === 'ledgers'), false);
  });

  test('built-in providers never replace a feature provider', async () => {
    const offFeature = registerGotoProvider({ id: 'items', label: 'Items', search: async () => [item('Feature result')] });
    const offBuiltin = registerGotoProvider({ id: 'items', label: 'Items', search: async () => [item('Builtin result')] }, { builtin: true });
    const res = await searchProviders('wid', new AbortController().signal);
    assert.deepEqual(
      res.map((r) => r.label),
      ['Feature result'],
    );
    offBuiltin();
    offFeature();
    assert.equal(getGotoProviders().some((p) => p.id === 'items'), false);
  });

  test('failing providers are silent; minQuery respected', async () => {
    const offs = [
      registerGotoProvider({ id: 'boom', label: 'Boom', search: async () => Promise.reject(new Error('UNKNOWN_ROUTE')) }),
      registerGotoProvider({ id: 'long', label: 'Long', minQuery: 4, search: async () => [item('never')] }),
      registerGotoProvider({ id: 'ok', label: 'Items', minQuery: 1, search: async () => [{ ...item('Widget'), group: '' }] }),
    ];
    const res = await searchProviders('ab', new AbortController().signal);
    assert.deepEqual(
      res.map((r) => [r.label, r.group]),
      [['Widget', 'Items']],
    );
    for (const off of offs) off();
  });
});

describe('static Go To items', () => {
  const Dummy = () => null;
  const mods: ModuleDef[] = [
    {
      id: 'reports',
      screens: [
        { id: 'reports.tb', title: 'Trial Balance', component: Dummy, keywords: ['tb'] },
        { id: 'reports.audit', title: 'Edit Log', component: Dummy, goto: true, access: 'audit.view' },
        { id: 'reports.cash', title: 'Cash Flow', component: Dummy, goto: true },
        { id: 'reports.ledger', title: 'Ledger', component: Dummy },
      ],
      menu: [{ section: 'reports', label: 'Trial Balance', screen: 'reports.tb', hotkey: 'Alt+T' }],
    },
  ];

  test('menu items, goto screens (permission-checked), vouchers and commands', () => {
    const items = buildStaticGotoItems(mods, { can: (p) => p !== 'audit.view', gstEnabled: true });
    const ids = items.map((i) => i.id);
    assert.ok(ids.includes('menu:reports:reports.tb:Trial Balance'));
    assert.ok(ids.includes('screen:reports.cash'));
    assert.ok(!ids.includes('screen:reports.audit'), 'no permission');
    assert.ok(!ids.includes('screen:reports.ledger'), 'needs params, not flagged goto');
    assert.ok(ids.includes('voucher:sales'));
    assert.ok(ids.includes('cmd:date'));
    const tb = items.find((i) => i.screen === 'reports.tb');
    assert.deepEqual(tb?.keywords, ['tb']);
    assert.equal(tb?.group, 'Reports');
    assert.equal(rankGoto(items, 'tb')[0].item.label, 'Trial Balance');
    assert.equal(rankGoto(items, 'sales')[0].item.hotkey, 'F8');
  });

  test('no duplicate voucher entries: the vouchers module menu replaces the shell commands', () => {
    const withMenu: ModuleDef[] = [
      ...mods,
      { id: 'vouchers', screens: [{ id: 'vouchers.entry', title: 'Voucher Entry', component: Dummy }], menu: [{ section: 'transactions', label: 'Sales', screen: 'vouchers.entry', params: { baseType: 'sales' }, access: 'vouchers.create', hotkey: 'F8' }] },
    ];
    const items = buildStaticGotoItems(withMenu, { can: () => true, gstEnabled: true }, { includeVouchers: false });
    assert.equal(items.filter((i) => i.label === 'Sales').length, 1);
    // An Auditor (no vouchers.create) is offered no voucher entry at all.
    const auditor = buildStaticGotoItems(withMenu, { can: (p) => p !== 'vouchers.create', gstEnabled: true }, { includeVouchers: false });
    assert.equal(auditor.filter((i) => i.label === 'Sales').length, 0);
  });

  test('shell voucher commands are filtered by availability (permission + F11 features)', () => {
    const cmds = voucherCommands((b) => b === 'sales' || b === 'receipt');
    assert.deepEqual(cmds.map((c) => c.command).sort(), ['voucher:receipt', 'voucher:sales']);
    assert.equal(voucherCommands(() => false).length, 0);
  });

  test('parseRecent drops malformed entries', () => {
    const r = parseRecent([{ id: 'a', label: 'A', screen: 'x', params: { id: 1 } }, { id: 1 }, null, 'x', { id: 'b', label: 'B', screen: '', command: 'date', params: [] }]);
    assert.deepEqual(
      r.map((x) => [x.id, x.params, x.command]),
      [
        ['a', { id: 1 }, undefined],
        ['b', undefined, 'date'],
      ],
    );
    assert.deepEqual(parseRecent('nope'), []);
  });
});

describe('Go To results the user can open', () => {
  const canOpen = (screen: string) => ['accounts.ledger.form', 'vouchers.entry'].includes(screen); // masters.view, no reports.view

  test('a ledger falls back to its master form when the Ledger report is not allowed; else it is dropped', () => {
    const ledger = item('HDFC Bank', { id: 'ledger:3', screen: 'reports.ledger', params: { ledgerId: 3 }, fallback: { screen: 'accounts.ledger.form', params: { id: 3 } } });
    assert.deepEqual(resolveGotoTarget(ledger, canOpen), { ...ledger, screen: 'accounts.ledger.form', params: { id: 3 }, fallback: undefined });
    assert.deepEqual(resolveGotoTarget(ledger, () => true), ledger);
    assert.equal(resolveGotoTarget(item('Sundry Debtors', { screen: 'reports.groupSummary' }), canOpen), null);
    const cmd = item('Sales - Export', { screen: '', command: 'voucher-type:sales:40' });
    assert.equal(resolveGotoTarget(cmd, () => false), cmd);
  });

  test('providers run only for users who may open their screens (no banking.summary call without reports.view)', () => {
    const search = async () => [];
    const list = [
      { id: 'banking.brs', label: 'BRS', screens: ['banking.brs'], search },
      { id: 'ledgers', label: 'Ledgers', screens: ['reports.ledger', 'accounts.ledger.form'], search },
      { id: 'legacy', label: 'Legacy', search },
    ];
    assert.deepEqual(usableProviders(list, canOpen).map((p) => p.id), ['ledgers', 'legacy']);
  });
});
