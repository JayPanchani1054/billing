/**
 * Gateway / Go To labels of the real feature modules: unique, and the everyday reports keep their
 * accelerator letters. The module index files import screens (.tsx), so this reads their static
 * menu entries from source (`{ section: '…', label: '…', screen: '…', … }`); generated entries
 * (registers, voucher entry types) are added from their pure sources.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REGISTERS } from '../../modules/reports/lib/model.ts';
import { voucherMenuEntries } from '../../modules/vouchers/lib/menu.ts';
import type { MenuItem, MenuSection, ModuleDef } from '../registry.ts';
import { VOUCHER_FEATURE } from './shortcuts.ts';
import { buildGateway } from './menu.ts';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../modules');

/** Static menu items of one module's index.ts. */
function scanMenu(source: string): MenuItem[] {
  const out: MenuItem[] = [];
  const re = /section:\s*'([a-z_]+)'\s*,\s*label:\s*'([^']+)'\s*,\s*screen:\s*'([^']+)'([^}]*?(?:\{[^}]*\}[^}]*?)?)\}/g;
  for (const m of source.matchAll(re)) {
    const rest = m[4];
    const item: MenuItem = { section: m[1] as MenuSection, label: m[2], screen: m[3] };
    const hotkey = /hotkey:\s*'([^']+)'/.exec(rest);
    if (hotkey) item.hotkey = hotkey[1];
    if (/params:\s*\{/.test(rest)) item.params = { scanned: true };
    const order = /order:\s*([\d.]+)/.exec(rest);
    if (order) item.order = Number(order[1]);
    out.push(item);
  }
  return out;
}

function realModules(): ModuleDef[] {
  const mods: ModuleDef[] = [];
  for (const dir of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    const file = path.join(modulesDir, dir.name, 'index.ts');
    if (!dir.isDirectory() || !fs.existsSync(file)) continue;
    mods.push({ id: dir.name, screens: [], menu: scanMenu(fs.readFileSync(file, 'utf8')) });
  }
  const generated: MenuItem[] = [
    ...REGISTERS.map((r, i): MenuItem => ({ section: 'reports', label: r.label, screen: 'reports.register', params: { baseType: r.baseType }, order: 20 + i })),
    ...voucherMenuEntries(VOUCHER_FEATURE).map((e): MenuItem => ({ section: 'transactions', label: e.label, screen: 'vouchers.entry', params: { baseType: e.baseType }, order: e.order, ...(e.hotkey ? { hotkey: e.hotkey } : {}) })),
  ];
  mods.push({ id: 'generated', screens: [], menu: generated });
  return mods;
}

describe('real Gateway labels', () => {
  const mods = realModules();
  const items = mods.flatMap((m) => m.menu ?? []);

  test('the scan finds the menus of every module', () => {
    assert.ok(items.length > 60, `only ${items.length} items scanned`);
    for (const label of ['Balance Sheet', 'Trial Balance', 'Day Book', 'Ledgers', 'GSTR-1', 'Backup', 'Stock Summary']) {
      assert.ok(items.some((i) => i.label === label), `${label} not scanned`);
    }
  });

  test('labels are unique across the whole Gateway (Go To shows them side by side)', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const i of items) {
      const key = i.label.toLowerCase();
      if (seen.has(key)) dupes.push(`${i.label} (${seen.get(key)} and ${i.screen})`);
      else seen.set(key, i.screen);
    }
    assert.deepEqual(dupes, []);
  });

  test('the everyday reports and masters get accelerator letters; voucher entries (F-keys) do not', () => {
    const sections = buildGateway(mods, { can: () => true, gstEnabled: true, features: null });
    const built = sections.flatMap((s) => s.items);
    const accel = (label: string) => built.find((i) => i.label === label)?.accelerator ?? null;
    assert.equal(accel('Balance Sheet'), 'b');
    assert.equal(accel('Profit & Loss A/c'), 'p');
    assert.equal(accel('Trial Balance'), 't');
    assert.equal(accel('Day Book'), 'd');
    assert.equal(accel('Ledger'), 'l');
    assert.equal(accel('Stock Summary'), 's');
    for (const label of ['Receivables', 'Payables', 'GSTR-1', 'GSTR-3B', 'Bank Reconciliation', 'Cash/Bank Books', 'Ledgers', 'Stock Items', 'Backup']) {
      assert.notEqual(accel(label), null, `${label} has no accelerator`);
    }
    for (const label of ['Sales', 'Purchase', 'Contra', 'Credit Note']) assert.equal(accel(label), null, `${label} uses its F-key`);
    const letters = built.map((i) => i.accelerator).filter((a): a is string => a !== null);
    assert.equal(new Set(letters).size, letters.length, 'unique');
  });
});
