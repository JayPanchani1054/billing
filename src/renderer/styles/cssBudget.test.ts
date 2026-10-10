/**
 * CSS weight budget (2.0, R2 "lightweight"). Source bytes of every stylesheet under src/renderer
 * (UTF-8, as committed). 1.0 shipped 205,916 bytes in total, components.css 76,457 and tokens.css
 * 24,114; 2.0 removed the duplicated system-dark block, unused tokens, dead classes and repeated
 * declarations. The 2.0 integration step re-tightened the ceilings to the measured size + 2 %
 * (rounded up to the next 500 bytes): components.css 65,785 → 67,500, tokens.css 15,604 → 16,000.
 * The total measured 179,750, so + 2 % would loosen the 2.0 gate of 180,000 — it stays at 180,000.
 * Over budget? Delete before you add: shared look belongs in tokens/components, not in copies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = fileURLToPath(new URL('..', import.meta.url));

/** Ceilings in bytes (decimal kilobytes; docs/ARCHITECTURE.md §7a "Weight gates"). */
export const CSS_BUDGET = {
  total: 180_000,
  'styles/components.css': 67_500,
  'styles/tokens.css': 16_000,
} as const;

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) cssFiles(p, out);
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

/**
 * Bytes as committed (LF line ends). A Windows checkout (core.autocrlf) turns every LF into CRLF,
 * which adds ~4 % — the same stylesheets would fail the budget on Windows CI only. Lines are counted
 * once either way; nothing else is discounted.
 */
export function committedSize(text: string): number {
  return Buffer.byteLength(text.replace(/\r\n/g, '\n'), 'utf8');
}

const sizes = new Map(cssFiles(RENDERER).map((f) => [relative(RENDERER, f).split('\\').join('/'), committedSize(readFileSync(f, 'utf8'))]));
const total = [...sizes.values()].reduce((a, b) => a + b, 0);

function report(): string {
  return [...sizes].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${String(n).padStart(7)}  ${f}`).join('\n');
}

test('the budget sees every renderer stylesheet', () => {
  assert.ok(sizes.has('styles/components.css') && sizes.has('styles/tokens.css') && sizes.has('styles/base.css'));
  assert.ok(sizes.size >= 15, `found ${sizes.size} stylesheets`);
});

test('sizes are measured as committed: a CRLF (Windows) checkout weighs the same as LF', () => {
  const lf = '.a {\n  color: red;\n}\n';
  assert.equal(committedSize(lf.replace(/\n/g, '\r\n')), committedSize(lf));
  assert.equal(committedSize(lf), Buffer.byteLength(lf));
  assert.equal(committedSize('/* ₹ */\n'), 10, 'UTF-8 bytes, not characters');
});

test(`total renderer CSS stays within ${CSS_BUDGET.total} bytes`, () => {
  assert.ok(total <= CSS_BUDGET.total, `renderer CSS is ${total} bytes (budget ${CSS_BUDGET.total}):\n${report()}`);
});

for (const file of ['styles/components.css', 'styles/tokens.css'] as const) {
  test(`${file} stays within ${CSS_BUDGET[file]} bytes`, () => {
    const size = sizes.get(file) ?? 0;
    assert.ok(size <= CSS_BUDGET[file], `${file} is ${size} bytes (budget ${CSS_BUDGET[file]})`);
  });
}
