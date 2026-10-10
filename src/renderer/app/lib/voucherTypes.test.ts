import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PREDEFINED_VOUCHER_TYPES } from '../../../shared/constants.ts';
import { customVoucherGotoItems, inactivePredefinedBaseTypes, parseVoucherCommand, voucherChoices, voucherCommand } from './voucherTypes.ts';
import { filterMenu } from './menu.ts';
import { voucherMenuEntries } from '../../modules/vouchers/lib/menu.ts';
import { VOUCHER_FEATURE } from './shortcuts.ts';
import type { VoucherTypeLike } from './voucherTypes.ts';

const predefined = (baseType: VoucherTypeLike['baseType'], id: number, isActive = true): VoucherTypeLike => {
  const t = PREDEFINED_VOUCHER_TYPES.find((p) => p.baseType === baseType);
  return { id, name: t?.name ?? baseType, alias: null, abbreviation: t?.abbreviation ?? null, baseType, isPredefined: true, isActive, hotkey: t?.hotkey ?? null };
};
const custom = (id: number, name: string, baseType: VoucherTypeLike['baseType'], isActive = true): VoucherTypeLike => ({ id, name, alias: null, abbreviation: 'Exp', baseType, isPredefined: false, isActive, hotkey: null });

describe('voucherChoices (F10)', () => {
  test('without the list (no masters.view / loading) → every predefined type', () => {
    const list = voucherChoices(undefined);
    assert.equal(list.length, PREDEFINED_VOUCHER_TYPES.length);
    assert.ok(list.every((c) => !c.custom && c.voucherTypeId === undefined));
    assert.equal(list.find((c) => c.baseType === 'sales')?.hotkey, 'F8');
  });

  test('company-defined active types follow the predefined ones, grouped by base type; inactive ones are dropped', () => {
    const rows = [
      predefined('sales', 1),
      predefined('purchase', 2),
      predefined('memorandum', 3, false),
      custom(40, 'Sales - Export', 'sales'),
      custom(41, 'Purchase - Imports', 'purchase'),
      custom(42, 'Contra - Branch', 'contra'),
      custom(43, 'Sales - Old Series', 'sales', false),
    ];
    const list = voucherChoices(rows);
    assert.equal(list.some((c) => c.baseType === 'memorandum'), false, 'deactivated predefined type');
    assert.equal(list.some((c) => c.name === 'Sales - Old Series'), false, 'deactivated custom type');
    const customs = list.filter((c) => c.custom);
    // Base-type order is the predefined order: Contra (F4) … Sales (F8), Purchase (F9).
    assert.deepEqual(customs.map((c) => c.name), ['Contra - Branch', 'Sales - Export', 'Purchase - Imports']);
    assert.deepEqual([customs[1].voucherTypeId, customs[1].baseType, customs[1].baseName], [40, 'sales', 'Sales']);
    assert.ok(list.findIndex((c) => c.custom) > list.findLastIndex((c) => !c.custom), 'predefined first');
  });

  test('Go To items for custom types open voucher entry with the type id', () => {
    const items = customVoucherGotoItems(voucherChoices([predefined('sales', 1), custom(40, 'Sales - Export', 'sales')]));
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Sales - Export');
    assert.equal(items[0].description, 'New voucher · Sales');
    assert.deepEqual(parseVoucherCommand(items[0].command ?? ''), { baseType: 'sales', voucherTypeId: 40 });
  });

  test('voucher commands round-trip; junk is rejected', () => {
    assert.deepEqual(parseVoucherCommand(voucherCommand('credit_note')), { baseType: 'credit_note' });
    assert.deepEqual(parseVoucherCommand(voucherCommand('sales', 7)), { baseType: 'sales', voucherTypeId: 7 });
    assert.equal(parseVoucherCommand('voucher:nonsense'), null);
    assert.equal(parseVoucherCommand('voucher-type:sales:0'), null);
    assert.equal(parseVoucherCommand('date'), null);
  });
});

describe('Transactions menu hides predefined voucher types the company deactivated', () => {
  test('inactivePredefinedBaseTypes: only predefined inactive rows; unknown list → null (all shown)', () => {
    assert.equal(inactivePredefinedBaseTypes(undefined), null);
    assert.equal(inactivePredefinedBaseTypes([]), null);
    const set = inactivePredefinedBaseTypes([predefined('sales', 1), predefined('sales_order', 2, false), custom(40, 'Memo - Old', 'memorandum', false)]);
    assert.deepEqual([...(set ?? [])], ['sales_order']);
  });

  test('filterMenu drops an entry item whose predefined type is inactive, keeps the rest', () => {
    const items = voucherMenuEntries(VOUCHER_FEATURE).map((e) => ({ section: 'transactions' as const, label: e.label, screen: 'vouchers.entry', params: { baseType: e.baseType }, voucherBaseType: e.baseType }));
    const ctx = { can: () => true, gstEnabled: true, features: null };
    const inactive = inactivePredefinedBaseTypes([predefined('sales', 1), predefined('sales_order', 2, false), predefined('memorandum', 3, false)]);
    const shown = filterMenu(items, { ...ctx, inactiveBaseTypes: inactive }).map((i) => i.params.baseType);
    assert.ok(shown.includes('sales'));
    assert.ok(!shown.includes('sales_order'));
    assert.ok(!shown.includes('memorandum'));
    assert.equal(filterMenu(items, { ...ctx, inactiveBaseTypes: null }).length, items.length, 'unknown → everything shown');
  });

  test('the vouchers module marks every entry item with its base type', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../../modules/vouchers/index.ts', import.meta.url), 'utf8');
    assert.match(src, /voucherBaseType: e\.baseType/);
  });
});
