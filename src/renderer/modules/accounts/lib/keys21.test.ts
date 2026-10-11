/**
 * 2.1 keys of the accounts screens (SPEC-21 §3.4, §3.5), read from source like app/lib/keyConventions.test.ts
 * (the screens import React): the additive bindings — Ctrl+I (Alt+F1 alias) toggles "More details" on the
 * ledger form, Alt+M is an alias of Alt+B "Create several" on the Ledgers list — are free on their screens,
 * never meet the attachments guest (Alt+F) and are not global keys; actions moved out of sight are
 * `demoted` (never `hidden`), and list screens have no filled button (Create is secondary).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reservedGlobalKeys } from '../../../app/lib/shortcuts.ts';
import { ATTACHMENTS_KEY } from '../../attachments/lib/model.ts';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string): string => fs.readFileSync(path.join(dir, file), 'utf8');

interface KeyUse {
  keys: string[];
  label: string;
  line: string;
}

/** Rail actions written `{ key: '…', label: …, … }` (one line), and hotkey maps `'Alt+X': () => …`. */
function keysOf(text: string): KeyUse[] {
  const out: KeyUse[] = [];
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/key:\s*'([^']+)',\s*label:\s*([^,\n]+)/g)) out.push({ keys: m[1].split(',').map((k) => k.trim().toLowerCase()), label: m[2].trim(), line: line.trim() });
    for (const m of line.matchAll(/'((?:Alt|Ctrl|Shift)\+[^']+)'\s*:\s*\(/g)) out.push({ keys: [m[1].toLowerCase()], label: '(hotkey)', line: line.trim() });
  }
  return out;
}

const reserved = new Set(reservedGlobalKeys().map((k) => k.toLowerCase()));

describe('ledger form: Ctrl+I / Alt+F1 toggle "More details" (SPEC-21 §3.5)', () => {
  const src = read('LedgerFormScreen.tsx');
  const uses = keysOf(src);
  const more = uses.find((u) => u.label === "'More details'");

  test('one action, keys Ctrl+I then Alt+F1, demoted (More ▾ + the printed disclosure line), keys still registered', () => {
    assert.ok(more, 'no More details action');
    assert.deepEqual(more.keys, ['ctrl+i', 'alt+f1']);
    assert.match(more.line, /demoted: true/);
    assert.doesNotMatch(more.line, /hidden:/, 'moving out of sight is demoted, never hidden');
    assert.match(src, /<DisclosureLine shortcut="Ctrl\+I"/, 'the line prints its key');
    // Closing it with the key while the cursor is inside hands the cursor to the line (no focus lost in a hidden region).
    assert.match(src, /buttonRef=\{moreButton\}/);
    assert.match(src, /el\.closest\('\[hidden\]'\)\) moreButton\.current\?\.focus\(\)/);
  });

  test('no other key of the form, nor the attachments guest (Alt+F), is Ctrl+I or Alt+F1', () => {
    const others = uses.filter((u) => u !== more).flatMap((u) => u.keys);
    assert.deepEqual(others.filter((k) => k === 'ctrl+i' || k === 'alt+f1'), []);
    assert.equal(ATTACHMENTS_KEY, 'Alt+F');
    assert.ok(src.includes('<AttachmentsRailAction'), 'the guest is still rendered');
    assert.ok(!more?.keys.includes(ATTACHMENTS_KEY.toLowerCase()));
    // Every key of the form, the guest's included, has one meaning.
    const all = [...uses.flatMap((u) => u.keys.map((k) => `${k} ${u.label}`)), `${ATTACHMENTS_KEY.toLowerCase()} attachments`];
    const byKey = new Map<string, Set<string>>();
    for (const e of all) {
      const [k, ...label] = e.split(' ');
      byKey.set(k, (byKey.get(k) ?? new Set()).add(label.join(' ')));
    }
    assert.deepEqual([...byKey].filter(([k, set]) => k !== 'ctrl+a' && set.size > 1).map(([k]) => k), []);
  });

  test('Ctrl+I and Alt+F1 are not global keys', () => {
    assert.ok(!reserved.has('ctrl+i') && !reserved.has('alt+f1'));
  });

  test('the primary keeps the accessible name "Save & create next" on Creation; the footer Save / Cancel is gone', () => {
    assert.match(src, /const saveLabel = forResult \? 'Save & return' : original \? 'Save' : 'Save & create next';/);
    assert.match(src, /key: 'Ctrl\+A',\s*label: saveLabel,/);
    assert.doesNotMatch(src, /footer=/);
    assert.match(src, /key: 'Alt\+S', label: 'Save & close'/, 'Alt+S Save & close stays (More ▾)');
  });
});

describe('Ledgers list: Alt+M is an alias of Alt+B "Create several" (SPEC-21 §3.5)', () => {
  const src = read('LedgerListScreen.tsx');
  const uses = keysOf(src);

  test('Create several answers Alt+B and Alt+M; nothing else on the list uses either', () => {
    const several = uses.find((u) => u.label === "'Create several'");
    assert.ok(several);
    assert.deepEqual(several.keys, ['alt+b', 'alt+m']);
    assert.deepEqual(uses.filter((u) => u !== several && u.keys.some((k) => k === 'alt+b' || k === 'alt+m')).map((u) => u.line), []);
    assert.ok(!reserved.has('alt+m') && !reserved.has('alt+b'));
  });

  test('Print and Export go to More (outputInMore); "Hide inactive ledgers" is a keyless checkable item; no Type column', () => {
    assert.match(src, /\boutputInMore\b/);
    assert.match(src, /checkItem\('Hide inactive ledgers', hideInactive, setHideInactive\)/);
    assert.doesNotMatch(src, /header: 'Type'/);
    assert.match(src, /hideEmptyColumns/);
  });
});

describe('lists: Create is a secondary button, never the filled one (D5); moved actions are demoted', () => {
  // One field per line: the action's object up to its closing brace holds `prominent: true`.
  const created = (label: string) => new RegExp(`key: 'Alt\\+C',\\s*label: '${label}',(?:\\n[^\\n]*){0,6}?\\n\\s*prominent: true,`);
  const lists: Array<[string, RegExp]> = [
    ['LedgerListScreen.tsx', created('Create ledger')],
    ['ChartScreen.tsx', created('Create ledger')],
    ['OpeningBalancesScreen.tsx', created('Create ledger')],
    ['VoucherTypeScreens.tsx', created('Create type')],
    ['NumberingScreen.tsx', created('Create series')],
    ['CostCentresScreen.tsx', created('Create centre')],
    ['CurrenciesScreen.tsx', created('Create currency')],
  ];
  for (const [file, re] of lists) {
    test(file, () => {
      const src = read(file);
      assert.match(src, re);
      // The only filled buttons left are a form's Save / a dialog's accept.
      for (const u of keysOf(src).filter((x) => /primary: true/.test(x.line))) assert.equal(u.keys[0], 'ctrl+a', `${file}: ${u.line}`);
    });
  }

  test('Groups list: Create group is prominent (written over several lines)', () => {
    assert.match(read('GroupScreens.tsx'), /label: 'Create group',[\s\S]{0,200}?prominent: true,/);
  });

  test('Invoice Numbering: Alter (Alt+A) is demoted to More, Voucher Types is a keyless More item, no title-row extras', () => {
    const src = read('NumberingScreen.tsx');
    assert.match(src, /key: 'Alt\+A', label: 'Alter'[^\n]*demoted: true/);
    assert.match(src, /key: '', label: 'Voucher Types'/);
    assert.doesNotMatch(src, /toolbar=\{/);
  });
});
