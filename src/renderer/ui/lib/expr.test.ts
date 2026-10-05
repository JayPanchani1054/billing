import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression, looksLikeExpression } from './expr.ts';

const ok = (s: string): number => {
  const r = evaluateExpression(s);
  assert.ok(r.ok, `expected '${s}' to evaluate, got ${r.ok ? '' : r.error}`);
  return r.value;
};
const bad = (s: string): string => {
  const r = evaluateExpression(s);
  assert.ok(!r.ok, `expected '${s}' to fail`);
  return r.error;
};

test('basic arithmetic and precedence', () => {
  assert.equal(ok('1200*3'), 3600);
  assert.equal(ok('1 + 2 * 3'), 7);
  assert.equal(ok('(1 + 2) * 3'), 9);
  assert.equal(ok('10 / 4'), 2.5);
  assert.equal(ok('10 - 2 - 3'), 5); // left associative
  assert.equal(ok('100 / 10 / 2'), 5);
  assert.equal(ok('2x3'), 6);
  assert.equal(ok('2 × 3 ÷ 4'), 1.5);
});

test('unary signs', () => {
  assert.equal(ok('-5 + 2'), -3);
  assert.equal(ok('-(2 + 3)'), -5);
  assert.equal(ok('--4'), 4);
  assert.equal(ok('3 * -2'), -6);
  assert.equal(ok('+7'), 7);
});

test('grouping commas and decimals', () => {
  assert.equal(ok('1,20,000 + 500'), 120500);
  assert.equal(ok('1,234.50*2'), 2469);
  assert.equal(ok('.5 + .25'), 0.75);
  assert.equal(ok('12.'), 12);
});

test('percent semantics (desk calculator)', () => {
  assert.equal(ok('1000*18%'), 180);
  assert.equal(ok('1000+18%'), 1180);
  assert.equal(ok('1000-10%'), 900);
  assert.equal(ok('50%'), 0.5);
  assert.equal(ok('200 + 10% * 2'), 200.2); // 10%*2 is not a bare percent term → 0.2
});

test('errors never throw and are user-readable', () => {
  assert.match(bad('1/0'), /divide by zero/);
  assert.match(bad('(1+2'), /Missing '\)'/);
  assert.match(bad('1+2)'), /Unmatched/);
  assert.match(bad('2 +'), /Incomplete/);
  assert.match(bad('abc'), /Unexpected 'a'/);
  assert.match(bad('alert(1)'), /Unexpected/);
  assert.match(bad(''), /Empty/);
  assert.match(bad('1..2'), /Unexpected|Missing|input/);
  assert.match(bad('('.repeat(40) + '1' + ')'.repeat(40)), /brackets/);
  assert.match(bad('1'.repeat(300)), /too long/);
});

test('looksLikeExpression distinguishes plain numbers', () => {
  assert.equal(looksLikeExpression('1,234.50'), false);
  assert.equal(looksLikeExpression('-500'), false);
  assert.equal(looksLikeExpression('1200*3'), true);
  assert.equal(looksLikeExpression('100-5'), true);
  assert.equal(looksLikeExpression('18%'), true);
});
