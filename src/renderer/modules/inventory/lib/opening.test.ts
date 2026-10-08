import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StockOpeningRow } from '../../../../shared/types/inventory.ts';
import {
  calculatedValue,
  editOpening,
  emptyOpening,
  isBlankOpening,
  openingDraftsFromRows,
  openingsChanged,
  openingTotals,
  openingWarnings,
  remapOpeningErrors,
  rowRate,
  rowValue,
  toOpeningInputs,
  validateOpenings,
} from './opening.ts';
import type { OpeningContext, OpeningDraft } from './opening.ts';

const ctx: OpeningContext = { multipleGodowns: false, batches: false, trackMfgDate: false, useExpiry: false, unitSymbol: 'Nos', unitDecimals: 0 };

const row = (over: Partial<OpeningDraft>): OpeningDraft => ({ ...emptyOpening(), ...over });

test('value is qty × rate in paise, rounded once', () => {
  // 3 × ₹33.335 = ₹100.005 → 10000.5 paise → 10001 (half away from zero)
  assert.equal(calculatedValue(3, 33.335), 10001);
  // 12.5 kg × ₹48.40 = ₹605.00
  assert.equal(calculatedValue(12.5, 48.4), 60500);
  assert.equal(calculatedValue(null, 10), null);
  assert.equal(calculatedValue(1e13, 1e10), null); // beyond ₹9,000 crore per line
});

test('typing qty and rate recalculates; a typed value overrides and survives qty changes', () => {
  let r = emptyOpening();
  r = editOpening(r, 'qty', 10);
  r = editOpening(r, 'rate', 100);
  assert.equal(rowValue(r), 100000); // 10 × ₹100 = ₹1,000.00
  assert.equal(r.valueOverridden, false);
  r = editOpening(r, 'value', 95000); // user types ₹950.00
  assert.equal(r.valueOverridden, true);
  assert.equal(rowValue(r), 95000);
  assert.equal(rowRate(r), 95); // 95000 / 100 / 10
  r = editOpening(r, 'qty', 20);
  assert.equal(rowValue(r), 95000); // kept
  assert.equal(rowRate(r), 47.5); // 950 / 20
  r = editOpening(r, 'rate', 50); // typing a rate goes back to calculated
  assert.equal(r.valueOverridden, false);
  assert.equal(rowValue(r), 100000); // 20 × ₹50
  // Typing exactly the calculated value is not an override; clearing the value recalculates.
  assert.equal(editOpening(r, 'value', 100000).valueOverridden, false);
  const cleared = editOpening(editOpening(r, 'value', 1), 'value', null);
  assert.equal(cleared.valueOverridden, false);
  assert.equal(rowValue(cleared), 100000);
});

test('totals skip blank rows and give the weighted rate', () => {
  const rows = [row({ qty: 10, rate: 100, value: 100000 }), row({ qty: 5, valueOverridden: true, value: 60000 }), emptyOpening()];
  // qty 15, value 1,00,000 + 60,000 = 1,60,000 p → rate ₹1,600 / 15 = 106.6667
  assert.deepEqual(openingTotals(rows), { qty: 15, value: 160000, rate: 106.6667 });
  assert.equal(isBlankOpening(emptyOpening(3)), true);
});

test('validation per cell', () => {
  const rows = [row({ qty: 1.5, rate: 10 }), row({ qty: 0, rate: 10 }), row({ rate: -1 }), emptyOpening()];
  const e = validateOpenings(rows, ctx);
  assert.match(e['0.qty'], /whole numbers only/);
  assert.match(e['1.qty'], /more than 0/);
  assert.match(e['2.qty'], /Enter the quantity/);
  assert.match(e['2.rate'], /negative/);
  assert.equal(Object.keys(e).some((k) => k.startsWith('3.')), false);

  const gctx: OpeningContext = { ...ctx, multipleGodowns: true, batches: true, trackMfgDate: true, useExpiry: true };
  const e2 = validateOpenings(
    [row({ qty: 1, godownId: null, batchName: '' }), row({ qty: 1, godownId: 2, batchName: 'B1', mfgDate: '2026-05-01', expiryDate: '2026-04-01' }), row({ qty: 2, godownId: 2, batchName: 'b1' })],
    gctx,
  );
  assert.match(e2['0.godownId'], /Choose the godown/);
  assert.match(e2['0.batchName'], /batch name/);
  assert.match(e2['1.expiryDate'], /before the manufacturing/);
  assert.match(e2['2.batchName'], /Same godown and batch as row 2/);
});

test('save rows: rate+value when calculated, value only when overridden, hidden columns dropped', () => {
  const rows = [
    row({ qty: 10, rate: 100, godownId: 4, batchName: 'X', mfgDate: '2026-01-01' }),
    row({ qty: 5, valueOverridden: true, value: 60000, godownId: 4 }),
    emptyOpening(),
  ];
  assert.deepEqual(toOpeningInputs(rows, ctx), [
    { qty: 10, rate: 100, value: 100000 },
    { qty: 5, value: 60000 },
  ]);
  const full: OpeningContext = { ...ctx, multipleGodowns: true, batches: true, trackMfgDate: true, useExpiry: false };
  assert.deepEqual(toOpeningInputs(rows, full)[0], { qty: 10, godownId: 4, batchName: 'X', mfgDate: '2026-01-01', rate: 100, value: 100000 });
});

