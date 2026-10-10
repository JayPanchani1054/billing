/**
 * 2.0 key space of the voucher screens (source scan, like app/lib/keyConventions.test.ts): Ctrl+R means
 * "Change number" in voucher entry and voucher view and nowhere else; Alt+W shares the voucher in entry
 * (the convention meaning); no module panel shown on those screens takes either key; the new dialogs
 * and the Saved bar register no keys of their own besides Ctrl+A (accept).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONVENTION_SHORTCUTS } from '../../../app/lib/shortcuts.ts';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push({ file: path.relative(modulesDir, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

/** `key: 'X', label: …` actions (one line or spread over lines) and `'X': () =>` hotkey maps using `key`. */
function uses(text: string, key: string): string[] {
  const k = key.replace(/\+/g, '\\+');
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(`key:\\s*'${k}'\\s*,\\s*label:\\s*([^\\n,]+)`, 'g'))) out.push(m[1].trim());
  for (const m of text.matchAll(new RegExp(`'(?:[^']*, )?${k}(?:, [^']*)?'\\s*:\\s*(?:\\(|[a-z])`, 'g'))) out.push(`(hotkey) ${m[0]}`);
  return out;
}

describe('voucher screens: Ctrl+R change number, Alt+W share (2.0)', () => {
  const files = sources(modulesDir);
  const text = (f: string): string => files.find((x) => x.file === f)?.text ?? '';

  it('Ctrl+R is "Change number" in voucher entry and voucher view, and nowhere else', () => {
    const all = files.flatMap((f) => uses(f.text, 'Ctrl+R').map((u) => `${f.file}: ${u}`));
    assert.deepEqual(all.sort(), ["vouchers/VoucherViewScreen.tsx: 'Change number'", "vouchers/entry/VoucherEntryScreen.tsx: 'Change number'"]);
    assert.ok(CONVENTION_SHORTCUTS.some((s) => s.keys === 'Ctrl+R' && /voucher number/.test(s.label)), 'Ctrl+R is in the keyboard reference (shortcuts.ts)');
  });

  it('voucher entry: Alt+W shares the voucher being altered or just saved (hidden when there is none, greyed without Export)', () => {
    const entry = text('vouchers/entry/VoucherEntryScreen.tsx');
    assert.deepEqual(uses(entry, 'Alt+W'), ["'Share (e-mail / WhatsApp)'"]);
    assert.match(entry, /key: 'Alt\+W',[\s\S]{0,200}nav\.push\('print\.voucher', \{ id: printTarget\.id, share: true \}\)[\s\S]{0,120}hidden: printTarget === null[\s\S]{0,80}disabled: !canExport/);
  });

  it('the TDS / forex panels of entry and every voucher-view panel leave Ctrl+R free', () => {
    const panelFiles = files.filter((f) => /^(tds|forex|documents|attachments|cheques|pos|print|mfg|gst)\//.test(f.file));
    const taken = panelFiles.flatMap((f) => uses(f.text, 'Ctrl+R').map((u) => `${f.file}: ${u}`));
    assert.deepEqual(taken, []);
    // Entry panels (rendered inside voucher entry) never take Alt+W either.
    for (const f of ['tds/EntryPanel.tsx', 'forex/EntryPanel.tsx']) assert.deepEqual(uses(text(f), 'Alt+W'), [], f);
  });

  it('the Change Number dialog is all single-line fields, so Enter walks number → reason → "Use this number"', () => {
    const src = text('vouchers/ChangeNumberDialog.tsx');
    assert.match(src, /useEnterAdvance<HTMLElement>\(\{ onComplete: accept \}\)/);
    // A textarea takes plain Enter as a new line (ui/hooks/useEnterAdvance.ts): the dialog could not be finished by Enter.
    assert.doesNotMatch(src, /<TextArea\b/);
  });

  it('the Change Number dialog, the quick party dialog and the Saved bar register only Ctrl+A', () => {
    for (const f of ['vouchers/ChangeNumberDialog.tsx', 'accounts/QuickPartyDialog.tsx', 'vouchers/entry/SavedBar.tsx']) {
      const src = text(f);
      assert.ok(src.length > 0, `${f} scanned`);
      const maps = [...src.matchAll(/<Hotkeys map=\{\{([^}]*)\}\}/g)].map((m) => m[1]);
      for (const m of maps) assert.deepEqual([...m.matchAll(/'([^']+)'\s*:/g)].map((x) => x[1]), ['Ctrl+A'], f);
      assert.doesNotMatch(src, /useHotkeys\(/, f);
    }
  });
});
