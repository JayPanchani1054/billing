/**
 * The voucher-entry foreign-currency panel (2.1, SPEC-21 D16, WP-K2): drawn only when something on the
 * voucher is in a foreign currency and there is a figure to show. React is not loaded in node, so the
 * gate is a pure function (lib/entry.ts) and the component is read from the source: it holds no hook
 * (Alt+Y is the entry screen's), so its early returns can never change the hook order.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { entryPanelShown } from './entry.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('forex entry panel', () => {
  test('drawn only with a foreign-currency invoice or a priced foreign line', () => {
    assert.equal(entryPanelShown({ relevant: true, invoiceCurrency: true, lines: 0 }), true);
    assert.equal(entryPanelShown({ relevant: true, invoiceCurrency: false, lines: 2 }), true);
    assert.equal(entryPanelShown({ relevant: true, invoiceCurrency: false, lines: 0 }), false, 'nothing priced yet: the grid keeps the width');
    assert.equal(entryPanelShown({ relevant: false, invoiceCurrency: true, lines: 1 }), false, 'nothing in a foreign currency');
  });

  test('the component holds no hook and is gated by entryPanelShown', () => {
    const text = fs.readFileSync(path.join(here, '..', 'EntryPanel.tsx'), 'utf8');
    const start = text.indexOf('export function ForexEntryPanel(');
    assert.ok(start >= 0, 'ForexEntryPanel not found');
    const src = text.slice(start, text.indexOf('\n}\n', start));
    assert.deepEqual([...src.matchAll(/\buse[A-Z]\w*\(/g)].map((m) => m[0]), []);
    assert.match(src, /if \(!entryPanelShown\(/);
  });
});
