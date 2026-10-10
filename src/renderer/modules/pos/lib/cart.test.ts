import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PosItem } from '../../../../shared/types/pos.ts';
import { addScanned, billLines, buildBillInput, deliveryFromDraft, lineMrp, lineValue, linesFromDraft, parseScan, priceFor, removeLine, setPrice, setQty, stepQty, toDraft, totalQty } from './cart.ts';

const item = (over: Partial<PosItem> = {}): PosItem => ({
  itemId: 1,
  name: 'Bath Soap',
  matchedBy: 'barcode',
  barcode: '890',
  partNo: null,
  unit: 'Nos',
  unitDecimals: 0,
  mrp: 5_900,
  sellingRate: 45,
  slabs: [],
  rateInclusiveOfTax: false,
  gstRate: 18,
  isService: false,
  maintainBatches: false,
  stock: 10,
  ...over,
});

describe('parseScan', () => {
  it('reads plain codes and qty*code', () => {
    assert.deepEqual(parseScan(' 8901234 '), { qty: 1, code: '8901234' });
    assert.deepEqual(parseScan('3*8901234'), { qty: 3, code: '8901234' });
    assert.deepEqual(parseScan('1.5 x rice'), { qty: 1.5, code: 'rice' });
    assert.deepEqual(parseScan('2×SP-01'), { qty: 2, code: 'SP-01' });
    assert.equal(parseScan('   '), null);
    // A code that merely contains an x stays a code.
    assert.deepEqual(parseScan('BOX-12'), { qty: 1, code: 'BOX-12' });
    assert.deepEqual(parseScan('0*abc'), { qty: 1, code: '0*abc' });
  });
});

