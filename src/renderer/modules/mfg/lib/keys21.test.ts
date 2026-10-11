/**
 * 2.1 keeps every key (SPEC-21 §3.1, §3.4): each mfg screen file still registers every key it
 * registered in 2.0 — as an action's `key` (useScreenActions) or a `useHotkeys` map entry — even where
 * 2.1 moved the action out of sight (More ▾, a ticked view item). Checked per file, so a key dropped from
 * one screen fails even when another screen of the module binds the same key. Moving is dropping
 * `primary`/`prominent` or adding `demoted`/`checked`, never `hidden`: no action of these screens is
 * hidden by a literal `hidden: true`. Source scan (the screens import React).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (file: string): string => fs.readFileSync(path.join(dir, file), 'utf8');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.tsx'));

/** SPEC-21 §3.4, row "documents, mfg, pos (WP-L1)". */
const KEYS = ['Alt+2', 'Alt+A', 'Alt+B', 'Alt+C', 'Alt+D', 'Alt+Enter', 'Alt+H', 'Alt+I', 'Alt+N', 'Alt+O', 'Alt+P', 'Alt+X', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+A', 'Ctrl+D', 'Ctrl+F', 'Ctrl+L', 'Ctrl+T'];

/** The keys each screen file registered in 2.0 (`key:` literals, template keys verbatim, `useHotkeys` maps). */
const BY_FILE: Readonly<Record<string, readonly string[]>> = {
  'BomScreens.tsx': ['Alt+A', 'Alt+C', 'Alt+D', 'Alt+H', 'Alt+N', 'Ctrl+1', 'Ctrl+2', 'Ctrl+A', 'Ctrl+D', 'Ctrl+F', 'Ctrl+N'],
  'JobWorkOrderScreens.tsx': ['Alt+A', 'Alt+B', 'Alt+C', 'Alt+D', 'Alt+I', 'Alt+N', 'Alt+O', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+A', 'Ctrl+D', 'Ctrl+N'],
  'JournalEntryScreen.tsx': ['Alt+2', 'Alt+B', 'Alt+D', 'Alt+Enter', 'Alt+H', 'Alt+N', 'Alt+P', 'Alt+X', 'Ctrl+A', 'Ctrl+D', 'Ctrl+L', 'Ctrl+N', 'Ctrl+T'],
  'ReportScreens.tsx': ['Alt+A', 'Alt+C', 'Alt+I', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4'],
};

/** Every key a source registers (comma lists split: 'Alt+D, Ctrl+D'). */
function registered(src: string): Set<string> {
  const out = new Set<string>();
  const literals = [...src.matchAll(/\bkey:\s*([`'])([^`']+)\1/g)].map((m) => m[2]).concat([...src.matchAll(/'((?:Alt|Ctrl|Shift)\+[^']+)'\s*:/g)].map((m) => m[1]));
  for (const l of literals) for (const k of l.split(',')) out.add(k.trim());
  return out;
}

test('every screen file still registers each key it had in 2.0', () => {
  const lost: string[] = [];
  for (const [file, keys] of Object.entries(BY_FILE)) {
    const have = registered(source(file));
    for (const k of keys) if (!have.has(k)) lost.push(`${file}: ${k}`);
  }
  assert.deepEqual(lost, []);
});

test('every key of the module (SPEC-21 §3.4) is still registered', () => {
  const all = new Set(files.flatMap((f) => [...registered(source(f))]));
  assert.deepEqual(
    KEYS.filter((k) => !all.has(k)),
    [],
  );
});

test('no action is hidden by a literal (moving out of sight is demoted / checked / not prominent)', () => {
  assert.deepEqual(
    files.filter((f) => /\bhidden:\s*true\b/.test(source(f))),
    [],
  );
});
