import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPlainNumberText, needsFormulaGuard, neutraliseFormula } from './csvSafe.ts';

describe('csvSafe — formula-injection guard shared by every CSV / Excel export', () => {
  it('neutralises every OWASP trigger character', () => {
    for (const s of ['=1+1', '+cmd', '-2+3+cmd|\' /C calc\'!A0', '@SUM(A1)', '\t=1', '\r=1', '-', '+', '=', '-x', '- 5', '+91 98765 43210', '--5', '-5-', '-1e5', '-.5']) {
      assert.equal(neutraliseFormula(s), `'${s}`, JSON.stringify(s));
      assert.equal(needsFormulaGuard(s), true);
    }
  });
  it('leaves plain numbers (negative amounts written as text) and ordinary text alone', () => {
    for (const s of ['-12', '-12.50', '+3.5', '-0', '-1,23,456.00', '-12,34,56,789.00', '-1,234,567.89', '1,000', '12', 'Cash', ' =not first', 'a=b', "'=x", '']) {
      assert.equal(neutraliseFormula(s), s, JSON.stringify(s));
    }
    assert.equal(isPlainNumberText('-1,23,456.00'), true);
    assert.equal(isPlainNumberText('-1,2,3'), false);
    assert.equal(neutraliseFormula('-1,2,3'), "'-1,2,3");
  });
});
