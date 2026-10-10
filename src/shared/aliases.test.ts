import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aliasKeywords, aliasLines, formAliasList, moreAliasesProblem, moreAliasesText, sameAliasList } from './aliases.ts';

describe('alias form helpers', () => {
  it('splits lines, trims and collapses spaces', () => {
    assert.deepEqual(aliasLines(' A  1 \r\n\nB2\n '), ['A 1', 'B2']);
  });
  it('more-aliases text is every alias after the first', () => {
    assert.equal(moreAliasesText(['ACME', 'C-1', 'C-2'], 'ACME'), 'C-1\nC-2');
    assert.equal(moreAliasesText(undefined, null), '');
    assert.equal(moreAliasesText(['C-1'], null), 'C-1');
  });
  it('form list = Alias field then lines, without blanks or repeats', () => {
    assert.deepEqual(formAliasList(' ACME ', 'C-1\nacme\nC-2'), ['ACME', 'C-1', 'C-2']);
    assert.deepEqual(formAliasList('', ''), []);
  });
  it('compares lists in order', () => {
    assert.equal(sameAliasList(['A', 'B'], ['A', 'B']), true);
    assert.equal(sameAliasList(['A', 'B'], ['B', 'A']), false);
  });
  it('reports problems a user can fix before saving', () => {
    assert.equal(moreAliasesProblem('Acme', 'AC', 'X\nY'), null);
    assert.match(moreAliasesProblem('Acme', 'AC', 'acme') ?? '', /same as the name/);
    assert.match(moreAliasesProblem('Acme', 'AC', 'ac') ?? '', /twice/);
    assert.match(moreAliasesProblem('Acme', 'AC', Array.from({ length: 20 }, (_, i) => `A${i}`).join('\n')) ?? '', /At most 20/);
  });
  it('keywords for search', () => {
    assert.deepEqual(aliasKeywords('A', ['B']), ['A', 'B']);
    assert.deepEqual(aliasKeywords(null, undefined), []);
  });
});
