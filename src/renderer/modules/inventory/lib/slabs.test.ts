import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySlab, itemSlabsFromList, netRate, nextSlabFrom, priceListChanges, slabErrors, slabGaps, slabRangeText } from './slabs.ts';
import type { SlabDraft } from './slabs.ts';

const s = (key: string, qtyFrom: number | null, qtyTo: number | null, rate: number | null, discountPct: number | null = null): SlabDraft => ({ key, itemId: 1, qtyFrom, qtyTo, rate, discountPct });

test('slab range text', () => {
  assert.equal(slabRangeText(0, 10), '0 to under 10');
  assert.equal(slabRangeText(1000, null), '1,000 and above');
  assert.equal(slabRangeText(2.5, 7.25), '2.5 to under 7.25');
});

test('touching slabs are fine; overlaps and open-ended middles are flagged on the later slab', () => {
  assert.deepEqual(slabErrors([s('a', 0, 10, 100), s('b', 10, 50, 95), s('c', 50, null, 90)]), {});
  // 'b' starts at 5, inside 0–10.
  const e = slabErrors([s('a', 0, 10, 100), s('b', 5, 20, 95)]);
  assert.match(e['b.qtyFrom'], /Overlaps the slab 0 to under 10/);
  // Open-ended first slab swallows everything after it (input order does not matter).
  const e2 = slabErrors([s('z', 20, null, 80), s('y', 0, null, 100)]);
  assert.match(e2['z.qtyFrom'], /Overlaps the slab 0 and above/);
  assert.equal(e2['y.qtyFrom'], undefined);
});

test('per-slab rules', () => {
  const e = slabErrors([s('a', 10, 10, 100), s('b', 0, 5, null), s('c', -1, 3, 5, 120)]);
  assert.match(e['a.qtyTo'], /more than 10/);
  assert.match(e['b.rate'], /Enter the rate/);
  assert.match(e['c.qtyFrom'], /negative/);
  assert.match(e['c.discountPct'], /between 0 and 100/);
  // Blank slab (only the default from 0) is ignored.
  assert.deepEqual(slabErrors([emptySlab(1)]), {});
});

test('gaps are reported, not errors', () => {
  assert.deepEqual(slabGaps([s('a', 0, 10, 100), s('b', 20, null, 90)]), ['10 to under 20']);
  assert.deepEqual(slabGaps([s('a', 5, null, 100)]), ['0 to under 5']);
  assert.deepEqual(slabGaps([s('a', 0, 10, 100), s('b', 10, null, 90)]), []);
});

test('next slab starts where the last one ends', () => {
  assert.equal(nextSlabFrom([s('a', 0, 10, 1), s('b', 10, 25, 1)]), 25);
  assert.equal(nextSlabFrom([]), 0);
});

test('net rate after discount', () => {
  assert.equal(netRate(100, 10), 90);
  assert.equal(netRate(99.99, 12.5), 87.4913); // 99.99 × 0.875 = 87.49125 → 87.4913
  assert.equal(netRate(null, 5), null);
});

test('changes: only items whose slabs changed; clearing only lists dated on the save date', () => {
  const loaded = itemSlabsFromList([
    { itemId: 1, itemName: 'Pen', unitSymbol: 'Nos', sellingPrice: 1000, applicableFrom: '2026-04-01', slabs: [{ qtyFrom: 0, qtyTo: null, rate: 10, discountPct: 0 }] },
    { itemId: 2, itemName: 'Ink', unitSymbol: 'Nos', sellingPrice: null, applicableFrom: null, slabs: [] },
    { itemId: 3, itemName: 'Pad', unitSymbol: 'Nos', sellingPrice: null, applicableFrom: '2026-10-01', slabs: [{ qtyFrom: 0, qtyTo: null, rate: 50, discountPct: 0 }] },
    { itemId: 4, itemName: 'Clip', unitSymbol: 'Nos', sellingPrice: null, applicableFrom: '2026-04-01', slabs: [{ qtyFrom: 0, qtyTo: null, rate: 2, discountPct: 0 }] },
  ]);
  assert.equal(loaded[1].slabs.length, 1); // a blank slab to type into
  const edited = loaded.map((it) => ({ ...it, slabs: it.slabs.map((x) => ({ ...x })) }));
  // Ink gets two slabs; Pad is cleared (its list is dated on the save date); Clip is cleared but dated earlier.
  edited[1].slabs = [s('i1', 0, 100, 25), s('i2', 100, null, 22, 5)].map((x) => ({ ...x, itemId: 2 }));
  edited[2].slabs = [];
  edited[3].slabs = [];
  const out = priceListChanges(edited, loaded, '2026-10-01');
  assert.deepEqual(out.rows, [
    { itemId: 2, qtyFrom: 0, qtyTo: 100, rate: 25, discountPct: 0 },
    { itemId: 2, qtyFrom: 100, qtyTo: null, rate: 22, discountPct: 5 },
  ]);
  assert.deepEqual(out.clearItemIds, [3]);
  assert.deepEqual(out.changedItemIds, [2, 3, 4]);
  // Clip's list is dated 01-Apr: emptying it on 01-Oct records nothing — the screen says so.
  assert.deepEqual(out.keptItemIds, [4]);
  // Only an earlier-dated list emptied: nothing at all to send.
  const onlyKept = priceListChanges(loaded.map((it) => (it.itemId === 4 ? { ...it, slabs: [] } : it)), loaded, '2026-10-01');
  assert.deepEqual([onlyKept.rows, onlyKept.clearItemIds, onlyKept.keptItemIds], [[], [], [4]]);
  // Unchanged slabs from an earlier list are not re-saved on the new date.
  assert.deepEqual(priceListChanges(loaded, loaded, '2026-10-01'), { rows: [], clearItemIds: [], changedItemIds: [], keptItemIds: [] });
});
