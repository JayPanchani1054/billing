import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from './errors.ts';
import { parse, v } from './validate.ts';

const issuesOf = (fn: () => unknown): Array<{ path: string; message: string }> => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'VALIDATION');
    return e.details as Array<{ path: string; message: string }>;
  }
  assert.fail('expected a VALIDATION error');
};

describe('v.object unknown keys', () => {
  const Filter = v.object({ entityType: v.string().optional(), actions: v.array(v.string()).optional() });

  it('drops keys outside the shape by default (production behaviour for ordinary inputs)', () => {
    assert.deepEqual(parse(Filter, { entityType: 'voucher', action: 'delete' }), { entityType: 'voucher' });
  });

  it("rejects them, naming the key and the near miss, when the parse runs with unknownKeys: 'reject'", () => {
    const issues = issuesOf(() => parse(Filter, { entityType: 'voucher', action: 'delete' }, { unknownKeys: 'reject' }));
    assert.deepEqual(issues, [{ path: 'action', message: 'Unknown field "action" — did you mean "actions"?' }]);
  });

  it('reports nested unknown keys with their full path, and ignores keys whose value is undefined', () => {
    const S = v.object({ items: v.array(v.object({ qty: v.number() })) });
    assert.deepEqual(parse(S, { items: [{ qty: 1, note: undefined }] }, { unknownKeys: 'reject' }), { items: [{ qty: 1 }] });
    const issues = issuesOf(() => parse(S, { items: [{ qty: 1, qyt: 2 }] }, { unknownKeys: 'reject' }));
    assert.deepEqual(issues, [{ path: 'items[0].qyt', message: 'Unknown field "qyt" — did you mean "qty"?' }]);
  });

  it('strictObject rejects unknown keys whatever the parse policy; an explicit strip keeps dropping them', () => {
    const Strict = v.strictObject({ from: v.date().optional() });
    const issues = issuesOf(() => parse(Strict, { from: '2026-04-01', form: 'x' }));
    assert.deepEqual(issues, [{ path: 'form', message: 'Unknown field "form" — did you mean "from"?' }]);
    const Loose = v.object({ from: v.date().optional() }, { unknownKeys: 'strip' });
    assert.deepEqual(parse(Loose, { from: '2026-04-01', extra: 1 }, { unknownKeys: 'reject' }), { from: '2026-04-01' });
  });

  it('no hint when nothing is close; the policy does not leak into the next parse', () => {
    const issues = issuesOf(() => parse(Filter, { zzz: 1 }, { unknownKeys: 'reject' }));
    assert.deepEqual(issues, [{ path: 'zzz', message: 'Unknown field "zzz"' }]);
    assert.deepEqual(parse(Filter, { zzz: 1 }), {});
  });
});