describe('cart lines', () => {
  it('scanning the same item again adds to its line', () => {
    let r = addScanned([], item(), 1);
    r = addScanned(r.lines, item(), 2);
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].qty, 3);
    assert.equal(r.index, 0);
    r = addScanned(r.lines, item({ itemId: 2, name: 'Pen' }), 1);
    assert.equal(r.lines.length, 2);
    assert.equal(r.index, 1);
    assert.equal(totalQty(r.lines), 4);
  });

  it('a hand-priced or batch-wise line gets a new line on the next scan', () => {
    let r = addScanned([], item(), 1);
    const priced = setPrice(r.lines, 0, 40, 0);
    r = addScanned(priced, item(), 1);
    assert.equal(r.lines.length, 2);
    let b = addScanned([], item({ maintainBatches: true }), 1);
    b = addScanned(b.lines, item({ maintainBatches: true }), 1);
    assert.equal(b.lines.length, 2);
  });

  it('prices by quantity slab until the price is set by hand', () => {
    const slabbed = item({ slabs: [{ qtyFrom: 0, qtyTo: 6, rate: 45, discountPct: 0 }, { qtyFrom: 6, qtyTo: null, rate: 40, discountPct: 2 }] });
    assert.deepEqual(priceFor(slabbed, 5), { rate: 45, discountPct: 0 });
    assert.deepEqual(priceFor(slabbed, 6), { rate: 40, discountPct: 2 });
    let r = addScanned([], slabbed, 5);
    assert.equal(r.lines[0].rate, 45);
    r = addScanned(r.lines, slabbed, 1);
    assert.deepEqual([r.lines[0].qty, r.lines[0].rate, r.lines[0].discountPct], [6, 40, 2]);
    const hand = setPrice(r.lines, 0, 39, 0);
    assert.equal(setQty(hand, 0, 2)[0].rate, 39);
    assert.deepEqual(priceFor(item({ slabs: [] }), 3), { rate: 45, discountPct: 0 });
  });

  it('quantities follow the unit decimals; stepping to zero removes the line', () => {
    const kg = item({ unit: 'Kg', unitDecimals: 3 });
    let lines = addScanned([], kg, 1.2345).lines;
    assert.equal(lines[0].qty, 1.235);
    lines = setQty(lines, 0, 2.0004);
    assert.equal(lines[0].qty, 2);
    const nos = addScanned([], item(), 1).lines;
    assert.equal(stepQty(nos, 0, 1)[0].qty, 2);
    assert.equal(stepQty(nos, 0, -1).length, 0);
    assert.equal(removeLine(stepQty(nos, 0, 1), 0).length, 0);
  });

  it('line value and MRP in paise', () => {
    // 3 × ₹42.37 − 10 % = 127.11 × 0.9 = 114.399 → 11,440 paise.
    assert.equal(lineValue({ qty: 3, rate: 42.37, discountPct: 10 }), 11_440);
    assert.equal(lineMrp({ qty: 3, mrp: 5_900 }), 17_700);
    assert.equal(lineMrp({ qty: 3, mrp: null }), null);
  });

  it('builds the bill input (item invoice, godown, batch, POS block)', () => {
    let lines = addScanned([], item(), 2).lines;
    lines = setPrice(lines, 0, 45, 5);
    lines = addScanned(lines, item({ itemId: 3, name: 'Rice', maintainBatches: true }), 1).lines;
    lines[1] = { ...lines[1], batchName: 'B-7' };
    const input = buildBillInput(
      { voucherTypeId: 9, date: '2026-10-09', partyLedgerId: 1, placeOfSupply: '27', priceLevelId: null, godownId: 4, narration: '  ' },
      lines,
      { tenders: [{ modeId: 1, amount: 100 }] },
    );
    assert.deepEqual(input, {
      voucherTypeId: 9,
      date: '2026-10-09',
      mode: 'item_invoice',
      partyLedgerId: 1,
      placeOfSupply: '27',
      items: [
        { itemId: 1, qty: 2, rate: 45, discountPct: 5, godownId: 4 },
        { itemId: 3, qty: 1, rate: 45, godownId: 4, batchName: 'B-7' },
      ],
      posBill: { tenders: [{ modeId: 1, amount: 100 }] },
    });
    assert.deepEqual(billLines(setQty(lines, 0, 0), null).map((l) => l.itemId), [3]);
  });

  it('a held draft round-trips; missing items are reported', () => {
    let lines = addScanned([], item(), 2).lines;
    lines = setPrice(lines, 0, 40, 0);
    const d = toDraft(9, lines, { ledgerId: 5, name: 'Ramesh', mobile: '9876543210' }, '27');
    assert.deepEqual(d, { voucherTypeId: 9, partyLedgerId: 5, customerName: 'Ramesh', customerMobile: '9876543210', placeOfSupply: '27', lines: [{ itemId: 1, qty: 2, rate: 40 }] });
    const back = linesFromDraft({ lines: [...d.lines, { itemId: 99, qty: 1, rate: 1 }] }, new Map([[1, item()]]));
    assert.deepEqual(back.missing, [99]);
    assert.deepEqual([back.lines[0].qty, back.lines[0].rate, back.lines[0].priceEdited], [2, 40, true]);
  });
});

describe('recalling a held bill keeps its place of supply (review: it came back intra-state)', () => {
  it('a customer bill held as delivered to another state recalls with that state; others use the counter state', () => {
    // Held: customer #9, goods delivered to Karnataka (29) from a Maharashtra (27) counter.
    assert.deepEqual(deliveryFromDraft({ partyLedgerId: 9, placeOfSupply: '29' }, '27', 1), { stateCode: '29', deliver: true });
    assert.deepEqual(deliveryFromDraft({ partyLedgerId: 9, placeOfSupply: '27' }, '27', 1), { stateCode: null, deliver: false });
    assert.deepEqual(deliveryFromDraft({ partyLedgerId: 1, placeOfSupply: '29' }, '27', 1), { stateCode: null, deliver: false }); // walk-in
    assert.deepEqual(deliveryFromDraft({ placeOfSupply: '29' }, '27', 1), { stateCode: null, deliver: false });
    // Round trip through toDraft.
    const d = toDraft(5, [], { ledgerId: 9, name: 'Ravi', mobile: null }, '29');
    assert.deepEqual(deliveryFromDraft(d, '27', 1), { stateCode: '29', deliver: true });
  });
});
