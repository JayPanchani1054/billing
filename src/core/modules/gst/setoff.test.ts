/**
 * ITC set-off order (s.49(5), Rule 88A). Amounts in paise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setOff } from './setoff.ts';

const t = (igst: number, cgst: number, sgst: number, cess = 0) => ({ igst, cgst, sgst, cess });

describe('ITC set-off', () => {
  it('IGST credit pays IGST first, then spills over to CGST, then SGST', () => {
    // Liability I 300 / C 400 / S 400; credit I 1,000 only.
    // I→I 300 (700 left) → I→C 400 (300 left) → I→S 300 → SGST cash 100.
    const r = setOff(t(300_00, 400_00, 400_00), t(1000_00, 0, 0));
    assert.deepEqual(r.utilisation.igst, { igst: 300_00, cgst: 400_00, sgst: 300_00, cess: 0 });
    assert.deepEqual(r.cash, t(0, 0, 100_00));
    assert.deepEqual(r.creditBalance, t(0, 0, 0));
    assert.deepEqual(r.paidByItc, t(300_00, 400_00, 300_00));
  });

  it('CGST credit can never pay SGST (and SGST credit never pays CGST)', () => {
    // Liability C 200 / S 300; credit C 500. C→C 200; 300 C credit left unused; SGST 300 in cash.
    const r = setOff(t(0, 200_00, 300_00), t(0, 500_00, 0));
    assert.equal(r.utilisation.cgst.sgst, 0);
    assert.deepEqual(r.cash, t(0, 0, 300_00));
    assert.deepEqual(r.creditBalance, t(0, 300_00, 0));
    const s = setOff(t(0, 300_00, 200_00), t(0, 0, 500_00));
    assert.equal(s.utilisation.sgst.cgst, 0);
    assert.deepEqual(s.cash, t(0, 300_00, 0));
    assert.deepEqual(s.creditBalance, t(0, 0, 300_00));
  });

  it('CGST and SGST credit pay IGST after their own head', () => {
    // Liability I 1,000 / C 100 / S 100; credit I 200, C 400, S 300.
    // I→I 200 (I left 800); C→C 100, C→I 300 (I left 500); S→S 100, S→I 200 (I left 300) → IGST cash 300.
    const r = setOff(t(1000_00, 100_00, 100_00), t(200_00, 400_00, 300_00));
    assert.deepEqual(r.utilisation.cgst, { igst: 300_00, cgst: 100_00, sgst: 0, cess: 0 });
    assert.deepEqual(r.utilisation.sgst, { igst: 200_00, cgst: 0, sgst: 100_00, cess: 0 });
    assert.deepEqual(r.cash, t(300_00, 0, 0));
    assert.deepEqual(r.creditBalance, t(0, 0, 0));
  });

  it('IGST credit goes first to the head its own credit cannot cover (no avoidable cash)', () => {
    // Liability C 500 / S 500; credit I 600, C 500, S 0.
    // SGST shortfall 500 → I→S 500; remaining I 100 → C; C→C 400 → no cash; C credit 100 carried forward.
    // (Plain "CGST then SGST" would have left SGST 400 to pay in cash.)
    const r = setOff(t(0, 500_00, 500_00), t(600_00, 500_00, 0));
    assert.deepEqual(r.utilisation.igst, { igst: 0, cgst: 100_00, sgst: 500_00, cess: 0 });
    assert.equal(r.utilisation.cgst.cgst, 400_00);
    assert.deepEqual(r.cash, t(0, 0, 0));
    assert.deepEqual(r.creditBalance, t(0, 100_00, 0));
  });

  it('IGST credit is used up before own-head credit (Rule 88A)', () => {
    // Liability C 50 / S 50; credit I 100, C 50, S 50 → IGST credit pays both; own credits carried forward.
    const r = setOff(t(0, 50_00, 50_00), t(100_00, 50_00, 50_00));
    assert.deepEqual(r.utilisation.igst, { igst: 0, cgst: 50_00, sgst: 50_00, cess: 0 });
    assert.deepEqual(r.creditBalance, t(0, 50_00, 50_00));
    assert.deepEqual(r.cash, t(0, 0, 0));
  });

  it('cess only against cess; negatives are treated as zero', () => {
    const r = setOff(t(0, 0, 0, 500_00), t(1000_00, 1000_00, 1000_00, 200_00));
    assert.deepEqual(r.cash, t(0, 0, 0, 300_00));
    assert.equal(r.utilisation.igst.cess + r.utilisation.cgst.cess + r.utilisation.sgst.cess, 0);
    const n = setOff(t(-100, 100, 0), t(0, -50, 0));
    assert.deepEqual(n.cash, t(0, 100, 0));
    assert.deepEqual(n.creditBalance, t(0, 0, 0));
  });
});
