/**
 * Inventory keys in 2.1 (SPEC-21 §3.5, §1.7, §1.8): the additive bindings — Ctrl+I / Alt+F1 "More details"
 * on the Stock Item form, Alt+B as an alias of Alt+M "Create several" on the Stock Items list — and where
 * every list action now sits (one "Create …" button; Create several, Create under selected, Delete, Print
 * and Export under More ▾ with their keys). The command-bar rule is the real one (app/lib/commandBar.ts);
 * the screens' own keys are read from source, as app/lib/keyConventions.test.ts does.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActionRailItem } from '../../../ui/ActionRail.tsx';
import { hotkeyActions, layoutCommandBar } from '../../../app/lib/commandBar.ts';
import { reservedGlobalKeys } from '../../../app/lib/shortcuts.ts';
import { ATTACHMENTS_KEY } from '../../attachments/lib/model.ts';
import { itemFormActions, MORE_DETAILS_KEYS, moreDetailsAction } from './itemEssentials.ts';
import { countText, itemListActions, pluralOf, treeListActions } from './listActions.ts';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (file: string): string => fs.readFileSync(path.join(dir, file), 'utf8');
const keysOf = (a: { key: string }): string[] =>
  a.key
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
const noop = (): void => {};

/** What ReportScreen adds for a master list (`outputInMore`): Export and Print, demoted to More. */
const OUTPUT: ActionRailItem[] = [
  { key: 'Alt+E', label: 'Export', onClick: noop, group: 'output', demoted: true },
  { key: 'Alt+P', label: 'Print', onClick: noop, group: 'output', demoted: true },
];

const can = { canCreate: true, canDelete: true, hasCurrent: true };

/** The form's own Edit history action (its literal lives in ItemForm.tsx, read by app/lib/keyConventions.test.ts). */
const historyAction = (existing: boolean): ActionRailItem => ({ key: 'Alt+H', label: 'Edit history', onClick: noop, hidden: !existing, group: 'more' });

