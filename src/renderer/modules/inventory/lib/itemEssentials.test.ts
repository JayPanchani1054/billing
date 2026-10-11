/**
 * Stock Item form, 2.1 (SPEC-21 §1.8, D23, R11): Essentials per kind, the fields behind "More details",
 * the auto-reveal rule (a value or an error never hides) and Standard cost appearing with its method.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EssentialsContext } from './itemEssentials.ts';
import {
  detailsToggle,
  itemAlterContext,
  itemDetailFields,
  itemDetailsForced,
  itemEssentialFields,
  MORE_DETAILS_KEYS,
  MORE_DETAILS_KIND,
  moreDetailsAction,
  itemSaveLabel,
  moreDetailsSummary,
  revealingDetailFields,
  showStandardCost,
} from './itemEssentials.ts';
import { emptyItemDraft } from './itemForm.ts';
import type { ItemDraft } from './itemForm.ts';
import { emptyOpening } from './opening.ts';

const GST: EssentialsContext = { gstEnabled: true, pos: false, existing: false };
const NO_GST: EssentialsContext = { gstEnabled: false, pos: false, existing: false };
const POS: EssentialsContext = { gstEnabled: true, pos: true, existing: false };
const ALTER: EssentialsContext = { gstEnabled: true, pos: false, existing: true };

const draft = (p: Partial<ItemDraft> = {}): ItemDraft => ({ ...emptyItemDraft({ name: 'Steel Bolt M8' }), unitId: 1, ...p });

describe('Essentials per kind', () => {
  test('goods with GST: Name, Unit, Under, the GST switch, HSN, Applicable from, Selling price, Opening stock', () => {
    assert.deepEqual(itemEssentialFields(draft(), GST), ['name', 'unitId', 'groupId', 'gstApplicable', 'hsnSac', 'gstApplicableFrom', 'sellingPrice', 'openings']);
  });

  test('own GST details add the rate right after the switch (first-day flow: switch → GST rate → HSN code)', () => {
    const f = itemEssentialFields(draft({ gstApplicable: true }), GST);
    assert.deepEqual(f.slice(3, 6), ['gstApplicable', 'gstRate', 'hsnSac']);
    // Exempt / nil-rated / non-GST carry no rate.
    assert.ok(!itemEssentialFields(draft({ gstApplicable: true, taxability: 'exempt' }), GST).includes('gstRate'));
  });

  test('without GST no GST row; a service keeps no opening stock', () => {
    assert.deepEqual(itemEssentialFields(draft(), NO_GST), ['name', 'unitId', 'groupId', 'sellingPrice', 'openings']);
    assert.ok(!itemEssentialFields(draft({ isService: true }), GST).includes('openings'));
  });

  test('Barcode is an Essential only when POS is on (scanned at the counter); otherwise it is a detail', () => {
    assert.ok(itemEssentialFields(draft(), POS).includes('barcode'));
    assert.ok(!itemDetailFields(draft(), POS).includes('barcode'));
    assert.ok(!itemEssentialFields(draft(), GST).includes('barcode'));
    assert.ok(itemDetailFields(draft(), GST).includes('barcode'));
  });

  test('Essentials and details never share a field', () => {
    for (const ctx of [GST, NO_GST, POS, ALTER]) {
      for (const d of [draft(), draft({ gstApplicable: true }), draft({ isService: true }), draft({ costingMethod: 'std_cost', maintainBatches: true })]) {
        const ess = new Set(itemEssentialFields(d, ctx));
        assert.deepEqual(itemDetailFields(d, ctx).filter((f) => ess.has(f)), []);
      }
    }
  });
});

describe('More details', () => {
  test('holds the rest of the item (aliases, category, alternate unit, cess, MRP, costing, reorder, batches)', () => {
    const f = itemDetailFields(draft({ gstApplicable: true, maintainBatches: true }), ALTER);
    for (const k of ['alias', 'moreAliases', 'partNo', 'description', 'categoryId', 'isService', 'altUnitId', 'altConversion', 'inactive', 'taxability', 'cessRate', 'cessPerUnit', 'rateInclusiveOfTax', 'mrp', 'purchasePrice', 'costingMethod', 'reorderLevel', 'minOrderQty', 'maintainBatches', 'trackMfgDate', 'useExpiry'] as const) {
      assert.ok(f.includes(k), `${k} is behind More details`);
    }
    // A new item has no Active switch; a service no stock fields.
    assert.ok(!itemDetailFields(draft(), GST).includes('inactive'));
    const svc = itemDetailFields(draft({ isService: true }), GST);
    for (const k of ['altUnitId', 'costingMethod', 'reorderLevel', 'maintainBatches'] as const) assert.ok(!svc.includes(k), k);
  });

  test('a new, plain item keeps it collapsed (every detail empty or at its default)', () => {
    assert.equal(itemDetailsForced(draft(), {}, GST), false);
    assert.equal(itemDetailsForced(draft({ gstApplicable: true, gstRate: 18, hsnSac: '7318', sellingPrice: 1000, openings: [emptyOpening(1)] }), {}, GST), false);
    assert.deepEqual(revealingDetailFields(draft(), null, GST), []);
  });

  test('opens by itself for any value other than the default (Alteration never hides data)', () => {
    const cases: Array<[Partial<ItemDraft>, string]> = [
      [{ alias: 'M8 bolt' }, 'alias'],
      [{ moreAliases: 'SB-8' }, 'moreAliases'],
      [{ partNo: 'P-1' }, 'partNo'],
      [{ barcode: '8901234567890' }, 'barcode'],
      [{ description: 'Zinc plated' }, 'description'],
      [{ categoryId: 4 }, 'categoryId'],
      [{ isService: true }, 'isService'],
      [{ altUnitId: 2, altConversion: 12 }, 'altUnitId'],
      [{ mrp: 2500 }, 'mrp'],
      [{ purchasePrice: 800 }, 'purchasePrice'],
      [{ costingMethod: 'fifo' }, 'costingMethod'],
      [{ reorderLevel: 10 }, 'reorderLevel'],
      [{ minOrderQty: 50 }, 'minOrderQty'],
      [{ maintainBatches: true }, 'maintainBatches'],
      [{ rateInclusiveOfTax: true }, 'rateInclusiveOfTax'],
      [{ gstApplicable: true, taxability: 'exempt' }, 'taxability'],
      [{ gstApplicable: true, gstRate: 28, cessRate: 12 }, 'cessRate'],
    ];
    for (const [p, field] of cases) {
      assert.equal(itemDetailsForced(draft(p), {}, GST), true, field);
      assert.ok(revealingDetailFields(draft(p), {}, GST).includes(field), field);
    }
  });

  test('an inactive item (Active: No) opens it on Alteration', () => {
    assert.equal(itemDetailsForced(draft({ isActive: false }), {}, ALTER), true);
    assert.deepEqual(revealingDetailFields(draft({ isActive: false }), {}, ALTER), ['inactive']);
    assert.equal(itemDetailsForced(draft({ isActive: true }), {}, ALTER), false);
  });

  test('opens by itself for an error inside it — server alias errors included — but not for an Essential error', () => {
    assert.equal(itemDetailsForced(draft(), { mrp: 'MRP cannot be negative' }, GST), true);
    assert.equal(itemDetailsForced(draft(), { 'aliases.1': 'Used by another item' }, GST), true);
    assert.deepEqual(revealingDetailFields(draft(), { 'aliases.1': 'Used by another item' }, GST), ['moreAliases']);
    assert.equal(itemDetailsForced(draft({ costingMethod: 'std_cost' }), { standardCost: 'Enter the standard cost' }, GST), true);
    assert.equal(itemDetailsForced(draft(), { name: 'Enter the stock item name', unitId: 'Choose the unit', 'openings.0.qty': 'Enter a quantity' }, GST), false);
    assert.equal(itemDetailsForced(draft(), { mrp: undefined }, GST), false, 'a cleared error is no error');
  });

  test('values of fields that do not apply never force it (a service’s leftover stock fields)', () => {
    // Batches and costing are not offered for a service: their values do not count — but the service switch does.
    assert.deepEqual(revealingDetailFields(draft({ isService: true, costingMethod: 'fifo', maintainBatches: true }), {}, GST), ['isService']);
  });
});

describe('Standard cost appears with the Standard cost method', () => {
  test('only for std_cost, or while it still holds a figure', () => {
    assert.equal(showStandardCost({ costingMethod: 'avg_cost', standardCost: null }), false);
    assert.equal(showStandardCost({ costingMethod: 'std_cost', standardCost: null }), true);
    assert.equal(showStandardCost({ costingMethod: 'fifo', standardCost: 1250 }), true);
    assert.ok(itemDetailFields(draft({ costingMethod: 'std_cost' }), GST).includes('standardCost'));
    assert.ok(!itemDetailFields(draft(), GST).includes('standardCost'));
  });
});

describe('the More details line and its key', () => {
  test('Ctrl+I with Alt+F1 as its alias, remembered under one form kind', () => {
    assert.equal(MORE_DETAILS_KEYS, 'Ctrl+I, Alt+F1');
    assert.equal(MORE_DETAILS_KIND, 'stockItem');
  });

  test('the More ▾ item: keys registered, demoted (the page line is the visible control), checked while open', () => {
    let toggled = 0;
    const a = moreDetailsAction(true, () => toggled++);
    assert.equal(a.key, 'Ctrl+I, Alt+F1');
    assert.equal(a.label, 'More details');
    assert.equal(a.demoted, true);
    assert.equal(a.hidden, undefined, 'never hidden: hidden actions register no key');
    assert.equal(a.checked, true);
    assert.equal(moreDetailsAction(false, () => {}).checked, false);
    a.onClick();
    assert.equal(toggled, 1);
  });

  test('the closed line names a short taste of what is inside, by kind', () => {
    assert.equal(moreDetailsSummary(draft()), 'alias, category, alternate unit, MRP, purchase price, costing, reorder …');
    assert.equal(moreDetailsSummary(draft({ isService: true })), 'alias, category, MRP, purchase price …');
  });
});

describe('Ctrl+I / Alt+F1 and the line', () => {
  test('closed → open: remembered, and the key moves the cursor into the section', () => {
    assert.deepEqual(detailsToggle({ open: false, forced: false, fromKey: true, focusInside: false }), { remember: true, focus: 'section' });
    assert.deepEqual(detailsToggle({ open: false, forced: false, fromKey: false, focusInside: false }), { remember: true, focus: null });
  });

  test('open → closed: remembered; closing from inside puts the cursor on the line (never lost in a hidden field)', () => {
    assert.deepEqual(detailsToggle({ open: true, forced: false, fromKey: true, focusInside: true }), { remember: false, focus: 'line' });
    assert.deepEqual(detailsToggle({ open: true, forced: false, fromKey: true, focusInside: false }), { remember: false, focus: null });
    assert.deepEqual(detailsToggle({ open: true, forced: false, fromKey: false, focusInside: false }), { remember: false, focus: null });
  });

  test('held open by a value or an error: the key jumps in and out instead of doing nothing, and nothing is remembered', () => {
    assert.deepEqual(detailsToggle({ open: true, forced: true, fromKey: true, focusInside: false }), { remember: null, focus: 'section' });
    assert.deepEqual(detailsToggle({ open: true, forced: true, fromKey: true, focusInside: true }), { remember: null, focus: 'line' });
    assert.deepEqual(detailsToggle({ open: true, forced: true, fromKey: false, focusInside: false }), { remember: null, focus: null });
  });
});

describe('title row', () => {
  test('the commit label: "Save & create next" (Creation), "Save" (Alteration), "Save & return" (from a picker)', () => {
    assert.equal(itemSaveLabel({ existing: false, forResult: false }), 'Save & create next');
    assert.equal(itemSaveLabel({ existing: true, forResult: false }), 'Save');
    assert.equal(itemSaveLabel({ existing: false, forResult: true }), 'Save & return');
    assert.equal(itemSaveLabel({ existing: true, forResult: true }), 'Save & return');
  });

  test('Alteration context run: the group (Primary when none) and "Inactive" — not the name, which the Name field shows', () => {
    assert.equal(itemAlterContext({ groupName: 'Fasteners', isActive: true }), 'Fasteners');
    assert.equal(itemAlterContext({ groupName: null, isActive: true }), 'Primary');
    assert.equal(itemAlterContext({ groupName: 'Fasteners', isActive: false }), 'Fasteners · Inactive');
  });
});
