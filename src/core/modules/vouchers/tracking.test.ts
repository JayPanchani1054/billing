/**
 * What bills / fulfils a note or order, applied to its lines (tracking.ts): a line's own description
 * first, the rest in line order.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addBilled, applyBilled, billedQty, type TrackedLine } from './tracking.ts';

const billed = (rows: Array<[key: string, description: string | null, qty: number]>) => {
  const b = billedQty();
  for (const [key, description, qty] of rows) addBilled(b, key, description, qty);
  return b;
};

/** The rule before 2.2: per key, in line order. */
function fifo(lines: readonly TrackedLine[], totals: ReadonlyMap<string, number>): Array<{ billed: number; pending: number }> {
  const left = new Map(totals);
  return lines.map((l) => {
    const avail = left.get(l.key) ?? 0;
    const take = Math.min(avail, l.qty);
    left.set(l.key, avail - take);
    return { billed: take, pending: l.qty - take };
  });
}

describe('tracking: billed quantity applied to note / order lines', () => {
  it('a line takes what was billed under its own text first; the rest goes in line order', () => {
    const lines: TrackedLine[] = [
      { key: 'DN1|7', qty: 1, description: 'SN-111' },
      { key: 'DN1|7', qty: 1, description: 'SN-222' },
      { key: 'DN1|8', qty: 4, description: null },
    ];
    // SN-222 billed alone: SN-111 stays pending.
    assert.deepEqual(applyBilled(lines, billed([['DN1|7', 'SN-222', 1]])), [
      { billed: 0, pending: 1 },
      { billed: 1, pending: 0 },
      { billed: 0, pending: 4 },
    ]);
    // Billed without a text, or under a text no line has: line order.
    assert.deepEqual(applyBilled(lines, billed([['DN1|7', null, 1]])).map((x) => x.pending), [0, 1, 4]);
    assert.deepEqual(applyBilled(lines, billed([['DN1|7', 'SN-333', 1]])).map((x) => x.pending), [0, 1, 4]);
    // More under a text than its line holds: the excess joins the rest (line order, from the first line).
    assert.deepEqual(applyBilled(lines, billed([['DN1|7', 'SN-222', 2]])).map((x) => x.pending), [0, 0, 4]);
    // Another item (key) is never touched.
    assert.deepEqual(applyBilled(lines, billed([['DN1|8', 'SN-222', 3]])).map((x) => x.pending), [1, 1, 1]);
  });

  it('Red 5 / Blue 5 billed Red 3 and Blue 5 leaves Red 2; the same quantities without texts leave Blue 2', () => {
    const lines: TrackedLine[] = [
      { key: 'SO1|7', qty: 5, description: 'Red' },
      { key: 'SO1|7', qty: 5, description: 'Blue' },
    ];
    const b = billed([
      ['SO1|7', 'Red', 3],
      ['SO1|7', 'Blue', 5],
    ]);
    assert.deepEqual(applyBilled(lines, b), [
      { billed: 3, pending: 2 },
      { billed: 5, pending: 0 },
    ]);
    assert.deepEqual(applyBilled(lines, b).map((x) => x.pending), [2, 0], 'the billed quantities are not consumed by a call');
    assert.deepEqual(applyBilled(lines, billed([['SO1|7', null, 8]])).map((x) => x.pending), [0, 2]);
  });

  it('fractional quantities never leave a negative or −0 pending', () => {
    const lines: TrackedLine[] = [
      { key: 'k', qty: 0.3, description: 'A' },
      { key: 'k', qty: 0.3, description: null },
    ];
    // 0.1 under A, then 0.2 + 0.3 without a text: A takes 0.1 + 0.2 (to 0.3), the other line 0.3.
    const out = applyBilled(lines, billed([['k', 'A', 0.1], ['k', null, 0.2], ['k', null, 0.3]]));
    for (const x of out) assert.ok(Object.is(x.pending, 0) || x.pending > 0, `pending ${x.pending}`);
    assert.deepEqual(out.map((x) => Math.round(x.pending * 1e6) / 1e6), [0, 0]);
  });

  it('without a billing line carrying a source line’s text it is exactly the earlier rule (seeded random check)', () => {
    let seed = 20261031;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const qtys = [0.5, 1, 2, 3.25, 7];
    for (let round = 0; round < 300; round++) {
      const keys = ['A|1', 'A|2', 'B|1'];
      const lines: TrackedLine[] = Array.from({ length: 1 + rnd(6) }, () => ({
        key: keys[rnd(keys.length)],
        qty: qtys[rnd(qtys.length)],
        // Source lines may have texts; the billing lines below never carry one of them.
        description: rnd(2) === 0 ? null : `S${rnd(3)}`,
      }));
      const rows: Array<[string, string | null, number]> = Array.from({ length: rnd(5) }, () => [keys[rnd(keys.length)], rnd(2) === 0 ? null : `B${rnd(3)}`, qtys[rnd(qtys.length)]]);
      const b = billed(rows);
      assert.deepEqual(applyBilled(lines, b), fifo(lines, b.total), `round ${round}`);
    }
  });
});