test('saved rows round-trip and change detection', () => {
  const saved: StockOpeningRow[] = [
    { id: 1, godownId: 1, godownName: 'Main Location', batchName: null, mfgDate: null, expiryDate: null, qty: 10, rate: 100, value: 100000 },
    // Value-only row saved as ₹100 for 3: the core derived rate 33.333333; 3 × 33.333333 × 100 = 9999.9999 → 10000 = value.
    { id: 2, godownId: 1, godownName: 'Main Location', batchName: null, mfgDate: null, expiryDate: null, qty: 3, rate: 33.333333, value: 10000 },
    // 4 × ₹23.75 = ₹95.00 (9500 p) but ₹96.00 was stored: an override.
    { id: 3, godownId: 1, godownName: 'Main Location', batchName: null, mfgDate: null, expiryDate: null, qty: 4, rate: 23.75, value: 9600 },
  ];
  const drafts = openingDraftsFromRows(saved);
  assert.deepEqual(drafts.map((d) => d.valueOverridden), [false, false, true]);
  assert.deepEqual(drafts.map(rowValue), [100000, 10000, 9600]);
  assert.equal(rowRate(drafts[2]), 24); // 9600 / 100 / 4
  assert.equal(openingsChanged(saved, drafts, ctx), false);
  const edited = [...drafts];
  edited[0] = editOpening(edited[0], 'qty', 11);
  assert.equal(openingsChanged(saved, edited, ctx), true);
  assert.equal(openingsChanged(saved, drafts.slice(0, 2), ctx), true);
});

test('a rate change that leaves the value in paise unchanged is still a change', () => {
  const saved: StockOpeningRow[] = [{ id: 1, godownId: 1, godownName: 'Main Location', batchName: null, mfgDate: null, expiryDate: null, qty: 10, rate: 100, value: 100000 }];
  const drafts = openingDraftsFromRows(saved);
  // 10 × ₹100.0004 = ₹1,000.004 → 1,00,000.4 paise → 1,00,000: same value, different rate.
  const edited = [editOpening(drafts[0], 'rate', 100.0004)];
  assert.equal(rowValue(edited[0]), 100000);
  assert.equal(openingsChanged(saved, edited, ctx), true);
  assert.deepEqual(toOpeningInputs(edited, ctx), [{ qty: 10, rate: 100.0004, value: 100000 }]);
  // A typed value is compared by value alone (the core derives its rate).
  // 4 × ₹23.75 = ₹95.00 but ₹96.00 was stored (typed): unchanged, even though the core's rate is 23.75.
  const typed: StockOpeningRow[] = [{ id: 2, godownId: 1, godownName: 'Main Location', batchName: null, mfgDate: null, expiryDate: null, qty: 4, rate: 23.75, value: 9600 }];
  const t = openingDraftsFromRows(typed);
  assert.equal(t[0].valueOverridden, true);
  assert.equal(openingsChanged(typed, t, ctx), false);
  assert.equal(openingsChanged(typed, [editOpening(t[0], 'value', 9700)], ctx), true);
});

test('duplicate rows with no godown or batch column point at the quantity', () => {
  const e = validateOpenings([row({ qty: 5, rate: 10 }), row({ qty: 3, rate: 10 })], ctx);
  assert.match(e['1.qty'], /Row 1 already has the opening stock/);
  assert.equal(e['1.godownId'], undefined);
});

test('errors of hidden columns move to the row quantity', () => {
  const out = remapOpeningErrors({ '0.godownId': 'Row 1 already has opening stock for this godown', '0.qty': 'Enter the quantity', '1.rate': 'Rate cannot be negative', '2.expiryDate': 'Enter a batch first' }, ctx);
  assert.deepEqual(out, {
    '0.qty': 'Row 1 already has opening stock for this godown Enter the quantity',
    '1.rate': 'Rate cannot be negative',
    '2.qty': 'Enter a batch first',
  });
  // Shown columns keep their messages.
  const shown = remapOpeningErrors({ '0.godownId': 'Choose the godown' }, { ...ctx, multipleGodowns: true });
  assert.deepEqual(shown, { '0.godownId': 'Choose the godown' });
});

test('rows without a rate or value are flagged as valued at ₹0', () => {
  assert.deepEqual(openingWarnings([row({ qty: 5, rate: 10 }), row({ qty: 2 }), emptyOpening(), row({ qty: 1, valueOverridden: true, value: 500 })]), [
    'Opening stock row 2 has no rate or value, so it is valued at ₹0. Enter the cost if the stock cost something.',
  ]);
  assert.deepEqual(openingWarnings([row({ qty: 5, rate: 10 })]), []);
});
