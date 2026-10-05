import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffJson } from './diff.ts';

describe('edit log diff', () => {
  it('reports nothing for equal values and ignores updated_at noise at any depth', () => {
    const a = { name: 'Acme', updated_at: '2026-04-01T00:00:00Z', bank: { ifsc: 'HDFC0000001', updatedAt: 'x' } };
    const b = { name: 'Acme', updated_at: '2026-04-15T00:00:00Z', bank: { ifsc: 'HDFC0000001', updatedAt: 'y' } };
    assert.deepEqual(diffJson(a, b), { changes: [], truncated: false });
    assert.deepEqual(diffJson(null, null).changes, []);
  });

  it('reports changed leaves in nested objects with dotted paths', () => {
    const d = diffJson({ name: 'A', gst: { rate: 12, hsn: '1001' } }, { name: 'B', gst: { rate: 18, hsn: '1001' } });
    assert.deepEqual(d.changes, [
      { path: 'name', kind: 'changed', before: 'A', after: 'B' },
      { path: 'gst.rate', kind: 'changed', before: 12, after: 18 },
    ]);
  });

  it('reports added and removed keys (removed in before order, then added)', () => {
    const d = diffJson({ a: 1, b: 2, c: null }, { a: 1, c: 'x', d: true });
    assert.deepEqual(d.changes, [
      { path: 'b', kind: 'removed', before: 2, after: null },
      { path: 'c', kind: 'changed', before: null, after: 'x' },
      { path: 'd', kind: 'added', before: null, after: true },
    ]);
  });

  it('compares arrays by index and expands appended / dropped elements into leaves', () => {
    const before = { lines: [{ ledger: 'Sales', amount: -1000 }, { ledger: 'CGST', amount: -90 }, { ledger: 'SGST', amount: -90 }] };
    const after = { lines: [{ ledger: 'Sales', amount: -2000 }, { ledger: 'CGST', amount: -90 }] };
    assert.deepEqual(diffJson(before, after).changes, [
      { path: 'lines[0].amount', kind: 'changed', before: -1000, after: -2000 },
      { path: 'lines[2].ledger', kind: 'removed', before: 'SGST', after: null },
      { path: 'lines[2].amount', kind: 'removed', before: -90, after: null },
    ]);
    assert.deepEqual(diffJson({ tags: ['a'] }, { tags: ['a', 'b', 'c'] }).changes, [
      { path: 'tags[1]', kind: 'added', before: null, after: 'b' },
      { path: 'tags[2]', kind: 'added', before: null, after: 'c' },
    ]);
  });

  it('a created record lists every leaf as added; a deleted one every leaf as removed', () => {
    const rec = { name: 'Widget', gst: { rate: 18 }, units: [], notes: {} };
    assert.deepEqual(diffJson(undefined, rec).changes, [
      { path: 'name', kind: 'added', before: null, after: 'Widget' },
      { path: 'gst.rate', kind: 'added', before: null, after: 18 },
      { path: 'units', kind: 'added', before: null, after: [] },
      { path: 'notes', kind: 'added', before: null, after: {} },
    ]);
    assert.deepEqual(
      diffJson({ name: 'Widget', updated_at: 'x' }, null).changes,
      [{ path: 'name', kind: 'removed', before: 'Widget', after: null }],
    );
  });

  it('a shape change is one entry carrying both whole values', () => {
    assert.deepEqual(diffJson({ bank: { ifsc: 'X' } }, { bank: null }).changes, [
      { path: 'bank', kind: 'changed', before: { ifsc: 'X' }, after: null },
    ]);
    assert.deepEqual(diffJson({ v: [1] }, { v: { 0: 1 } }).changes, [{ path: 'v', kind: 'changed', before: [1], after: { 0: 1 } }]);
    assert.deepEqual(diffJson(5, 'five').changes, [{ path: '(value)', kind: 'changed', before: 5, after: 'five' }]);
  });

  it('quotes keys that are not plain identifiers', () => {
    assert.deepEqual(diffJson({ 'GST %': 5, x: { 'a.b': 1 } }, { 'GST %': 12, x: { 'a.b': 2 } }).changes.map((c) => c.path), [
      '["GST %"]',
      'x["a.b"]',
    ]);
  });

  it('distinguishes types that compare loosely equal', () => {
    assert.deepEqual(diffJson({ a: 0, b: '1', c: false }, { a: null, b: 1, c: 0 }).changes.map((c) => c.path), ['a', 'b', 'c']);
  });

  it('truncates at the limit and says so', () => {
    const before = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const after = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i + 1]));
    const d = diffJson(before, after, 10);
    assert.equal(d.changes.length, 10);
    assert.equal(d.truncated, true);
    assert.equal(diffJson(before, after).changes.length, 50);
  });

  it('handles deep nesting without overflowing', () => {
    let a: unknown = 1;
    let b: unknown = 2;
    for (let i = 0; i < 200; i++) {
      a = { n: a };
      b = { n: b };
    }
    const d = diffJson(a, b);
    assert.equal(d.changes.length, 1);
    assert.equal(d.changes[0].kind, 'changed');
  });
});
