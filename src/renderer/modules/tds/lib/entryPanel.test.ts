/**
 * The voucher-entry TDS / TCS panel (2.1, SPEC-21 D16, WP-K2): drawn only when it applies and has
 * something to say, and its Alt+U registered whatever the panel shows. React is not loaded in node,
 * so the gate is a pure function (lib/model.ts) and the hook order is read from the source: a hook
 * after an early `return` would throw "Rendered more hooks than during the previous render" the first
 * time a line is computed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { entryPanelShown } from './model.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The body of `export function <name>(…) {…}` (to the next top-level `}`), or ''. */
function body(file: string, name: string): string {
  const text = fs.readFileSync(path.join(here, '..', file), 'utf8');
  const start = text.indexOf(`export function ${name}(`);
  if (start < 0) return '';
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end < 0 ? undefined : end);
}

describe('TDS entry panel', () => {
  test('drawn only when TDS / TCS applies and there is a computed line or a challan', () => {
    assert.equal(entryPanelShown({ applies: true, isChallan: false, lines: 1 }), true);
    assert.equal(entryPanelShown({ applies: true, isChallan: true, lines: 0 }), true);
    assert.equal(entryPanelShown({ applies: true, isChallan: false, lines: 0 }), false, 'nothing computed yet: the grid keeps the width');
    assert.equal(entryPanelShown({ applies: false, isChallan: false, lines: 3 }), false, 'feature off for this voucher type');
    assert.equal(entryPanelShown({ applies: false, isChallan: true, lines: 0 }), false);
  });

  test('every hook (Alt+U included) runs before the first return; the gate is the pure function', () => {
    const src = body('EntryPanel.tsx', 'TdsEntryPanel');
    assert.ok(src, 'TdsEntryPanel not found');
    const firstReturn = src.search(/\breturn\b/);
    assert.ok(firstReturn > 0);
    const hooks = [...src.matchAll(/\buse[A-Z]\w*\(/g)];
    assert.ok(hooks.some((m) => m[0] === 'useScreenActions('), 'Alt+U is registered with useScreenActions');
    for (const h of hooks) assert.ok((h.index ?? 0) < firstReturn, `${h[0]} after the first return`);
    assert.match(src, /if \(!entryPanelShown\(/, 'the panel is gated by entryPanelShown');
    // The Alt+U dialog is returned even when the panel is not drawn (an advance: Alt+U picks the nature).
    assert.match(src, /if \(!entryPanelShown\([^)]*\)\) return dialog;/);
  });
});
