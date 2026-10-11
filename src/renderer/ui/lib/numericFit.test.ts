/**
 * Money is never cut off in a table (2.1 calm audit: the Receivables ageing showed "1,82,539.00…" in its
 * 130 px age columns at 1366 px). numericFit sizes a numeric column to its longest value; DataTable uses it
 * for every amount / Dr-Cr / quantity / number column, rows and totals alike.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatDrCr } from '../../../shared/format.ts';
import { FIT_SCAN_LIMIT, fitColWidth, fitLength, fitPx, longestChars } from './numericFit.ts';

test('the longest text decides; nothing to show leaves the declared width alone', () => {
  assert.equal(longestChars(['', '8,449.00 Dr', '1,82,539.00 Dr']), 14);
  assert.equal(longestChars([]), 0);
  assert.equal(fitColWidth(130, 0), 130);
  assert.equal(fitColWidth(undefined, 14), undefined, 'a flexible column stays flexible');
});

test('a declared width grows to its longest value, never shrinks', () => {
  assert.equal(fitColWidth(130, 14), `max(130px, ${fitLength(14)})`);
  assert.equal(fitColWidth('12rem', 9), `max(12rem, ${fitLength(9)})`);
  assert.match(fitLength(14), /^calc\(14ch \* 1\.08 \+ 2 \* var\(--cell-px\) \+ 2px\)$/);
});

test('the px estimate covers a lakh-crore Dr/Cr total in more than the old 130 px', () => {
  const total = formatDrCr(18253900); // ₹1,82,539.00 Dr in paise
  assert.equal(total.length, 14);
  assert.ok(fitPx(total.length + 2) > 130, `${fitPx(total.length + 2)} px`);
  assert.equal(fitPx(0), 0);
  assert.ok(FIT_SCAN_LIMIT >= 1000);
});

test('DataTable sizes every numeric column with it (rows and totals; custom renders keep their width)', () => {
  const src = readFileSync(new URL('../DataTable.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /import \{ FIT_SCAN_LIMIT, fitColWidth, fitPx, longestChars \} from '\.\/lib\/numericFit\.ts';/);
  assert.match(src, /if \(!c\.kind \|\| !NUMERIC_KINDS\.has\(c\.kind\) \|\| c\.render\) continue;/);
  assert.match(src, /for \(const f of footer \?\? \[\]\)/);
  assert.match(src, /<col key=\{c\.key\} style=\{c\.width !== undefined \? \{ width: fitColWidth\(c\.width, fitChars\.get\(c\.key\) \?\? 0\) \} : undefined\} \/>/);
  assert.match(src, /Math\.max\(typeof c\.width === 'number' \? c\.width : c\.minWidth \?\? 120, fit\)/);
});
