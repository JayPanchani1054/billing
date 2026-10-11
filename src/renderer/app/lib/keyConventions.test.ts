/**
 * One meaning per key across the feature modules (app/README.md §9 "Screen conventions",
 * CONVENTION_SHORTCUTS): delete is Alt+D (master lists keep Ctrl+D as an alias; Ctrl+D alone is
 * "remove line" in grids), alter is Alt+A, edit history is Alt+H, Alt+C creates (a financial
 * statement's comparison column aside), Alt+F1 is detailed / condensed, and the Day Book prints the
 * highlighted voucher with Ctrl+P. The module screens import React, so their actions are read from source.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../modules');

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push({ file: path.relative(modulesDir, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

interface Action {
  file: string;
  keys: string[];
  label: string;
  icon: string | null;
}

/** `{ key: '…', label: …, icon: '…' }` rail actions, one-line or spread over lines. */
function actions(files: ReadonlyArray<{ file: string; text: string }>): Action[] {
  const out: Action[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(/key:\s*'([^']+)',\s*label:\s*([^\n]+?),\s*(?:icon:\s*'([^']+)')?/g)) {
      out.push({ file: f.file, keys: m[1].split(',').map((k) => k.trim().toLowerCase()), label: m[2].trim(), icon: m[3] ?? null });
    }
  }
  return out;
}