describe('Stock Items list', () => {
  const actions = itemListActions(can, { create: noop, createSeveral: noop, remove: noop });

  test('title row: "Create stock item" is the one button (secondary, not filled); More ▾ holds the rest with their keys', () => {
    const layout = layoutCommandBar([...actions, ...OUTPUT], [], 3);
    assert.equal(layout.primary, null, 'lists have no filled button (D5)');
    assert.deepEqual(
      layout.buttons.map((b) => b.label),
      ['Create stock item'],
    );
    assert.deepEqual(
      layout.more.map((m) => `${m.label} ${m.key}`),
      ['Create several Alt+M, Alt+B', 'Delete Alt+D, Ctrl+D', 'Export Alt+E', 'Print Alt+P'],
    );
  });

  test('Alt+B is an alias of Alt+M "Create several" (the Ledgers list uses Alt+B for the same thing)', () => {
    const several = actions.find((a) => a.label === 'Create several');
    assert.ok(several);
    assert.deepEqual(keysOf(several), ['alt+m', 'alt+b']);
    assert.equal(several.hidden, false, 'registered whenever the user may create');
    // No other action of the list binds either key.
    const others = actions.filter((a) => a !== several).flatMap(keysOf);
    assert.ok(!others.includes('alt+b') && !others.includes('alt+m'));
    // Nor does the screen file (hotkey maps or literal actions).
    const list = src('ItemList.tsx');
    assert.doesNotMatch(list, /'Alt\+B'|'Alt\+M'/);
    assert.match(list, /itemListActions\(/);
    assert.match(list, /\boutputInMore\b/, 'Print and Export are demoted to More');
  });

  test('every key of 2.0 stays registered: Alt+C, Alt+M, Alt+D / Ctrl+D (+ Alt+E, Alt+P from the report template)', () => {
    const keys = new Set([...actions, ...OUTPUT].filter((a) => !a.hidden).flatMap(keysOf));
    for (const k of ['alt+c', 'alt+m', 'alt+b', 'alt+d', 'ctrl+d', 'alt+e', 'alt+p']) assert.ok(keys.has(k), k);
    // Out of sight is never `hidden` (hidden actions register no key): only the permissions hide.
    assert.deepEqual(actions.filter((a) => a.hidden).map((a) => a.label), []);
    const viewer = itemListActions({ canCreate: false, canDelete: false, hasCurrent: true }, { create: noop, createSeveral: noop, remove: noop });
    assert.deepEqual(viewer.filter((a) => !a.hidden).map((a) => a.label), []);
  });

  test('none of the list keys is a reserved global key', () => {
    const reserved = new Set(reservedGlobalKeys().map((k) => k.toLowerCase()));
    assert.deepEqual([...actions, ...OUTPUT].flatMap(keysOf).filter((k) => reserved.has(k)), []);
  });
});

describe('tree lists (stock groups, categories, godowns) and units', () => {
  test('"Create under selected" (Alt+Shift+C) goes to More ▾; "Create <noun>" is the one button', () => {
    const extras: ActionRailItem[] = [{ key: 'Alt+I', label: 'Items in group', onClick: noop, group: 'more' }];
    const actions = treeListActions('stock group', can, { create: noop, createUnder: noop, remove: noop }, extras);
    const layout = layoutCommandBar([...actions, ...OUTPUT], [], 3);
    assert.equal(layout.primary, null);
    assert.deepEqual(
      layout.buttons.map((b) => b.label),
      ['Create stock group'],
    );
    assert.deepEqual(
      layout.more.map((m) => `${m.label} ${m.key}`),
      ['Create under selected Alt+Shift+C', 'Items in group Alt+I', 'Delete Alt+D, Ctrl+D', 'Export Alt+E', 'Print Alt+P'],
    );
    // Even on a narrow title row the Create button is the one shown.
    assert.deepEqual(
      layoutCommandBar([...actions, ...OUTPUT], [], 1).buttons.map((b) => b.label),
      ['Create stock group'],
    );
  });

  test('Create under selected needs a selected row; Delete says why it cannot run', () => {
    const none = treeListActions('godown', { ...can, hasCurrent: false }, { create: noop, createUnder: noop, remove: noop });
    assert.equal(none.find((a) => a.label === 'Create under selected')?.disabled, true);
    const blocked = treeListActions('godown', { ...can, deleteHint: 'Main Location is built in' }, { create: noop, createUnder: noop, remove: noop });
    assert.equal(blocked.find((a) => a.label === 'Delete')?.hint, 'Main Location is built in');
  });

  test('the screens use the template: TreeMasterList and Units of Measure demote Print/Export and hide blank columns', () => {
    const tree = src('TreeMasterList.tsx');
    assert.match(tree, /treeListActions\(/);
    assert.match(tree, /\boutputInMore\b/);
    assert.match(tree, /\bhideEmptyColumns\b/);
    const units = src('Units.tsx');
    assert.match(units, /key: 'Alt\+C',\s*label: 'Create unit',\s*onClick: [^\n]*\n\s*hidden: !canCreate,\s*prominent: true,/);
    assert.doesNotMatch(units, /primary: true/, 'the unit list has no filled button (its dialog form keeps its own)');
    assert.match(units, /\boutputInMore\b/);
    // Type columns are plain words, not badges.
    for (const f of ['Units.tsx', 'Godowns.tsx', 'ItemList.tsx']) assert.doesNotMatch(src(f), /<Badge\b/, f);
  });

  test('plural nouns and counts read naturally', () => {
    assert.equal(pluralOf('stock category'), 'stock categories');
    assert.equal(pluralOf('stock group'), 'stock groups');
    assert.equal(pluralOf('godown'), 'godowns');
    assert.equal(countText(1, 'item', 'items'), '1 item');
    assert.equal(countText(4, 'item', 'items'), '4 items');
    assert.equal(countText(5000, 'item', 'items', 12345), '5,000 of 12,345 items');
  });
});

describe('Stock Item form: Ctrl+I / Alt+F1 More details', () => {
  const form = src('ItemForm.tsx');
  /** Literal keys of the form's actions and hotkey maps (`key: 'X'`, `'X': () =>`). */
  const literal = [...form.matchAll(/key:\s*'([^']+)'/g), ...form.matchAll(/'((?:Alt|Ctrl|Shift)\+[^']+)'\s*:\s*\(/g)].flatMap((m) => keysOf({ key: m[1] }));

  test('the form registers the More details action (Ctrl+I, Alt+F1 alias) and draws the page line', () => {
    // The form passes its open state to the action (More ▾ shows it checked while open).
    assert.match(form, /itemFormActions\(\s*\{[^}]*\bdetailsOpen,/);
    const h = { save: noop, saveClose: noop, toggleDetails: noop, priceLists: noop, remove: noop };
    const ctx = { existing: false, forResult: false, readOnly: false, detailsOpen: true, priceLevels: false, canDelete: false, hasTransactions: false };
    const more = itemFormActions(ctx, h, historyAction(false)).find((a) => a.label === 'More details');
    assert.equal(more?.checked, true);
    assert.equal(more?.demoted, true);
    assert.equal(itemFormActions({ ...ctx, detailsOpen: false }, h, historyAction(false)).find((a) => a.label === 'More details')?.checked, false);
    assert.match(form, /<DisclosureLine shortcut="Ctrl\+I"/);
    assert.deepEqual(keysOf({ key: MORE_DETAILS_KEYS }), ['ctrl+i', 'alt+f1']);
    assert.deepEqual(keysOf(moreDetailsAction(false, noop)), ['ctrl+i', 'alt+f1']);
  });

  test('one key space with the attachments guest (Alt+F): Ctrl+I and Alt+F1 meet nothing else on the form', () => {
    assert.match(form, /<AttachmentsRailAction /);
    const h = { save: noop, saveClose: noop, toggleDetails: noop, priceLists: noop, remove: noop };
    const actions = itemFormActions({ existing: true, forResult: false, readOnly: false, detailsOpen: false, priceLevels: true, canDelete: true, hasTransactions: false }, h, historyAction(true));
    const create = itemFormActions({ existing: false, forResult: false, readOnly: false, detailsOpen: false, priceLevels: true, canDelete: true, hasTransactions: false }, h, historyAction(false));
    // The lib's actions (Edit history is the form's literal, already in `literal`).
    const fromLib = [...actions.filter((a) => !a.hidden && a.label !== 'Edit history'), ...create.filter((a) => a.key === 'Alt+S')].flatMap(keysOf);
    const all = [...literal, ...fromLib, ...keysOf({ key: ATTACHMENTS_KEY })];
    for (const k of ['ctrl+a', 'alt+s', 'alt+l', 'alt+h', 'alt+d', 'alt+f']) assert.ok(all.includes(k), `${k} scanned`);
    const seen = new Map<string, number>();
    for (const k of all) seen.set(k, (seen.get(k) ?? 0) + 1);
    assert.deepEqual([...seen].filter(([, n]) => n > 1).map(([k]) => k), []);
    // Neither key is a global one (Ctrl+I and Alt+F1 are free outside voucher entry and the reports).
    const reserved = new Set(reservedGlobalKeys().map((k) => k.toLowerCase()));
    assert.ok(!reserved.has('ctrl+i') && !reserved.has('alt+f1'));
  });

  test('one filled button (Ctrl+A) in the title row, Save & close (Alt+S) under More, no footer buttons', () => {
    // The form renders the lib's actions; its one literal is Edit history (Alt+H — alteration, with the Edit Log permission).
    assert.match(form, /actions=\{itemFormActions\(/);
    assert.match(form, /key: 'Alt\+H',\s*label: 'Edit history',[\s\S]{0,240}?hidden: !saved \|\| !canAudit,\s*group: 'more',/);
    assert.equal(form.match(/key: '/g)?.length, 1, 'no other literal action in the form');
    assert.doesNotMatch(form, /\bfooter=/);
    assert.doesNotMatch(form, /variant="primary"/);
    const h = { save: noop, saveClose: noop, toggleDetails: noop, priceLists: noop, remove: noop };
    const base = { existing: false, forResult: false, readOnly: false, detailsOpen: false, priceLevels: true, canDelete: true, hasTransactions: false };
    // Creation: the filled "Save & create next" (its accessible name, as on the ledger form), nothing else as a button.
    const create = layoutCommandBar(itemFormActions(base, h, historyAction(false)), [], 3);
    assert.equal(create.primary?.label, 'Save & create next');
    assert.equal(create.primary?.text, 'Save', 'it reads "Save" (D5)');
    assert.equal(create.primary?.key, 'Ctrl+A');
    assert.deepEqual(create.buttons, []);
    assert.deepEqual(
      create.more.map((m) => `${m.label} ${m.key}`),
      ['Save & close Alt+S', 'More details Ctrl+I, Alt+F1'],
    );
    // Alteration: "Save"; Save & close goes (Ctrl+A already closes); Price lists, Edit history and Delete join More.
    const alter = layoutCommandBar(itemFormActions({ ...base, existing: true }, h, historyAction(true)), [], 3);
    assert.equal(alter.primary?.label, 'Save');
    assert.equal(alter.primary?.text, undefined);
    assert.deepEqual(alter.buttons, []);
    assert.deepEqual(
      alter.more.map((m) => `${m.label} ${m.key}`),
      ['More details Ctrl+I, Alt+F1', 'Price lists Alt+L', 'Edit history Alt+H', 'Delete Alt+D'],
    );
    // From a picker: "Save & return".
    assert.equal(layoutCommandBar(itemFormActions({ ...base, forResult: true }, h, historyAction(false)), [], 3).primary?.label, 'Save & return');
  });

  test('every 2.0 key of the form stays registered where it applied (hidden only by permission or state)', () => {
    const h = { save: noop, saveClose: noop, toggleDetails: noop, priceLists: noop, remove: noop };
    const base = { existing: false, forResult: false, readOnly: false, detailsOpen: false, priceLevels: true, canDelete: true, hasTransactions: false };
    const live = (ctx: typeof base) => new Set(hotkeyActions(itemFormActions(ctx, h, historyAction(ctx.existing))).flatMap(keysOf));
    for (const k of ['ctrl+a', 'alt+s', 'ctrl+i', 'alt+f1']) assert.ok(live(base).has(k), `create: ${k}`);
    for (const k of ['ctrl+a', 'ctrl+i', 'alt+f1', 'alt+l', 'alt+h', 'alt+d']) assert.ok(live({ ...base, existing: true }).has(k), `alter: ${k}`);
    // A used item keeps Delete listed (with its reason) but disabled.
    const used = itemFormActions({ ...base, existing: true, hasTransactions: true }, h, historyAction(true)).find((a) => a.label === 'Delete');
    assert.equal(used?.disabled, true);
    assert.equal(used?.hidden, false);
    assert.match(used?.hint ?? '', /Used in vouchers/);
  });

  test('the five 2.0 panels are one flat column; the open state is remembered per form kind', () => {
    assert.doesNotMatch(form, /<Panel title="(Basic details|GST|Prices|Stock)"/);
    assert.doesNotMatch(form, /<FieldGroup/);
    assert.match(form, /setMoreDetailsOpen\(MORE_DETAILS_KIND, t\.remember\)/);
    assert.match(form, /ui\.moreDetails\[MORE_DETAILS_KIND\]/);
  });
});
