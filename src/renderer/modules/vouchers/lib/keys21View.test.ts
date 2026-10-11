/**
 * 2.1 keys of the voucher view, the Day Book and the voucher lists (SPEC-21 §3.5, read from source like
 * app/lib/keyConventions.test.ts — the screens import React):
 *
 *   - Ctrl+F (new, the convention) focuses the one search field of the Day Book and of the voucher list;
 *     nothing else in the vouchers module binds it.
 *   - Alt+F1 (new) is "Detailed" on the voucher view, remembered through `setUiPrefs({ voucherDetailed })`;
 *     no module panel shown on the view (`ModuleDef.voucherPanels`) binds Alt+F1.
 *   - Moving an action out of sight never hides it (rule 2 / 2b): the Day Book's Alter is `demoted` and its
 *     view options are keyless (`NO_KEY`) checkable items; the 2.0 keys stay registered.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => fs.readFileSync(path.join(modulesDir, rel), 'utf8');

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push({ file: path.relative(modulesDir, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

/** Labels bound to `key` in a source: `key: 'K', label: …` actions and `'K': () =>` hotkey maps. */
function uses(text: string, key: string): string[] {
  const k = key.replace(/\+/g, '\\+');
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(`key:\\s*'${k}'\\s*,\\s*label:\\s*([^\\n,]+)`, 'g'))) out.push(m[1].trim());
  for (const m of text.matchAll(new RegExp(`'(?:[^']*, )?${k}(?:, [^']*)?'\\s*:\\s*(?:\\(|[a-z])`, 'g'))) out.push(`(hotkey) ${m[0]}`);
  return out;
}

/** Files of every module's `voucherPanels: [A, B]`, resolved through the module index's imports. */
function voucherPanelFiles(): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const index = path.join(modulesDir, e.name, 'index.ts');
    if (!fs.existsSync(index)) continue;
    const text = fs.readFileSync(index, 'utf8');
    const list = /voucherPanels:\s*\[([^\]]*)\]/.exec(text);
    if (!list) continue;
    for (const raw of list[1].split(',')) {
      const name = raw.trim();
      if (!name) continue;
      const imp = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g)].find((m) => m[1].split(',').some((n) => n.trim() === name));
      assert.ok(imp, `${e.name}/index.ts: cannot find the import of ${name}`);
      out.push(`${e.name}/${imp[2]}`);
    }
  }
  return out;
}