describe('key conventions across modules', () => {
  const files = sources(modulesDir);
  const all = actions(files);
  const show = (a: Action) => `${a.file}: ${a.keys.join(', ')} (${a.label})`;

  test('the scan sees the module actions', () => {
    assert.ok(all.length > 200, `only ${all.length} actions scanned`);
  });

  test('Delete is Alt+D everywhere (Ctrl+D only as a second key on lists)', () => {
    const deletes = all.filter((a) => a.icon === 'trash' && /^['`]Delete/.test(a.label));
    assert.ok(deletes.length >= 15, `only ${deletes.length} delete actions found`);
    const bad = deletes.filter((a) => a.keys[0] !== 'alt+d' || a.keys.some((k) => k !== 'alt+d' && k !== 'ctrl+d'));
    assert.deepEqual(bad.map(show), []);
    // A form never deletes the master on Ctrl+D (in a form's grid Ctrl+D would mean "remove the line").
    const formsWithCtrlD = deletes.filter((a) => a.keys.includes('ctrl+d') && /Form/.test(a.file));
    assert.deepEqual(formsWithCtrlD.map(show), []);
    // The company list deletes through a hotkey map (no rail): Alt+D first, Ctrl+D kept as the alias.
    const companies = files.find((f) => f.file === 'company/CompanySelect.tsx')?.text ?? '';
    assert.match(companies, /'Alt\+D, Ctrl\+D': \(\) => \{/);
    assert.doesNotMatch(companies, /'Ctrl\+D': /);
  });

  test('Alter (voucher / master from a list) is Alt+A', () => {
    const alters = all.filter((a) => /^'Alter( voucher| user)?'$/.test(a.label));
    assert.ok(alters.length >= 8);
    assert.deepEqual(alters.filter((a) => a.keys[0] !== 'alt+a').map(show), []);
    assert.deepEqual(all.filter((a) => a.keys.includes('alt+l') && /Alter/.test(a.label)).map(show), [], 'no Alt+L "Alter voucher" left (GST screens)');
  });

  test('Edit history is Alt+H', () => {
    const history = all.filter((a) => /^'Edit history'$/.test(a.label));
    assert.ok(history.length >= 10, `only ${history.length} "Edit history" actions`);
    assert.deepEqual(history.filter((a) => a.keys[0] !== 'alt+h').map(show), []);
    for (const f of ['accounts/LedgerFormScreen.tsx', 'accounts/GroupScreens.tsx', 'accounts/VoucherTypeScreens.tsx', 'inventory/ItemForm.tsx', 'company/CompanyProfileScreen.tsx', 'accounts/LedgerListScreen.tsx']) {
      assert.ok(history.some((a) => a.file === f), `${f} has no Alt+H Edit history`);
    }
  });

  test('Alt+C creates — except the comparison column of a financial statement ("New Column")', () => {
    const multi = [...files.flatMap((f) => [...f.text.matchAll(/key:\s*'Alt\+C',\s*label:\s*([^\n]+?),\s*(?:icon|onClick|primary|disabled|hidden)/g)].map((m) => ({ file: f.file, label: m[1].trim() })))];
    assert.ok(multi.length >= 15);
    const COMPARE = new Set(['reports/BalanceSheetScreen.tsx', 'reports/ProfitLossScreen.tsx']);
    const odd = multi.filter((a) => !/['`]Create/.test(a.label) && !COMPARE.has(a.file));
    assert.deepEqual(odd.map((a) => `${a.file}: ${a.label}`), []);
    assert.ok(multi.some((a) => a.file === 'banking/SummaryScreen.tsx' && a.label === "'Create bank ledger'"), 'Bank Overview: Alt+C creates a bank ledger');
  });

  test('Alt+H never means anything but edit history (Party Outstanding shows settled bills with Alt+F1)', () => {
    const altH = all.filter((a) => a.keys.includes('alt+h'));
    assert.deepEqual(altH.filter((a) => !/history|History/.test(a.label)).map(show), []);
    const party = all.filter((a) => a.file === 'outstanding/PartyScreen.tsx');
    assert.equal(party.find((a) => /settled bills/.test(a.label))?.keys[0], 'alt+f1');
  });

  test('Alt+F1 is detailed / condensed, never "Today" (Day Book uses Alt+T)', () => {
    const altF1 = all.filter((a) => a.keys.includes('alt+f1'));
    assert.ok(altF1.length >= 5);
    assert.deepEqual(altF1.filter((a) => /Today/.test(a.label)).map(show), []);
    const dayBook = files.find((f) => f.file === 'vouchers/DayBookScreen.tsx')?.text ?? '';
    assert.match(dayBook, /key: 'Alt\+T', label: 'Today'/);
  });

  test("the Day Book and voucher lists print the highlighted voucher with Ctrl+P and alter it with Alt+A", () => {
    const table = files.find((f) => f.file === 'vouchers/VoucherTable.tsx')?.text ?? '';
    assert.match(table, /key: 'Ctrl\+P', label: 'Print voucher'[^\n]*nav\.push\('print\.voucher', \{ id: selected\.id \}\)/);
    assert.match(table, /key: 'Alt\+A',\s*label: 'Alter'/);
  });

  test('voucher entry: Alt+P prints the voucher altered or just saved; print after save sends it to the printer', () => {
    const entry = files.find((f) => f.file === 'vouchers/entry/VoucherEntryScreen.tsx')?.text ?? '';
    assert.match(entry, /key: 'Alt\+P',\s*label: printTarget\?\.label \?\? 'Print'/);
    assert.match(entry, /hidden: printTarget === null/);
    assert.match(entry, /const printNow = afterSavePrint\(out\.id, printAfterSave\)/);
    assert.match(entry, /const printAfterSave = ctx\.config\.printAfterSave && nav\.isRegistered\('print\.voucher'\)/);
    assert.match(entry, /nav\.push\('print\.voucher', printNow\)/, 'the preview is opened with { id, autoPrint: true }');
    // Voucher view: Alt+P only when the print module is there (like entry and the Day Book).
    const view = files.find((f) => f.file === 'vouchers/VoucherViewScreen.tsx')?.text ?? '';
    assert.match(view, /key: 'Alt\+P', label: 'Print'[^\n]*hidden: !v \|\| !nav\.isRegistered\('print\.voucher'\)/);
    assert.doesNotMatch(entry, /Printing is not available yet/);
  });

  test('Bank Overview: cheque register Alt+Q, post-dated cheques Alt+T (Alt+C / Alt+D keep create / delete)', () => {
    const summary = all.filter((a) => a.file === 'banking/SummaryScreen.tsx');
    const keyOf = (label: string) => summary.find((a) => a.label === label)?.keys[0];
    assert.equal(keyOf("'Cheque register'"), 'alt+q');
    assert.equal(keyOf("'Post-dated cheques'"), 'alt+t');
    assert.equal(summary.filter((a) => a.keys.includes('alt+d')).length, 0);
  });
});

// ─────────────── One key, one meaning per screen — including what other modules add to it ───────────────

/** Function components of a source file, by name (top-level `function Name` / `export function Name`). */
function componentsOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(/\n(?=(?:export )?function [A-Z])/)) {
    const m = /^(?:export )?function ([A-Z]\w*)/.exec(part.trimStart());
    if (m) out.set(m[1], part);
  }
  return out;
}

/** `export const ATTACHMENTS_KEY = 'Alt+F'` style constants used as action keys. */
function keyConstants(files: ReadonlyArray<{ file: string; text: string }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) for (const m of f.text.matchAll(/export const ([A-Z_]+) = '((?:Alt|Ctrl|Shift)\+[^']+)'/g)) out.set(m[1], m[2]);
  // lib/*.ts files are not in `files` (only .ts/.tsx under modules are, and lib files are .ts — included).
  return out;
}

/** Overlays bind their own (blocking) scope, so their keys never meet the screen's. */
const isOverlay = (name: string): boolean => /(Dialog|Modal|Drawer)$/.test(name);

interface KeyUse {
  key: string;
  label: string;
  where: string;
}

/**
 * Keys a component registers: rail actions (`key: 'Alt+X', label: …` or `key: CONSTANT`) and hotkey
 * maps (`'Alt+X': () => …`), plus those of the same-file components it renders (overlays aside).
 */
function keysOfComponent(files: ReadonlyArray<{ file: string; text: string }>, consts: Map<string, string>, file: string, name: string, seen = new Set<string>()): KeyUse[] {
  const id = `${file}#${name}`;
  if (seen.has(id)) return [];
  seen.add(id);
  const text = files.find((f) => f.file === file)?.text;
  assert.ok(text !== undefined, `${file} not scanned`);
  const comps = componentsOf(text);
  const body = comps.get(name);
  assert.ok(body !== undefined, `${file}: no component ${name}`);
  const out: KeyUse[] = [];
  const add = (keys: string, label: string) => {
    for (const k of keys.split(',')) out.push({ key: k.trim().toLowerCase(), label: label.trim(), where: id });
  };
  for (const m of body.matchAll(/key:\s*(?:'([^']+)'|([A-Z_]+))\s*,\s*label:\s*([^\n]+?),\s*(?:icon|onClick|primary|disabled|hidden|group|hint)\b/g)) {
    const k = m[1] ?? consts.get(m[2]);
    if (k && /^(Alt|Ctrl|Shift|F\d)/.test(k)) add(k, m[3]);
  }
  for (const m of body.matchAll(/key:\s*(?:'([^']+)'|([A-Z_]+))\s*,\s*\n\s*label:\s*([^\n]+?),\s*\n/g)) {
    const k = m[1] ?? consts.get(m[2]);
    if (k && /^(Alt|Ctrl|Shift|F\d)/.test(k)) add(k, m[3]);
  }
  for (const m of body.matchAll(/'((?:Alt|Ctrl|Shift)\+[^']+)'\s*:\s*(?:\(|[a-z])/g)) add(m[1], '(hotkey)');
  for (const m of body.matchAll(/<([A-Z]\w+)\b/g)) {
    if (m[1] !== name && comps.has(m[1]) && !isOverlay(m[1])) out.push(...keysOfComponent(files, consts, file, m[1], seen));
  }
  return out;
}

/**
 * Components of other modules a host screen's file renders inline (`import { X } from '../../<module>/…'`,
 * `<X`), overlays aside. The host file holds one screen (its body is often an inner `…Form` component).
 */
function guestComponents(files: ReadonlyArray<{ file: string; text: string }>, hostFile: string): Array<{ file: string; name: string }> {
  const text = files.find((f) => f.file === hostFile)?.text ?? '';
  const out: Array<{ file: string; name: string }> = [];
  const hostModule = hostFile.split('/')[0];
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.\.?\/[^']+\.tsx)'/g)) {
    const file = path.posix.join(path.posix.dirname(hostFile), m[2]);
    if (file.split('/')[0] === hostModule || !files.some((f) => f.file === file)) continue; // same module, or the shell
    for (const raw of m[1].split(',')) {
      const name = raw.trim();
      if (/^[A-Z]/.test(name) && !isOverlay(name) && new RegExp(`<${name}\\b`).test(text)) out.push({ file, name });
    }
  }
  return out;
}

/** Every module's `voucherPanels: [A, B]`, resolved through the index file's imports. */
function voucherPanels(files: ReadonlyArray<{ file: string; text: string }>): Array<{ file: string; name: string }> {
  const out: Array<{ file: string; name: string }> = [];
  for (const f of files.filter((x) => /^[a-z]+\/index\.ts$/.test(x.file))) {
    const list = /voucherPanels:\s*\[([^\]]*)\]/.exec(f.text);
    if (!list) continue;
    const dir = f.file.split('/')[0];
    for (const raw of list[1].split(',')) {
      const name = raw.trim();
      if (!name) continue;
      const imp = [...f.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g)].find((m) => m[1].split(',').some((n) => n.trim() === name));
      assert.ok(imp, `${f.file}: cannot find the import of ${name}`);
      out.push({ file: `${dir}/${imp[2]}`, name });
    }
  }
  return out;
}

