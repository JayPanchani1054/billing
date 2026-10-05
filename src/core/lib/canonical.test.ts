import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson } from './canonical.ts';

describe('canonicalJson', () => {
  it('sorts keys recursively and omits whitespace', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  });

  it('follows JSON semantics for undefined, functions and special numbers', () => {
    assert.equal(canonicalJson({ a: undefined, b: () => 1, c: null }), '{"c":null}');
    assert.equal(canonicalJson([undefined, NaN, Infinity, -0]), '[null,null,null,0]');
    assert.equal(canonicalJson('he said "hi"\n'), '"he said \\"hi\\"\\n"');
    assert.equal(canonicalJson(10n), '"10"');
    assert.equal(canonicalJson(true), 'true');
  });

  it('encodes dates and bytes deterministically', () => {
    assert.equal(canonicalJson(new Date('2026-04-01T00:00:00Z')), '"2026-04-01T00:00:00.000Z"');
    assert.equal(canonicalJson(new Uint8Array([1, 2, 3])), '{"$bytes":"AQID"}');
  });

  it('allows shared references but rejects cycles', () => {
    const shared = { x: 1 };
    assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    assert.throws(() => canonicalJson(cyc), /cyclic/);
  });
});
