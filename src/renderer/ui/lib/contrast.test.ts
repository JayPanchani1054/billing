/**
 * Guards WCAG AA for the design tokens: every semantic text/background pair ≥ 4.5:1 and every
 * control boundary / focus ring / icon / chart series ≥ 3:1, in light and dark. 2.0 has exactly one
 * dark block: the 'system' preference is resolved in JS (ui/theme.ts), so no system block exists.
 * 2.1: the canvas (--surface-0) is the card colour; Dr/Cr suffixes are --text-muted (--dr/--cr gone)
 * and tables have no zebra/group tints (--row-zebra/--row-group gone).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contrastRatio, extractBlock, parseColor, parseDeclarations, resolveToken } from './contrast.ts';

const cssPath = fileURLToPath(new URL('../../styles/tokens.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

function themeTokens(selector: string): Map<string, string> {
  const base = parseDeclarations(extractBlock(css, ':root') ?? '');
  const light = parseDeclarations(extractBlock(css, '[data-theme="light"]') ?? '');
  const map = new Map([...base, ...light]);
  if (selector !== '[data-theme="light"]') {
    const block = extractBlock(css, selector);
    assert.ok(block, `missing block ${selector}`);
    for (const [k, v] of parseDeclarations(block)) map.set(k, v);
  }
  return map;
}

const TEXT_SURFACES = ['--surface-0', '--surface-1', '--surface-2', '--surface-3', '--surface-overlay', '--control-bg', '--row-hover', '--row-selected', '--row-selected-hover'];
const TONES = ['neutral', 'brand', 'accent', 'success', 'warning', 'danger', 'info'];

function textPairs(): [string, string][] {
  const pairs: [string, string][] = [];
  for (const fg of ['--text-primary', '--text-secondary', '--text-muted', '--text-placeholder']) {
    for (const bg of TEXT_SURFACES) pairs.push([fg, bg]);
  }
  for (const bg of ['--surface-0', '--surface-1', '--surface-2', '--surface-overlay']) {
    pairs.push(['--text-link', bg], ['--brand-text', bg], ['--positive', bg], ['--negative', bg], ['--accent-text', bg]);
  }
  pairs.push(
    ['--brand-text', '--brand-subtle'],
    ['--on-brand', '--brand'],
    ['--on-brand', '--brand-hover'],
    ['--on-brand', '--brand-active'],
    ['--on-accent', '--accent'],
    ['--accent-text', '--accent-subtle'],
    ['--text-primary', '--control-fill'],
    ['--text-primary', '--control-fill-hover'],
    ['--text-primary', '--control-fill-active'],
    ['--text-primary', '--brand-subtle'],
    ['--text-primary', '--brand-subtle-hover'],
    ['--text-inverse', '--surface-inverse'],
    ['--kbd-text', '--kbd-bg'],
    ['--tooltip-text', '--tooltip-bg'],
    ['--match-text', '--match-bg'],
    ['--selection-text', '--selection-bg'],
    ['--on-danger-solid', '--danger-solid-hover'],
  );
  for (const t of TONES) {
    const text = t === 'brand' ? '--brand-tone-text' : t === 'accent' ? '--accent-tone-text' : `--${t}-text`;
    pairs.push([text, `--${t}-bg`], [text, '--surface-1'], [`--on-${t}-solid`, `--${t}-solid`]);
  }
  return pairs;
}

function uiPairs(): [string, string][] {
  const pairs: [string, string][] = [];
  for (const bg of ['--surface-0', '--surface-1', '--surface-2', '--control-bg']) pairs.push(['--border-strong', bg]);
  for (const bg of ['--surface-0', '--surface-1', '--surface-2', '--surface-3', '--row-selected', '--surface-overlay']) pairs.push(['--focus-ring', bg]);
  pairs.push(['--row-selected-indicator', '--row-selected'], ['--switch-off', '--surface-1'], ['--brand', '--surface-1']);
  for (const t of TONES) pairs.push([`--${t}-icon`, '--surface-1'], [`--${t}-icon`, `--${t}-bg`]);
  for (let i = 1; i <= 5; i++) pairs.push([`--chart-${i}`, '--surface-1']);
  // 2.1 graphs sit on the canvas too: the three slots and the grey context mark (D29), both surfaces.
  for (const fg of ['--chart-1', '--chart-2', '--chart-3', '--chart-other']) for (const bg of ['--surface-0', '--surface-1']) pairs.push([fg, bg]);
  return pairs;
}

function check(selector: string): string[] {
  const tokens = themeTokens(selector);
  const failures: string[] = [];
  const color = (name: string) => {
    const resolved = resolveToken(`var(${name})`, tokens);
    const c = parseColor(resolved);
    assert.ok(c, `${selector}: ${name} did not resolve to a colour (got '${resolved}')`);
    return c;
  };
  const run = (pairs: [string, string][], min: number) => {
    for (const [fg, bg] of pairs) {
      const bgc = color(bg);
      const ratio = contrastRatio(color(fg), bgc.a < 1 ? { ...bgc, a: 1 } : bgc);
      if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
    }
  };
  run(textPairs(), 4.5);
  run(uiPairs(), 3);
  return failures;
}

for (const selector of ['[data-theme="light"]', '[data-theme="dark"]']) {
  test(`tokens meet WCAG AA in ${selector}`, () => {
    const failures = check(selector);
    assert.deepEqual(failures, [], failures.join('\n'));
  });
}

test('there is one dark block and no system block (system is resolved in JS)', () => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(extractBlock(css, '[data-theme="system"]'), null);
  assert.ok(!clean.includes('data-theme="system"'), 'no [data-theme="system"] selector');
  assert.ok(!clean.includes('prefers-color-scheme'), 'no prefers-color-scheme media block');
  assert.equal(clean.split('[data-theme="dark"]').length - 1, 1, 'exactly one dark block');
});

test('2.1 canvas: one flat surface — the canvas is the card colour in both themes', () => {
  for (const selector of ['[data-theme="light"]', '[data-theme="dark"]']) {
    const tokens = themeTokens(selector);
    const c = (name: string) => resolveToken(`var(${name})`, tokens).toLowerCase();
    assert.equal(c('--surface-0'), c('--surface-1'), selector);
  }
  assert.equal(resolveToken('var(--surface-0)', themeTokens('[data-theme="light"]')).toLowerCase(), '#ffffff');
  assert.equal(resolveToken('var(--surface-0)', themeTokens('[data-theme="dark"]')).toLowerCase(), '#15181f');
});

test('retired accounting and zebra tokens stay gone', () => {
  for (const name of ['--dr', '--cr', '--row-zebra', '--row-group']) assert.ok(!new RegExp(`^\\s*${name}\\s*:`, 'm').test(css), `${name} is declared again`);
});

test('dark block overrides every light semantic colour token', () => {
  const light = parseDeclarations(extractBlock(css, '[data-theme="light"]') ?? '');
  const dark = parseDeclarations(extractBlock(css, '[data-theme="dark"]') ?? '');
  const missing = [...light.keys()].filter((k) => !dark.has(k));
  assert.deepEqual(missing, []);
});
