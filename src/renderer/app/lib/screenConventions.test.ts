/**
 * Screen conventions across the real feature modules (app/README.md "Screen conventions",
 * CONVENTION_SHORTCUTS): screens never take a global key with another meaning, Alt+digit is only
 * "Duplicate" (Alt+2) — views and tabs switch with Ctrl+1…9 — and action labels use the Tally verb
 * "Create", not "New". The module screens import React, so their action keys are read from source.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reservedGlobalKeys } from './shortcuts.ts';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../modules');

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push({ file: path.relative(modulesDir, p), text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

/** Keys of screen actions: `{ key: 'Alt+C', label: … }` (comma-separated alternatives split). */
function actionKeys(text: string): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  for (const m of text.matchAll(/\{\s*key:\s*'([^']+)'\s*,\s*label:\s*([^,]+),/g)) {
    for (const k of m[1].split(',')) out.push({ key: k.trim().toLowerCase(), label: m[2].trim() });
  }
  return out;
}

/**
 * Global keys a screen may bind ONLY with the same meaning: F1 shortcuts, F10 voucher type
 * (voucher entry), F11/F12 features/configuration, Ctrl+H, and Alt+F2 (the screen's own period:
 * Day Book, GST returns). Everything else — voucher keys F4–F9 and their Ctrl/Alt variants,
 * F2, F3, Go To, Ctrl+Q — is never re-bound by a screen.
 */
const SAME_MEANING = new Set(['f1', 'ctrl+h', 'f10', 'f11', 'f12', 'alt+f2']);

describe('screen conventions (real modules)', () => {
  const files = sources(modulesDir);

  test('the scan sees the module screens', () => {
    const keys = files.flatMap((f) => actionKeys(f.text));
    assert.ok(keys.length > 200, `only ${keys.length} actions scanned`);
  });

  test('no screen action takes a reserved global key (e.g. Alt+F5 = Sales Order)', () => {
    const forbidden = new Set(reservedGlobalKeys().map((k) => k.toLowerCase()).filter((k) => !SAME_MEANING.has(k)));
    const clashes = files.flatMap((f) => actionKeys(f.text).filter((a) => forbidden.has(a.key)).map((a) => `${f.file}: ${a.key} (${a.label})`));
    assert.deepEqual(clashes, []);
  });

  test('Alt+digit only means Duplicate (Alt+2); views, tabs and copies use Ctrl+1…9', () => {
    const odd = files.flatMap((f) =>
      actionKeys(f.text)
        .filter((a) => /^alt\+[0-9]$/.test(a.key) && !(a.key === 'alt+2' && /Duplicate'/.test(a.label) && !/copy/i.test(a.label)))
        .map((a) => `${f.file}: ${a.key} (${a.label})`),
    );
    assert.deepEqual(odd, []);
  });

  test("action labels say 'Create …', not 'New …'", () => {
    const labels = files.flatMap((f) => [...f.text.matchAll(/\{\s*key:\s*'[^']+'\s*,\s*label:\s*(?:'|`)(New [^'`]*)/g)].map((m) => `${f.file}: ${m[1]}`));
    assert.deepEqual(labels, []);
  });
});
