import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StockItemDetail } from '../../../../shared/types/inventory.ts';
import {
  costingInfo,
  effectiveGstText,
  emptyItemDraft,
  formErrorKey,
  gstDetailsChanged,
  gstSummary,
  hsnHint,
  inheritedGroupGst,
  inheritedGstText,
  itemDraftDirty,
  itemDraftFromDetail,
  itemDraftWarnings,
  itemSaveInput,
  validateItemDraft,
} from './itemForm.ts';
import type { ItemFormContext } from './itemForm.ts';
import { editOpening, emptyOpening } from './opening.ts';

const ctx: ItemFormContext = {
  gstEnabled: true,
  hsnDigits: 4,
  hasGstHistory: false,
  opening: { multipleGodowns: false, batches: false, trackMfgDate: false, useExpiry: false, unitSymbol: 'Nos', unitDecimals: 0 },
};

function detail(over: Partial<StockItemDetail> = {}): StockItemDetail {
  return {
    id: 5,
    guid: 'g',
    name: 'Steel Bottle 1L',
    alias: null,
    partNo: null,
    barcode: null,
    description: null,
    groupId: 2,
    groupName: 'Kitchen',
    categoryId: null,
    categoryName: null,
    unitId: 1,
    unitSymbol: 'Nos',
    unitDecimals: 0,
    altUnitId: null,
    altUnitSymbol: null,
    altConversion: null,
    maintainBatches: false,
    trackMfgDate: false,
    useExpiry: false,
    costingMethod: 'avg_cost',
    marketValuation: 'avg_price',
    isService: false,
    gstApplicable: true,
    hsnSac: '7323',
    taxability: 'taxable',
    gstRate: 18,
    cessRate: 0,
    cessPerUnit: 0,
    rateInclusiveOfTax: false,
    mrp: 49900,
    sellingPrice: 35000,
    purchasePrice: 25000,
    standardCost: null,
    reorderLevel: 10,
    minOrderQty: null,
    isActive: true,
    openings: [{ id: 1, godownId: 1, godownName: 'Main Location', batchName: null, mfgDate: null, expiryDate: null, qty: 24, rate: 250, value: 600000 }],
    openingTotal: { qty: 24, value: 600000 },
    gstHistory: [],
    effectiveGst: null,
    priceLists: [],
    hasTransactions: false,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

test('new item: required fields and GST checks', () => {
  const d = { ...emptyItemDraft({ name: ' ' }), gstApplicable: true };
  const e = validateItemDraft(d, null, ctx);
  assert.match(e.name, /Enter the stock item name/);
  assert.match(e.unitId, /Choose the unit/);
  assert.match(e.gstRate, /Enter the GST rate/);
  const odd = validateItemDraft({ ...d, name: 'X', unitId: 1, gstRate: 13 }, null, ctx);
  assert.match(odd.gstRate, /not a notified GST rate/);
  assert.equal(validateItemDraft({ ...d, name: 'X', unitId: 1, gstRate: 13, allowNonStandardRate: true }, null, ctx).gstRate, undefined);
  const svc = validateItemDraft({ ...d, name: 'Repair', unitId: 1, gstRate: 18, isService: true, hsnSac: '8471' }, null, ctx);
  assert.match(svc.hsnSac, /SAC \(services\) codes start with 99/);
  const alt = validateItemDraft({ ...d, name: 'X', unitId: 1, gstRate: 18, altUnitId: 1 }, null, ctx);
  assert.match(alt.altUnitId, /different from the base unit/);
  const std = validateItemDraft({ ...d, name: 'X', unitId: 1, gstRate: 18, costingMethod: 'std_cost' }, null, ctx);
  assert.match(std.standardCost, /Standard Cost/);
});

test('opening grid errors are keyed like the API paths', () => {
  const d = { ...emptyItemDraft({ name: 'X' }), unitId: 1, openings: [editOpening(emptyOpening(), 'qty', 2.5)] };
  const e = validateItemDraft(d, null, ctx);
  assert.match(e['openings.0.qty'], /whole numbers/);
  assert.equal(formErrorKey('openings[0].qty'), 'openings.0.qty');
});

test('round trip: unchanged item is not dirty and sends no GST or openings', () => {
  const saved = detail();
  const d = itemDraftFromDetail(saved);
  assert.equal(itemDraftDirty(d, itemDraftFromDetail(saved)), false);
  assert.deepEqual(validateItemDraft(d, saved, ctx), {});
  const input = itemSaveInput(d, saved, ctx);
  assert.equal(input.id, 5);
  assert.equal(input.gstRate, undefined);
  assert.equal(input.gstApplicable, undefined);
  assert.equal(input.hsnSac, undefined);
  assert.equal(input.openings, undefined);
  assert.equal(input.sellingPrice, 35000);
});

test('changing the rate sends the GST block; with history it needs a date', () => {
  const saved = detail({ gstHistory: [{ id: 1, applicableFrom: '2025-09-22', hsnSac: '7323', taxability: 'taxable', rate: 18, cessRate: 0, cessPerUnit: 0 }] });
  const d = { ...itemDraftFromDetail(saved), gstRate: 5 };
  assert.equal(gstDetailsChanged(d, saved), true);
  const hctx = { ...ctx, hasGstHistory: true };
  assert.match(validateItemDraft(d, saved, hctx).gstApplicableFrom, /from which date/);
  const dated = { ...d, gstApplicableFrom: '2026-10-01' };
  assert.deepEqual(validateItemDraft(dated, saved, hctx), {});
  const input = itemSaveInput(dated, saved, hctx);
  assert.equal(input.gstApplicable, true);
  assert.equal(input.taxability, 'taxable');
  assert.equal(input.gstRate, 5);
  assert.equal(input.hsnSac, '7323');
  assert.equal(input.gstApplicableFrom, '2026-10-01');
  // HSN is part of the item's own GST details.
  assert.equal(gstDetailsChanged({ ...itemDraftFromDetail(saved), hsnSac: '732393' }, saved), true);
});

test('non-taxable sends no rate; turning own GST off sends only the switch', () => {
  const saved = detail();
  const exempt = itemSaveInput({ ...itemDraftFromDetail(saved), taxability: 'exempt' }, saved, ctx);
  assert.equal(exempt.taxability, 'exempt');
  assert.equal(exempt.gstRate, null);
  assert.equal(exempt.cessRate, null);
  const off = itemSaveInput({ ...itemDraftFromDetail(saved), gstApplicable: false }, saved, ctx);
  assert.equal(off.gstApplicable, false);
  assert.equal(off.taxability, undefined);
  assert.equal(off.gstRate, undefined);
});

test('changed opening stock is re-sent; services send none', () => {
  const saved = detail();
  const d = itemDraftFromDetail(saved);
  d.openings = [editOpening(d.openings[0], 'qty', 30)];
  // 30 × ₹250 = ₹7,500.00
  assert.deepEqual(itemSaveInput(d, saved, ctx).openings, [{ qty: 30, rate: 250, value: 750000 }]);
  const svc = itemSaveInput({ ...itemDraftFromDetail(saved), isService: true }, saved, ctx);
  assert.deepEqual(svc.openings, []);
  assert.equal(svc.maintainBatches, false);
  // A batch item switched to a service: the hidden batch settings are not an (invisible) error and are saved off.
  const was = { ...itemDraftFromDetail(saved), maintainBatches: true, useExpiry: true, isService: true, hsnSac: '998729', openings: [] };
  assert.deepEqual(validateItemDraft(was, saved, ctx), {});
  const out = itemSaveInput(was, saved, ctx);
  assert.deepEqual([out.maintainBatches, out.trackMfgDate, out.useExpiry], [false, false, false]);
});

test('warnings: HSN digits for turnover, selling above MRP', () => {
  const d = { ...emptyItemDraft({ name: 'X' }), unitId: 1, gstApplicable: true, gstRate: 18, hsnSac: '7323', mrp: 10000, sellingPrice: 12000 };
  const w = itemDraftWarnings(d, { ...ctx, hsnDigits: 6 });
  assert.match(w[0], /at least 6 digits/);
  assert.match(w[1], /above the MRP/);
});

test('MRP check uses the price the customer pays', () => {
  const base = { ...emptyItemDraft({ name: 'Bottle' }), unitId: 1, gstApplicable: true, gstRate: 18, hsnSac: '7323', mrp: 49900 };
  // ₹430 before GST + 18% = ₹430 + ₹77.40 = ₹507.40 > MRP ₹499: warned although ₹430 < ₹499.
  const w = itemDraftWarnings({ ...base, sellingPrice: 43000 }, ctx);
  assert.equal(w.length, 1);
  assert.match(w[0], /plus 18% GST is ₹ 507\.40, above the MRP of ₹ 499\.00/);
  // ₹420 + 18% = ₹495.60 ≤ ₹499: fine.
  assert.deepEqual(itemDraftWarnings({ ...base, sellingPrice: 42000 }, ctx), []);
  // Prices that include GST are compared as typed: ₹505 > ₹499 is warned, ₹499 is not.
  assert.match(itemDraftWarnings({ ...base, rateInclusiveOfTax: true, sellingPrice: 50500 }, ctx)[0], /selling price is above the MRP/);
  assert.deepEqual(itemDraftWarnings({ ...base, rateInclusiveOfTax: true, sellingPrice: 49900 }, ctx), []);
  // Inheriting 5% from the group: ₹480 + ₹24 = ₹504 > ₹499.
  const inh = { groupId: 2, groupName: 'Kitchen', taxability: 'taxable' as const, rate: 5, cessRate: 0, cessPerUnit: 0 };
  assert.match(itemDraftWarnings({ ...base, gstApplicable: false, gstRate: null, sellingPrice: 48000 }, { ...ctx, inheritedGst: inh })[0], /plus 5% GST is ₹ 504\.00/);
  // Exempt: no GST is added.
  assert.deepEqual(itemDraftWarnings({ ...base, taxability: 'exempt', gstRate: null, sellingPrice: 49000 }, ctx), []);
});

test('no GST anywhere in the chain is a warning; inherited GST is found up the group chain', () => {
  const d = { ...emptyItemDraft({ name: 'X', groupId: 3 }), unitId: 1 };
  assert.match(itemDraftWarnings(d, { ...ctx, inheritedGst: null })[0], /rate of the sales or purchase ledger/);
  assert.deepEqual(itemDraftWarnings(d, { ...ctx, inheritedGst: undefined }), []); // not known yet: no noise
  const groups = [
    { id: 1, name: 'Kitchen', parentId: null, gstApplicable: true, taxability: 'taxable' as const, gstRate: 18, cessRate: null, cessPerUnit: 0 },
    { id: 2, name: 'Steel', parentId: 1, gstApplicable: false, taxability: null, gstRate: null, cessRate: null, cessPerUnit: 0 },
    { id: 3, name: 'Bottles', parentId: 2, gstApplicable: false, taxability: null, gstRate: null, cessRate: null, cessPerUnit: 0 },
    { id: 4, name: 'Grains', parentId: null, gstApplicable: true, taxability: 'exempt' as const, gstRate: 0, cessRate: 0, cessPerUnit: 0 },
    { id: 5, name: 'Loop A', parentId: 6, gstApplicable: false, taxability: null, gstRate: null, cessRate: null, cessPerUnit: 0 },
    { id: 6, name: 'Loop B', parentId: 5, gstApplicable: false, taxability: null, gstRate: null, cessRate: null, cessPerUnit: 0 },
  ];
  const inh = inheritedGroupGst(groups, 3);
  assert.deepEqual(inh, { groupId: 1, groupName: 'Kitchen', taxability: 'taxable', rate: 18, cessRate: 0, cessPerUnit: 0 });
  assert.equal(inheritedGstText(inh), "Inherits 18% GST from the stock group 'Kitchen'.");
  assert.equal(inheritedGstText(inh, 'group'), "Inherits 18% GST from the parent group 'Kitchen'.");
  assert.equal(inheritedGroupGst(groups, 4)?.taxability, 'exempt');
  assert.equal(inheritedGroupGst(groups, null), null);
  assert.equal(inheritedGroupGst(groups, 5), null); // a cycle ends the walk
  assert.match(inheritedGstText(null), /sales or purchase ledger/);
});

test('texts', () => {
  assert.match(costingInfo('fifo').explain, /bought first/);
  assert.match(hsnHint(6, false), /at least 6 digits/);
  assert.match(hsnHint(4, true), /starts with 99/);
  assert.equal(gstSummary({ taxability: 'taxable', rate: 28, cessRate: 12 }), '28% GST + 12% cess');
  assert.equal(gstSummary({ taxability: 'nil_rated', rate: 0 }), 'Nil rated');
  assert.equal(
    effectiveGstText({ source: 'group_history', applicableFrom: '2025-09-22', taxability: 'taxable', rate: 5, cessRate: 0, cessPerUnit: 0 }, 'Kitchen'),
    "Today: 5% GST (from 22-Sep-2025), taken from the stock group 'Kitchen' or above it.",
  );
  assert.match(effectiveGstText(null, null), /sales or purchase ledger/);
});

test('a service saves no (hidden) alternate unit and is not checked for one', () => {
  const saved = detail({ altUnitId: 7, altUnitSymbol: 'Box', altConversion: 12 });
  // Switched to a service with a half-typed alternate unit left behind (the field is hidden then).
  const d = { ...itemDraftFromDetail(saved), isService: true, hsnSac: '998729', altConversion: null, openings: [] };
  assert.deepEqual(validateItemDraft(d, saved, ctx), {});
  const input = itemSaveInput(d, saved, ctx);
  assert.equal(input.altUnitId, null);
  assert.equal(input.altConversion, null);
  // Goods keep it: 1 Box = 12 Nos.
  const goods = itemSaveInput(itemDraftFromDetail(saved), saved, ctx);
  assert.deepEqual([goods.altUnitId, goods.altConversion], [7, 12]);
});

test('more aliases (dataplus): the list is sent when it changes, kept otherwise', () => {
  const saved = detail({ alias: 'MG750', aliases: ['MG750', 'SKU-1'] });
  const d = itemDraftFromDetail(saved);
  assert.equal(d.moreAliases, 'SKU-1');
  assert.equal(itemSaveInput(d, saved, ctx).aliases, undefined);
  assert.deepEqual(itemSaveInput({ ...d, moreAliases: 'SKU-1\nSKU-2' }, saved, ctx).aliases, ['MG750', 'SKU-1', 'SKU-2']);
  assert.equal(itemDraftDirty({ ...d, moreAliases: 'SKU-1\n' }, d), false);
  assert.equal(itemDraftDirty({ ...d, moreAliases: 'SKU-2' }, d), true);
  assert.match(validateItemDraft({ ...d, moreAliases: saved.name }, saved, ctx).moreAliases ?? '', /same as the name/);
});
