/**
 * Gateway menu positions: within a section no two items (from any module) share a position number, so
 * the order of the menu never depends on module registration order (final wave: "Opening Balance in
 * Currency" and "Payee Bank Details" were both 20 in Masters). Module index files import React, so the
 * menu entries are read from source.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../modules');

function menuItems(): Array<{ module: string; section: string; label: string; order: number }> {
  const out: Array<{ module: string; section: string; label: string; order: number }> = [];
  for (const e of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(modulesDir, e.name, 'index.ts');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\{\s*section:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'[^}]*?\border:\s*([\d.]+)/g)) {
      out.push({ module: e.name, section: m[1], label: m[2], order: Number(m[3]) });
    }
  }
  return out;
}

describe('Gateway menu positions', () => {
  test('the scan finds the menus of the feature modules', () => {
    const items = menuItems();
    assert.ok(items.some((i) => i.section === 'masters' && i.label === 'Opening Balance in Currency'));
    assert.ok(items.some((i) => i.section === 'masters' && i.label === 'Payee Bank Details'));
  });

  test('no two items of a section share a position', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const i of menuItems()) {
      const key = `${i.section}|${i.order}`;
      const other = seen.get(key);
      if (other) clashes.push(`${i.section} ${i.order}: "${other}" and "${i.label}" (${i.module})`);
      else seen.set(key, i.label);
    }
    assert.deepEqual(clashes, []);
  });
});