describe('2.1 keys: Day Book and voucher lists (Ctrl+F)', () => {
  for (const file of ['vouchers/DayBookScreen.tsx', 'vouchers/VoucherListScreen.tsx']) {
    it(`${file}: Ctrl+F focuses the one search field`, () => {
      const src = read(file);
      assert.deepEqual(uses(src, 'Ctrl+F'), ["'Search'"]);
      assert.match(src, /key: 'Ctrl\+F', label: 'Search', icon: 'search', onClick: focusSearch,/);
      // After the frame: chosen from More ▾, the closing menu first gives the focus back to its own button.
      assert.match(src, /const focusSearch = \(\) => requestAnimationFrame\(\(\) => searchRef\.current\?\.focus\(\)\);/);
      assert.match(src, /<TextInput\s+ref=\{searchRef\}[\s\S]{0,200}aria-label="Search vouchers"[\s\S]{0,120}aria-keyshortcuts="Control\+F"/);
    });
  }

  it('nothing else in the vouchers module binds Ctrl+F (entry, view, the shared table)', () => {
    const files = sources(path.join(modulesDir, 'vouchers')).filter((f) => !/^vouchers\/(DayBookScreen|VoucherListScreen)\.tsx$/.test(f.file));
    assert.ok(files.length > 10, `only ${files.length} files scanned`);
    assert.deepEqual(files.flatMap((f) => uses(f.text, 'Ctrl+F').map((u) => `${f.file}: ${u}`)), []);
  });

  it('Day Book: one date for one day, From – To for a range; Alt+F2 asks for the range and focuses From; Alt+T today', () => {
    const src = read('vouchers/DayBookScreen.tsx');
    assert.match(src, /<DateInput id="vch-db-from" aria-label=\{dates === 'single' \? 'Date' : 'From date'\}/);
    assert.match(src, /\{dates === 'range' \? \([\s\S]{0,120}<DateInput id="vch-db-to" aria-label="To date"/);
    assert.match(src, /const askRange = \(\) => \{\s*setRangeMode\(true\);\s*requestAnimationFrame\(\(\) => document\.getElementById\('vch-db-from'\)\?\.focus\(\)\);/);
    // Once shown, From – To stays until Alt+T: narrowing the range to one day never unmounts the focused To field.
    assert.match(src, /useEffect\(\(\) => \{\s*if \(range\.from !== range\.to\) setRangeMode\(true\);\s*\}, \[range\.from, range\.to\]\);/);
    assert.match(src, /const today = \(\) => \{\s*setRangeMode\(false\);/);
    assert.match(src, /key: 'Alt\+F2', label: 'Period', icon: 'calendar', onClick: askRange/);
    assert.match(src, /key: 'Alt\+T', label: 'Today', icon: 'clock', onClick: today/);
    assert.match(src, /aria-label=\{`Voucher types: \$\{types\}`\}/, 'the types menu button: label-in-name "Voucher types: All vouchers"');
  });

  it('Day Book: view options are keyless checkables in More; Alter is demoted, never hidden for it', () => {
    const src = read('vouchers/DayBookScreen.tsx');
    for (const label of ['Show optional vouchers', 'Show cancelled vouchers', 'Date range…']) assert.match(src, new RegExp(`key: NO_KEY, label: '${label}'`), label);
    assert.match(src, /key: NO_KEY, label: `Whole period \(/);
    // A checkable item toggles: a ticked "Whole period" goes back to the one working date.
    assert.match(src, /onClick: whole \? today : wholePeriod, group: 'view', checked: whole \}/);
    assert.match(src, /checked: includeOptional \}/);
    assert.match(src, /checked: includeCancelled \}/);
    const table = read('vouchers/VoucherTable.tsx');
    assert.match(table, /key: 'Alt\+A',\s*label: 'Alter',[\s\S]{0,700}hidden: !canAlter,[\s\S]{0,200}demoted: true,/, 'Alter keeps Alt+A (only a missing permission hides it)');
    // Rule 2: the 2.0 row actions keep their keys.
    for (const k of ['Alt+Enter', 'Ctrl+P', 'Alt+2', 'Alt+D']) assert.equal(uses(table, k).length, 1, k);
  });
});

describe('2.1 keys: voucher view (Alt+F1 Detailed)', () => {
  it('Alt+F1 is "Detailed", a checkable item that flips the remembered voucherDetailed preference', () => {
    const src = read('vouchers/VoucherViewScreen.tsx');
    assert.deepEqual(uses(src, 'Alt+F1'), ["'Detailed'"]);
    assert.match(src, /key: 'Alt\+F1', label: 'Detailed', icon: 'list', onClick: \(\) => setUiPrefs\(\{ voucherDetailed: !detailed \}\), hidden: !v, group: 'view', checked: detailed \}/);
    assert.match(src, /const detailed = useUiPrefs\(\)\.voucherDetailed;/);
    assert.doesNotMatch(src, /localStorage/, 'preferences only through useUiPrefs() / setUiPrefs()');
  });

  it('no voucherPanels module binds Alt+F1 (one key space with the view)', () => {
    const panels = voucherPanelFiles();
    assert.ok(panels.length >= 9, `only ${panels.length} voucher panels found: ${panels.join(', ')}`);
    for (const m of ['attachments', 'cheques', 'documents', 'forex', 'gst', 'pos', 'print', 'tds']) assert.ok(panels.some((p) => p.startsWith(`${m}/`)), `${m} panel not found`);
    // Key constants (`export const X_KEY = 'Alt+F1'`) anywhere in the modules, then their use in a panel file.
    const all = sources(modulesDir);
    const altF1Consts = all.flatMap((f) => [...f.text.matchAll(/export const ([A-Z_]+) = 'Alt\+F1'/g)].map((m) => m[1]));
    const taken: string[] = [];
    for (const file of panels) {
      const text = read(file);
      for (const u of uses(text, 'Alt+F1')) taken.push(`${file}: ${u}`);
      if (/['"`]Alt\+F1['"`]/.test(text)) taken.push(`${file}: an 'Alt+F1' literal`);
      for (const c of altF1Consts) if (new RegExp(`\\b${c}\\b`).test(text)) taken.push(`${file}: ${c}`);
    }
    assert.deepEqual(taken, []);
  });

  it('the view keeps every 2.0 key (none hidden for calm): Alt+A, Alt+P, Alt+2, Alt+H, Ctrl+R, Alt+X, Alt+D', () => {
    const src = read('vouchers/VoucherViewScreen.tsx');
    for (const k of ['Alt+A', 'Alt+P', 'Alt+2', 'Alt+H', 'Ctrl+R', 'Alt+X', 'Alt+D']) assert.equal(uses(src, k).length, 1, k);
    assert.doesNotMatch(src, /demoted: true/, 'nothing on the view is demoted: Alter (primary) and Print are its buttons');
  });
});
