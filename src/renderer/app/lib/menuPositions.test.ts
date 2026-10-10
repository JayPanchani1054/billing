/**
 * Gateway menu positions: within a section no two items (from any module) share a position number, so
 * the order of the menu never depends on module registration order (final wave: "Opening Balance in
 * Currency" and "Payee Bank Details" were both 20 in Masters). Module index files import React, so the
 * menu entries are read from source; items with `params: { … }` (Material Out, Sales Bills Pending …)
 * are scanned too, and the generated entries (voucher entry types, registers) come from their pure
 * sources.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REGISTERS } from '../../modules/reports/lib/model.ts';
import { voucherMenuEntries } from '../../modules/vouchers/lib/menu.ts';
import { VOUCHER_FEATURE } from './shortcuts.ts';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../modules');

interface Positioned {
  module: string;
  section: string;
  label: string;
  order: number | null;
}

/** `{ section: '…', label: '…', … order: N … }` — one level of nested braces (params) allowed. */
function scanMenuPositions(source: string, module: string): Positioned[] {
  const out: Positioned[] = [];
  for (const m of source.matchAll(/\{\s*section:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'((?:[^{}]|\{[^{}]*\})*?)\}/g)) {
    const order = /\border:\s*([\d.]+)/.exec(m[3]);
    out.push({ module, section: m[1], label: m[2], order: order ? Number(order[1]) : null });
  }
  return out;
}

function menuItems(): Positioned[] {
  const out: Positioned[] = [];
  for (const e of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(modulesDir, e.name, 'index.ts');
    if (!fs.existsSync(file)) continue;
    out.push(...scanMenuPositions(fs.readFileSync(file, 'utf8'), e.name));
  }
  out.push(...REGISTERS.map((r, i): Positioned => ({ module: 'reports (generated)', section: 'reports', label: r.label, order: 20 + i })));
  out.push(...voucherMenuEntries(VOUCHER_FEATURE).map((e): Positioned => ({ module: 'vouchers (generated)', section: 'transactions', label: e.label, order: e.order })));
  return out;
}

describe('Gateway menu positions', () => {
  test('the scan finds the menus of the feature modules, including items with params', () => {
    const items = menuItems();
    assert.ok(items.some((i) => i.section === 'masters' && i.label === 'Opening Balance in Currency'));
    assert.ok(items.some((i) => i.section === 'masters' && i.label === 'Payee Bank Details'));
    // Items whose params come before `order` (they were invisible to the first version of this scan).
    assert.ok(items.some((i) => i.section === 'transactions' && i.label === 'Material Out' && i.order === 42));
    assert.ok(items.some((i) => i.section === 'inventory_reports' && i.label === 'Sales Bills Pending' && i.order === 52));
    assert.ok(items.some((i) => i.section === 'transactions' && i.label === 'Post-dated Vouchers' && i.order === 60));
    assert.ok(items.some((i) => i.label === 'Sales' && i.module === 'vouchers (generated)'));
  });

  test('a nested params object does not end the item early', () => {
    const src = "{ section: 'transactions', label: 'Material In', screen: 'mfg.journal.entry', params: { cls: 'material_in' }, order: 43, feature: 'jobWork' },";
    assert.deepEqual(scanMenuPositions(src, 'x'), [{ module: 'x', section: 'transactions', label: 'Material In', order: 43 }]);
  });

  test('every item of a parity-wave module has an explicit position', () => {
    const NEW = new Set(['tds', 'documents', 'mfg', 'attachments', 'forex', 'pos', 'cheques']);
    assert.deepEqual(
      menuItems()
        .filter((i) => NEW.has(i.module) && i.order === null)
        .map((i) => `${i.module}: ${i.label}`),
      [],
    );
  });

  test('no two items of a section share a position', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const i of menuItems()) {
      if (i.order === null) continue;
      const key = `${i.section}|${i.order}`;
      const other = seen.get(key);
      if (other) clashes.push(`${i.section} ${i.order}: "${other}" and "${i.label}" (${i.module})`);
      else seen.set(key, i.label);
    }
    assert.deepEqual(clashes, []);
  });
});
