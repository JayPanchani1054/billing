/**
 * palette.ts reproduces the dataviz validator's published numbers (SPEC-21 §4.3, run 2026-10-10 on
 * the 2.1 surfaces: light canvas #ffffff, dark canvas #15181f) to ±0.1 — OKLab ΔE, Machado CVD
 * simulation and WCAG contrast — so the shipped chart tokens can be re-validated in CI.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, parseColor } from './contrast.ts';
import { contrast, deltaE, hexToSrgb, oklch, simulate, tokenHex, validateCategorical, validateOrdinal } from './palette.ts';

const LIGHT = '#ffffff';
const DARK = '#15181f';

function near(actual: number, expected: number, what: string, tol = 0.1) {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual.toFixed(3)} ≠ ${expected} ± ${tol}`);
}

describe('categorical slots (2.0 order, unchanged hex)', () => {
  test('light #4b4fcc,#e0701b,#1a9e72 on #ffffff — all checks pass', () => {
    const r = validateCategorical(['#4b4fcc', '#e0701b', '#1a9e72'], { mode: 'light', surface: LIGHT });
    assert.equal(r.ok, true);
    assert.deepEqual([r.offBand, r.lowChroma, r.lowContrast], [[], [], []]);
    near(r.cvd.deltaE, 9.7, 'CVD worst');
    assert.equal(r.cvd.kind, 'protan');
    assert.deepEqual([r.cvd.a, r.cvd.b], ['#e0701b', '#1a9e72']);
    near(r.tritan, 30.6, 'tritan');
    near(r.normal.deltaE, 24.7, 'normal');
  });

  test('dark #7f86ee,#d95926,#199e70 on #15181f — all checks pass', () => {
    const r = validateCategorical(['#7f86ee', '#d95926', '#199e70'], { mode: 'dark', surface: DARK });
    assert.equal(r.ok, true);
    near(r.cvd.deltaE, 9.4, 'CVD worst');
    assert.equal(r.cvd.kind, 'deutan');
    near(r.normal.deltaE, 26.5, 'normal');
    assert.deepEqual(r.lowContrast, []);
  });

  test('slot contrast: light 6.38 / 3.23 / 3.40, dark 5.54 / 4.57 / 5.22', () => {
    near(contrast('#4b4fcc', LIGHT), 6.38, 'slot 1 light', 0.01);
    near(contrast('#e0701b', LIGHT), 3.23, 'slot 2 light', 0.01);
    near(contrast('#1a9e72', LIGHT), 3.4, 'slot 3 light', 0.01);
    near(contrast('#7f86ee', DARK), 5.54, 'slot 1 dark', 0.01);
    near(contrast('#d95926', DARK), 4.57, 'slot 2 dark', 0.01);
    near(contrast('#199e70', DARK), 5.22, 'slot 3 dark', 0.01);
  });
});

describe('context grey (--chart-other)', () => {
  test('light #808897 beside slot 1: CVD 19.4 protan, normal 20.7, ≥ 3:1 (3.57); chroma "fails" by design', () => {
    const r = validateCategorical(['#4b4fcc', '#808897'], { mode: 'light', surface: LIGHT });
    near(r.cvd.deltaE, 19.4, 'CVD');
    assert.equal(r.cvd.kind, 'protan');
    near(r.normal.deltaE, 20.7, 'normal');
    assert.deepEqual(r.lowChroma.map((x) => x.hex), ['#808897']);
    near(contrast('#808897', LIGHT), 3.57, 'grey light', 0.01);
  });

  test('2.0 dark grey #808897 is rejected: normal ΔE 13.4 < 15', () => {
    const r = validateCategorical(['#7f86ee', '#808897'], { mode: 'dark', surface: DARK });
    near(r.normal.deltaE, 13.4, 'normal');
    assert.equal(r.normal.state, 'fail');
  });

  test('#5b6373 is rejected: contrast 2.94 < 3:1 (CVD 19.7, normal 20.6)', () => {
    const r = validateCategorical(['#7f86ee', '#5b6373'], { mode: 'dark', surface: DARK });
    near(r.cvd.deltaE, 19.7, 'CVD');
    near(r.normal.deltaE, 20.6, 'normal');
    assert.deepEqual(r.lowContrast.map((x) => x.hex), ['#5b6373']);
    near(r.lowContrast[0].ratio, 2.94, 'contrast', 0.01);
  });

  test('ADOPTED dark #6e7686: CVD 15.4 deutan, normal 16.0, ≥ 3:1 (3.89) — also on the old canvas #101318', () => {
    for (const surface of [DARK, '#101318']) {
      const r = validateCategorical(['#7f86ee', '#6e7686'], { mode: 'dark', surface });
      near(r.cvd.deltaE, 15.4, 'CVD');
      assert.equal(r.cvd.kind, 'deutan');
      near(r.normal.deltaE, 16.0, 'normal');
      assert.equal(r.normal.state, 'pass');
      assert.deepEqual(r.lowContrast, []);
    }
    near(contrast('#6e7686', DARK), 3.89, 'grey dark', 0.01);
  });
});

describe('problem pole next to grey; polarity; running period', () => {
  test("'problem': light worst #808897↔#e0701b 15.0 protan / normal 19.0; dark 12.8 / 20.1", () => {
    const l = validateCategorical(['#4b4fcc', '#e0701b', '#808897'], { mode: 'light', surface: LIGHT });
    near(l.cvd.deltaE, 15.0, 'CVD light');
    assert.deepEqual([l.cvd.a, l.cvd.b, l.cvd.kind], ['#e0701b', '#808897', 'protan']);
    near(l.normal.deltaE, 19.0, 'normal light');
    const d = validateCategorical(['#7f86ee', '#d95926', '#6e7686'], { mode: 'dark', surface: DARK });
    near(d.cvd.deltaE, 12.8, 'CVD dark');
    assert.equal(d.cvd.kind, 'protan');
    near(d.normal.deltaE, 20.1, 'normal dark');
  });

  test("'polarity': light 31.0 protan / 36.6; dark 27.4 deutan / 28.7 — all pass", () => {
    const l = validateCategorical(['#4b4fcc', '#e0701b'], { mode: 'light', surface: LIGHT });
    assert.equal(l.ok, true);
    near(l.cvd.deltaE, 31.0, 'CVD light');
    near(l.normal.deltaE, 36.6, 'normal light');
    const d = validateCategorical(['#7f86ee', '#d95926'], { mode: 'dark', surface: DARK });
    assert.equal(d.ok, true);
    near(d.cvd.deltaE, 27.4, 'CVD dark');
    assert.equal(d.cvd.kind, 'deutan');
    near(d.normal.deltaE, 28.7, 'normal dark');
  });

  test('--chart-partial: light #7f86ee passes (15.3 / 16.5); dark o2 #5f64e0 fails (10.0); dark #4b4fcc adopted (2.78:1 relief)', () => {
    const l = validateCategorical(['#4b4fcc', '#7f86ee'], { mode: 'light', surface: LIGHT });
    assert.equal(l.ok, true);
    near(l.cvd.deltaE, 15.3, 'CVD light');
    near(l.normal.deltaE, 16.5, 'normal light');
    const rejected = validateCategorical(['#7f86ee', '#5f64e0'], { mode: 'dark', surface: DARK });
    near(rejected.normal.deltaE, 10.0, 'normal o2');
    assert.equal(rejected.ok, false);
    const adopted = validateCategorical(['#7f86ee', '#4b4fcc'], { mode: 'dark', surface: DARK });
    assert.equal(adopted.ok, true);
    near(adopted.normal.deltaE, 16.5, 'normal adopted');
    near(adopted.lowContrast[0].ratio, 2.78, 'relief', 0.01);
  });
});

describe('ordinal ramp (age, lateness)', () => {
  test('light o1…o5 passes: monotone, ΔL ≥ 0.06, light end #a3aaf6 2.18:1, hue spread 4°', () => {
    const r = validateOrdinal(['#a3aaf6', '#7f86ee', '#5f64e0', '#4b4fcc', '#33368a'], { mode: 'light', surface: LIGHT });
    assert.equal(r.ok, true);
    assert.equal(r.monotone, true);
    assert.ok(r.minGap >= 0.06);
    assert.equal(r.lightEnd.hex, '#a3aaf6');
    near(r.lightEnd.ratio, 2.18, 'light end', 0.01);
    near(r.hueSpread, 4, 'hue spread', 0.5);
  });

  test('dark o1…o5 passes: light end #3e41ad 2.17:1', () => {
    const r = validateOrdinal(['#3e41ad', '#5f64e0', '#7f86ee', '#a3aaf6', '#c6cbfb'], { mode: 'dark', surface: DARK });
    assert.equal(r.ok, true);
    assert.equal(r.lightEnd.hex, '#3e41ad');
    near(r.lightEnd.ratio, 2.17, 'light end', 0.01);
  });

  test('3-step subsets o1, o3, o5 pass in both themes', () => {
    assert.equal(validateOrdinal(['#a3aaf6', '#5f64e0', '#33368a'], { mode: 'light', surface: LIGHT }).ok, true);
    assert.equal(validateOrdinal(['#3e41ad', '#7f86ee', '#c6cbfb'], { mode: 'dark', surface: DARK }).ok, true);
  });

  test('six indigo steps are rejected (adjacent ΔL 0.059)', () => {
    const r = validateOrdinal(['#a3aaf6', '#7f86ee', '#5f64e0', '#4b4fcc', '#3e41ad', '#33368a'], { mode: 'light', surface: LIGHT });
    assert.equal(r.ok, false);
    near(r.minGap, 0.059, 'min gap', 0.002);
  });

  test('"Not due" grey next to o1: light 15.4 / 16.1, dark 17.6 / 18.9', () => {
    const l = validateCategorical(['#808897', '#a3aaf6'], { mode: 'light', surface: LIGHT });
    near(l.cvd.deltaE, 15.4, 'CVD light');
    near(l.normal.deltaE, 16.1, 'normal light');
    const d = validateCategorical(['#6e7686', '#3e41ad'], { mode: 'dark', surface: DARK });
    near(d.cvd.deltaE, 17.6, 'CVD dark');
    near(d.normal.deltaE, 18.9, 'normal dark');
  });

  test('a reversed or multi-hue ramp fails', () => {
    assert.equal(validateOrdinal(['#a3aaf6', '#4b4fcc', '#7f86ee'], { mode: 'light', surface: LIGHT }).monotone, false);
    assert.ok(validateOrdinal(['#4b4fcc', '#e0701b'], { mode: 'light', surface: LIGHT }).hueSpread > 40);
  });
});

describe('primitives', () => {
  test('WCAG contrast agrees with ui/lib/contrast.ts (to 0.01) and is order-free', () => {
    for (const [a, b] of [
      ['#4b4fcc', '#ffffff'],
      ['#808897', '#15181f'],
      ['#e0701b', '#101318'],
      ['#000000', '#ffffff'],
    ]) {
      const theirs = contrastRatio(parseColor(a)!, parseColor(b)!);
      near(contrast(a, b), theirs, `${a}/${b}`, 0.01);
      assert.equal(contrast(a, b), contrast(b, a));
    }
    near(contrast('#000000', '#ffffff'), 21, 'black/white', 1e-9);
  });

  test('OKLCH of white and black; simulation keeps greys grey; identical colours ΔE 0', () => {
    near(oklch('#ffffff').L, 1, 'white L', 1e-6);
    near(oklch('#000000').L, 0, 'black L', 1e-6);
    near(oklch('#808897').C, 0.024, 'grey chroma', 0.001);
    const g = simulate('#777777', 'deutan');
    assert.ok(Math.abs(g[0] - g[1]) < 0.01 && Math.abs(g[1] - g[2]) < 0.01);
    assert.equal(deltaE('#4b4fcc', '#4b4fcc'), 0);
  });

  test('hex input boundary: #rrggbb only', () => {
    assert.deepEqual(hexToSrgb('#ff0000'), [1, 0, 0]);
    assert.deepEqual(hexToSrgb(' 00ff00 '), [0, 1, 0]);
    assert.throws(() => hexToSrgb('#fff'));
    assert.throws(() => hexToSrgb('red'));
  });

  test('tokenHex follows var() chains to a hex', () => {
    const tokens = new Map([
      ['--indigo-400', '#7F86EE'],
      ['--chart-partial', 'var(--indigo-400)'],
      ['--chart-x', 'var(--missing, #123456)'],
      ['--chart-y', 'rgb(1 2 3)'],
    ]);
    assert.equal(tokenHex('--chart-partial', tokens), '#7f86ee');
    assert.equal(tokenHex('--chart-x', tokens), '#123456');
    assert.equal(tokenHex('--chart-y', tokens), null);
    assert.equal(tokenHex('--nope', tokens), null);
  });
});
