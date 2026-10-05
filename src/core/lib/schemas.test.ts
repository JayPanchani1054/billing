import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from './errors.ts';
import { patchNullable, requiredNullable } from './schemas.ts';
import { parse, v } from './validate.ts';

describe('patch schemas', () => {
  const Patch = v.object({ bank: patchNullable(v.id()), when: requiredNullable(v.date(), 'Choose a date') });

  it('keeps omitted keys omitted, passes explicit null, validates values', () => {
    assert.deepEqual(parse(Patch, { when: null }), { when: null });
    assert.deepEqual(parse(Patch, { bank: null, when: '2026-04-01' }), { bank: null, when: '2026-04-01' });
    assert.deepEqual(parse(Patch, { bank: 5, when: null }), { bank: 5, when: null });
  });

  it('reports field issues', () => {
    assert.throws(
      () => parse(Patch, { bank: 0 }),
      (e: unknown) => {
        const issues = (e as AppError).details as Array<{ path: string; message: string }>;
        return issues.some((i) => i.path === 'bank') && issues.some((i) => i.path === 'when' && i.message === 'Choose a date');
      },
    );
  });

  it('supports the standard combinators', () => {
    const s = patchNullable(v.int()).refine((n) => (n !== null && n !== undefined && n > 10 ? 'Too big' : null));
    assert.throws(() => parse(v.object({ n: s }), { n: 11 }), AppError);
    assert.deepEqual(parse(v.object({ n: s }), { n: 3 }), { n: 3 });
  });
});