/** Keys bound with more than one meaning across the given parts of one screen (Ctrl+A accept is per scope by design). */
function clashes(uses: readonly KeyUse[]): string[] {
  const byKey = new Map<string, Set<string>>();
  for (const u of uses) {
    if (u.key === 'ctrl+a') continue;
    const set = byKey.get(u.key) ?? new Set<string>();
    set.add(u.where);
    byKey.set(u.key, set);
  }
  return [...byKey].filter(([, where]) => where.size > 1).map(([k, where]) => `${k}: ${[...where].join(' and ')}`);
}

describe('key conventions: screens other modules extend (parity wave)', () => {
  const files = sources(modulesDir);
  const consts = keyConstants(files);
  const scan = (file: string, name: string) => keysOfComponent(files, consts, file, name);

  test('voucher view: its own keys and every module panel (documents, attachments, cheques, POS, forex, TDS, sharing …) never share a key', () => {
    const panels = voucherPanels(files);
    assert.ok(panels.length >= 9, `only ${panels.length} voucher panels found`);
    for (const m of ['tds', 'documents', 'attachments', 'forex', 'pos', 'cheques', 'print']) assert.ok(panels.some((p) => p.file.startsWith(`${m}/`)), `${m} panel not found`);
    const uses = [...scan('vouchers/VoucherViewScreen.tsx', 'VoucherViewScreen'), ...panels.flatMap((p) => scan(p.file, p.name))];
    for (const k of ['alt+a', 'alt+d', 'alt+f', 'alt+k', 'alt+t', 'alt+u', 'alt+v', 'alt+w', 'alt+y']) assert.ok(uses.some((u) => u.key === k), `${k} not scanned`);
    assert.deepEqual(clashes(uses), []);
  });

  test('voucher entry: its own keys and the TDS / forex panels it renders never share a key', () => {
    const guests = guestComponents(files, 'vouchers/entry/VoucherEntryScreen.tsx');
    assert.ok(guests.some((g) => g.name === 'TdsEntryPanel') && guests.some((g) => g.name === 'ForexEntryPanel'), JSON.stringify(guests));
    const uses = [...scan('vouchers/entry/VoucherEntryScreen.tsx', 'VoucherEntryScreen'), ...guests.flatMap((g) => scan(g.file, g.name))];
    assert.ok(uses.some((u) => u.key === 'alt+u' && u.where.startsWith('tds/')), 'TDS panel Alt+U scanned');
    assert.ok(uses.some((u) => u.key === 'alt+n') && uses.some((u) => u.key === 'alt+k'), 'hotkey maps of voucher entry scanned');
    assert.deepEqual(clashes(uses), []);
  });

  test('ledger and stock item forms: Alt+F attachments never meets a key of the form', () => {
    for (const [file, name] of [
      ['accounts/LedgerFormScreen.tsx', 'LedgerFormScreen'],
      ['inventory/ItemForm.tsx', 'ItemFormScreen'],
    ] as const) {
      const guests = guestComponents(files, file);
      assert.ok(guests.some((g) => g.name === 'AttachmentsRailAction'), `${file}: AttachmentsRailAction not found`);
      const uses = [...scan(file, name), ...guests.flatMap((g) => scan(g.file, g.name))];
      assert.ok(uses.some((u) => u.key === 'alt+f'), `${file}: Alt+F not scanned`);
      assert.deepEqual(clashes(uses), []);
    }
  });

  test('within one screen a key has one meaning (alternatives of one ternary aside)', () => {
    // Mutually exclusive actions written as two entries (only one is ever shown): checked by hand.
    const EXCLUSIVE = new Set([
      'data/RestoreFlow.tsx#RestoreScreen ctrl+a',
      'security/SecuritySettingsScreen.tsx#SettingsForm alt+o',
      'security/UsersRolesScreen.tsx#UsersTab alt+v',
      'tds/VoucherPanel.tsx#TdsVoucherPanel alt+u',
    ]);
    const bad: string[] = [];
    const used = new Set<string>();
    let scanned = 0;
    for (const f of files.filter((x) => x.file.endsWith('.tsx'))) {
      for (const name of componentsOf(f.text).keys()) {
        const uses = scan(f.file, name).filter((u) => u.where === `${f.file}#${name}`);
        scanned += uses.length;
        const labels = new Map<string, Set<string>>();
        for (const u of uses) labels.set(u.key, (labels.get(u.key) ?? new Set()).add(u.label));
        for (const [k, set] of labels) {
          if (set.size < 2) continue;
          if (EXCLUSIVE.has(`${f.file}#${name} ${k}`)) used.add(`${f.file}#${name} ${k}`);
          else bad.push(`${f.file}#${name} ${k}: ${[...set].join(' | ')}`);
        }
      }
    }
    assert.ok(scanned > 400, `only ${scanned} keys scanned`);
    assert.deepEqual(bad, []);
    assert.deepEqual([...EXCLUSIVE].filter((e) => !used.has(e)), [], 'stale entries in EXCLUSIVE');
  });

  test('Alt+A alters (or opens the record to alter); a tick list without alteration may use it to tick everything', () => {
    const all = actions(files);
    const show = (a: Action) => `${a.file}: ${a.keys.join(', ')} (${a.label})`;
    const altA = all.filter((a) => a.keys.includes('alt+a'));
    const tickAll = altA.filter((a) => /Tick all|everyone/.test(a.label));
    assert.deepEqual(
      altA.filter((a) => !tickAll.includes(a) && !/Alter|View role|Open record/.test(a.label)).map(show),
      [],
    );
    // A screen that ticks all with Alt+A has no "Alter" action to confuse it with.
    for (const t of tickAll) assert.deepEqual(all.filter((a) => a.file === t.file && /^'Alter/.test(a.label)).map(show), [], t.file);
    assert.deepEqual([...new Set(tickAll.map((a) => a.file))].sort(), ['cheques/EPaymentScreen.tsx', 'cheques/PrintChequesScreen.tsx', 'outstanding/RemindersScreen.tsx', 'print/PrintBatchScreen.tsx']);
  });
});

// ─────────────── Permissions: hidden, or disabled with a reason ───────────────

describe('parity-wave screens: an action the role forbids is hidden, or disabled with a hint', () => {
  const PARITY = ['tds/', 'documents/', 'mfg/', 'attachments/', 'forex/', 'pos/', 'cheques/', 'gst/'];
  const files = sources(modulesDir).filter((f) => PARITY.some((p) => f.file.startsWith(p)) && f.file.endsWith('.tsx'));

  /** Single-object rail actions `{ key: '…', … }` (brace-balanced). */
  function actionObjects(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/\{\s*key:\s*'[^']+'/g)) {
      let depth = 0;
      let j = m.index;
      for (; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}' && --depth === 0) break;
      }
      out.push(text.slice(m.index, j + 1));
    }
    return out;
  }

  test('no action is only disabled by a permission (users see nothing they cannot use, or why)', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const f of files) {
      // A form's `readOnly` derived from its permission flags (`const readOnly = saved ? !canAlter : !canCreate`) gates like them.
      const readOnlyDecl = /const readOnly = ([^\n;]*\bcan[A-Z][^\n;]*)/.exec(f.text)?.[1] ?? null;
      const permReadOnly = readOnlyDecl !== null;
      const readOnlyFlags = [...(readOnlyDecl ?? '').matchAll(/!(can[A-Z]\w*)\b/g)].map((m) => m[1]);
      for (const obj of actionObjects(f.text)) {
        const disabled = /disabled:\s*([^\n]*?)(?:,\s*(?:hint|hidden|onClick|group|icon|label)\b|\s*\}$)/.exec(obj)?.[1] ?? '';
        const perms = [...disabled.matchAll(/!(can[A-Z]\w*)\b/g)].map((m) => m[1]);
        if (permReadOnly && /\breadOnly\b/.test(disabled)) perms.push('readOnly');
        if (perms.length === 0) continue;
        checked++;
        const hidden = /hidden:\s*([^\n]*?)(?:,|\s*\}$)/.exec(obj)?.[1] ?? '';
        const hiddenFor = (p: string) => hidden.includes(p) || (p === 'readOnly' && readOnlyFlags.some((c) => hidden.includes(`!${c}`)));
        if (!perms.every(hiddenFor) && !/\bhint:/.test(obj)) bad.push(`${f.file}: ${obj.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    assert.ok(checked >= 20, `only ${checked} permission-gated actions found`);
    assert.deepEqual(bad, []);
  });
});

/**
 * Ctrl+J (2.1, SPEC-21 §3.5): the one new global-looking key folds the graphs of the screen's class. It is
 * written once — `GRAPHS_KEY` in app/lib/graphsToggle.ts (app/graphStrip.tsx may name it too) — and every
 * screen gets it through `useGraphsToggle(kind).action`, so no module can bind it to something else, and
 * no Electron menu accelerator takes it first.
 */
describe('Ctrl+J guard (2.1)', () => {
  const rendererDir = path.resolve(modulesDir, '..');
  const mainDir = path.resolve(rendererDir, '../main');
  const ALLOWED = new Set(['app/graphStrip.tsx', 'app/lib/graphsToggle.ts']);
  /** A quoted key literal naming Ctrl+J / Control+J, alone or in a list ('F1, Ctrl+J'). Comment lines are skipped. */
  const LITERAL = /(['"`])[^'"`\n]*\b(?:ctrl|control)\s*\+\s*j\b[^'"`\n]*\1/i;
  const code = (text: string): string =>
    text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
  const walk = (dir: string): Array<{ file: string; text: string }> => {
    const out: Array<{ file: string; text: string }> = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push({ file: path.relative(rendererDir, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
    }
    return out;
  };

  test('the literal detector sees keys in strings and lists, not prose', () => {
    assert.match(`key: 'Ctrl+J', label: 'Hide graphs'`, LITERAL);
    assert.match(`'F1, ctrl + j': open`, LITERAL);
    assert.match('aria-keyshortcuts="Control+J"', LITERAL);
    assert.doesNotMatch(`key: 'Ctrl+K'`, LITERAL);
    assert.doesNotMatch(`key: 'Ctrl+Jx'`, LITERAL);
    assert.doesNotMatch(code('  // Ctrl+J folds the graphs'), LITERAL);
  });

  test('no Ctrl+J literal in any module; in app/ only graphStrip.tsx and lib/graphsToggle.ts', () => {
    const files = walk(rendererDir);
    assert.ok(files.length > 300, `scanned ${files.length} renderer files`);
    const offenders = files.filter((f) => !ALLOWED.has(f.file) && LITERAL.test(code(f.text))).map((f) => f.file);
    assert.deepEqual(offenders, []);
  });

  test('no Electron menu accelerator or main-process binding takes Ctrl+J', () => {
    const offenders = walk(mainDir)
      .filter((f) => /(['"`])[^'"`\n]*\b(?:CmdOrCtrl|CommandOrControl|Ctrl|Control)\s*\+\s*J\b[^'"`\n]*\1/i.test(code(f.text)))
      .map((f) => f.file);
    assert.deepEqual(offenders, []);
  });
});
