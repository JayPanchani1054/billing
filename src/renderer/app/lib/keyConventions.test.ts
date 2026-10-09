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

  test('Alt+C creates — except the comparison column of a financial statement (Tally "New Column")', () => {
    const multi = [...files.flatMap((f) => [...f.text.matchAll(/key:\s*'Alt\+C',\s*label:\s*([^\n]+?),\s*(?:icon|onClick|primary|disabled|hidden)/g)].map((m) => ({ file: f.file, label: m[1].trim() })))];
    assert.ok(multi.length >= 15);
    const COMPARE = new Set(['reports/BalanceSheetScreen.tsx', 'reports/ProfitLossScreen.tsx']);
    const odd = multi.filter((a) => !/['`]Create/.test(a.label) && !COMPARE.has(a.file));
    assert.deepEqual(odd.map((a) => `${a.file}: ${a.label}`), []);
    assert.ok(multi.some((a) => a.file === 'banking/SummaryScreen.tsx' && a.label === "'Create bank ledger'"), 'Bank Overview: Alt+C creates a bank ledger');
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
