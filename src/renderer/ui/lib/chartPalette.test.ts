/**
 * The graph palette as shipped (SPEC-21 §4.3, D29): the validator's numbers become a CI gate. Reads
 * styles/tokens.css and styles/charts.css, resolves every chart token per theme through its var()
 * chain, and checks the four colour meanings against the canvas (`--surface-0`) and the card
 * surface (`--surface-1`) of each theme with ui/lib/palette.ts (a port of validate_palette.js).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractBlock, parseDeclarations } from './contrast.ts';
import { CONTRAST_MIN, CVD_TARGET, NORMAL_FLOOR, contrast, deltaE, tokenHex, validateOrdinal } from './palette.ts';
import type { Mode } from './palette.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const tokensCss = read('../../styles/tokens.css');
const chartsCss = read('../../styles/charts.css');

/** Token map in force under `<html data-theme={mode}>`: later blocks override earlier ones, as in the cascade. */
function theme(mode: Mode): Map<string, string> {
  const blocks: [string, string][] = [
    [tokensCss, ':root'],
    [tokensCss, '[data-theme="light"]'],
    [chartsCss, '[data-theme="light"]'],
  ];
  if (mode === 'dark') blocks.push([tokensCss, '[data-theme="dark"]'], [chartsCss, '[data-theme="dark"]']);
  const map = new Map<string, string>();
  for (const [css, selector] of blocks) {
    const body = extractBlock(css, selector);
    assert.ok(body !== null, `${selector} block missing`);
    for (const [k, v] of parseDeclarations(body)) map.set(k, v);
  }
  return map;
}

function hex(mode: Mode, name: string): string {
  const v = tokenHex(name, theme(mode));
  assert.ok(v, `${mode}: ${name} does not resolve to #rrggbb`);
  return v;
}

const cvd = (a: string, b: string) => Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan'));
const ORDINAL = ['--chart-o1', '--chart-o2', '--chart-o3', '--chart-o4', '--chart-o5'];

for (const mode of ['light', 'dark'] as const) {
  describe(`${mode} theme`, () => {
    const surfaces = ['--surface-0', '--surface-1'].map((s) => [s, hex(mode, s)] as const);
    const slot1 = hex(mode, '--chart-1');
    const slot2 = hex(mode, '--chart-2');
    const other = hex(mode, '--chart-other');

    test('slot 1, slot 2 and the context grey stand ≥ 3:1 on the canvas and the card surface', () => {
      for (const [name, bg] of surfaces) {
        for (const [token, c] of [['--chart-1', slot1], ['--chart-2', slot2], ['--chart-other', other]] as const) {
          const r = contrast(c, bg);
          assert.ok(r >= CONTRAST_MIN, `${token} ${c} on ${name} ${bg}: ${r.toFixed(2)}:1`);
        }
      }
    });

    test('the context grey stays apart from slot 1 and slot 2 (normal ΔE ≥ 15, CVD ΔE ≥ 8)', () => {
      for (const [token, c] of [['--chart-1', slot1], ['--chart-2', slot2]] as const) {
        assert.ok(deltaE(other, c) >= NORMAL_FLOOR, `${token} vs --chart-other normal ΔE ${deltaE(other, c).toFixed(1)}`);
        assert.ok(cvd(other, c) >= CVD_TARGET, `${token} vs --chart-other CVD ΔE ${cvd(other, c).toFixed(1)}`);
      }
    });

    test('polarity: slot 1 (+) and slot 2 (−) are told apart in every vision', () => {
      assert.ok(deltaE(slot1, slot2) >= NORMAL_FLOOR);
      assert.ok(cvd(slot1, slot2) >= CVD_TARGET);
    });

    test('the running period (--chart-partial) stays apart from slot 1 (normal ΔE ≥ 15)', () => {
      const partial = hex(mode, '--chart-partial');
      assert.ok(deltaE(partial, slot1) >= NORMAL_FLOOR, `normal ΔE ${deltaE(partial, slot1).toFixed(1)}`);
      assert.ok(cvd(partial, slot1) >= CVD_TARGET, `CVD ΔE ${cvd(partial, slot1).toFixed(1)}`);
    });

    test('the ordinal ramp: one hue, monotone lightness, adjacent ΔL ≥ 0.06, light end ≥ 2:1 (and its 3-step subset)', () => {
      const ramp = ORDINAL.map((t) => hex(mode, t));
      for (const [name, bg] of surfaces) {
        for (const steps of [ramp, [ramp[0], ramp[2], ramp[4]]]) {
          const r = validateOrdinal(steps, { mode, surface: bg });
          assert.ok(r.monotone, `${steps}: lightness not monotone`);
          assert.ok(r.minGap >= 0.06, `${steps}: adjacent ΔL ${r.minGap.toFixed(3)}`);
          assert.ok(r.lightEnd.ratio >= 2, `${steps}: light end ${r.lightEnd.hex} ${r.lightEnd.ratio.toFixed(2)}:1 on ${name}`);
          assert.ok(r.hueSpread <= 40, `${steps}: hue spread ${r.hueSpread.toFixed(0)}°`);
          assert.ok(r.ok);
        }
      }
      // Age reads light (new) → dark (old) in light mode, and dark → light on the dark canvas.
      const L = validateOrdinal(ramp, { mode }).lightness;
      assert.ok(mode === 'light' ? L[0] > L[4] : L[0] < L[4], `${mode}: o1 → o5 runs the wrong way`);
    });

    test('"Not due" grey beside the newest age bucket (o1) is distinct', () => {
      const o1 = hex(mode, '--chart-o1');
      assert.ok(deltaE(other, o1) >= NORMAL_FLOOR, `normal ΔE ${deltaE(other, o1).toFixed(1)}`);
      assert.ok(cvd(other, o1) >= CVD_TARGET, `CVD ΔE ${cvd(other, o1).toFixed(1)}`);
    });
  });
}

test('the shipped ramp and running-period colours are the validated ones (§2.1)', () => {
  assert.deepEqual(ORDINAL.map((t) => hex('light', t)), ['#a3aaf6', '#7f86ee', '#5f64e0', '#4b4fcc', '#33368a']);
  assert.deepEqual(ORDINAL.map((t) => hex('dark', t)), ['#3e41ad', '#5f64e0', '#7f86ee', '#a3aaf6', '#c6cbfb']);
  assert.equal(hex('light', '--chart-partial'), '#7f86ee');
  assert.equal(hex('dark', '--chart-partial'), '#4b4fcc');
  assert.equal(hex('light', '--chart-other'), '#808897');
  assert.equal(hex('dark', '--chart-other'), '#6e7686');
});

test('graphs draw only the four meanings: no rule reads slot 3, 4 or 5 (D29) and status tokens are never a series', () => {
  const css = chartsCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /var\(--chart-[345]\)/);
  for (const m of css.matchAll(/--series:\s*([^;]+);/g)) assert.doesNotMatch(m[1], /--(danger|warning|success|info|positive|negative)/, m[0]);
});
