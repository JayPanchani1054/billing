/**
 * CSS weight budget (2.0, R2 "lightweight"). Source bytes of every stylesheet under src/renderer
 * (UTF-8, as committed). 1.0 shipped 205,916 bytes in total, components.css 76,457 and tokens.css
 * 24,114; 2.0 removed the duplicated system-dark block, unused tokens, dead classes and repeated
 * declarations. The integration step re-tightens these ceilings to the measured size + 2 %.
 * Over budget? Delete before you add: shared look belongs in tokens/components, not in copies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = fileURLToPath(new URL('..', import.meta.url));

/** Ceilings in bytes (decimal kilobytes, as in the 2.0 build spec §10). */
export const CSS_BUDGET = {
  total: 180_000,
  'styles/components.css': 72_000,
  'styles/tokens.css': 19_000,
} as const;

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) cssFiles(p, out);
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

const sizes = new Map(cssFiles(RENDERER).map((f) => [relative(RENDERER, f).split('\\').join('/'), statSync(f).size]));
const total = [...sizes.values()].reduce((a, b) => a + b, 0);

function report(): string {
  return [...sizes].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${String(n).padStart(7)}  ${f}`).join('\n');
}

test('the budget sees every renderer stylesheet', () => {
  assert.ok(sizes.has('styles/components.css') && sizes.has('styles/tokens.css') && sizes.has('styles/base.css'));
  assert.ok(sizes.size >= 15, `found ${sizes.size} stylesheets`);
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
