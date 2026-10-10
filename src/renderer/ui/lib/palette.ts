/**
 * Palette math for the graph colours (SPEC-21 §4.3) — a faithful TypeScript port of the dataviz
 * validator (`validate_palette.js`): OKLab / OKLCH, Machado–Oliveira–Fernandes (2009) colour-vision
 * deficiency simulation at severity 1.0, OKLab ΔE ×100, and WCAG 2.x contrast. Pure — no DOM — so
 * the shipped chart tokens can be re-validated in node (ui/lib/palette.test.ts reproduces the
 * validator's published numbers; WP-C1's chartPalette.test.ts runs it against tokens.css/charts.css).
 *
 * Thresholds and formulas are the validator's own; keep them in lockstep with it.
 */

export type VisionKind = 'protan' | 'deutan' | 'tritan';
export type Mode = 'light' | 'dark';

/** OKLCH lightness band per mode (categorical slots). */
export const LIGHTNESS_BAND: Readonly<Record<Mode, readonly [number, number]>> = { light: [0.43, 0.77], dark: [0.48, 0.67] };
/** OKLCH chroma below which a hue reads as grey. */
export const CHROMA_FLOOR = 0.1;
/** Adjacent-pair CVD ΔE: ≥ target passes; [floor, target) is legal only with secondary encoding. */
export const CVD_TARGET = 8;
export const CVD_FLOOR = 6;
/** Worst unsimulated ΔE on the pair list: a hard gate. */
export const NORMAL_FLOOR = 15;
/** WCAG contrast of a mark against its surface. */
export const CONTRAST_MIN = 3;
/** Ordinal ramps: adjacent OKLCH ΔL and the lightest step's contrast against the surface. */
export const ORDINAL_MIN_DL = 0.06;
export const ORDINAL_LIGHT_FLOOR = 2;
/** The validator's default surfaces (Pevqori passes its own canvas: light #ffffff, dark #15181f). */
export const DEFAULT_SURFACE: Readonly<Record<Mode, string>> = { light: '#fcfcfb', dark: '#1a1a19' };

type Vec3 = [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

/** Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB. */
export const MACHADO: Readonly<Record<VisionKind, Mat3>> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

export function isHex(value: string): boolean {
  return /^#?[0-9a-fA-F]{6}$/.test(value.trim());
}

/** '#rrggbb' → sRGB channels 0–1. Throws on anything else (the validator's input boundary). */
export function hexToSrgb(hex: string): Vec3 {
  const h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a #rrggbb colour: ${JSON.stringify(hex)}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Vec3;
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearRgb(hex: string): Vec3 {
  return hexToSrgb(hex).map(srgbToLinear) as Vec3;
}

/** WCAG relative luminance (validator variant: sRGB threshold 0.04045). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = linearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio 1–21 (order-free). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function oklabFromLinear([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function oklab(hex: string): Vec3 {
  return oklabFromLinear(linearRgb(hex));
}

/** OKLCH: lightness 0–1, chroma, hue in degrees 0–360. */
export function oklch(hex: string): { L: number; C: number; h: number } {
  const [L, a, b] = oklab(hex);
  return { L, C: Math.hypot(a, b), h: (((Math.atan2(b, a) * 180) / Math.PI) % 360 + 360) % 360 };
}

/** Linear RGB of `hex` as seen with a full (severity 1.0) colour-vision deficiency, clamped 0–1. */
export function simulate(hex: string, kind: VisionKind): Vec3 {
  const [r, g, b] = linearRgb(hex);
  const M = MACHADO[kind];
  const clamp = (c: number) => Math.max(0, Math.min(1, c));
  return [clamp(M[0][0] * r + M[0][1] * g + M[0][2] * b), clamp(M[1][0] * r + M[1][1] * g + M[1][2] * b), clamp(M[2][0] * r + M[2][1] * g + M[2][2] * b)];
}

/** OKLab Euclidean distance ×100; with `kind`, both colours are simulated first. */
export function deltaE(a: string, b: string, kind?: VisionKind): number {
  const x = oklabFromLinear(kind ? simulate(a, kind) : linearRgb(a));
  const y = oklabFromLinear(kind ? simulate(b, kind) : linearRgb(b));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export interface PairResult {
  deltaE: number;
  a: string;
  b: string;
}

export interface CategoricalReport {
  /** Slots outside the mode's lightness band, with their L. */
  offBand: { hex: string; L: number }[];
  /** Slots below the chroma floor (a grey "fails" this by design: grey is "not a series"). */
  lowChroma: { hex: string; C: number }[];
  /** Worst pair under protan/deutan simulation, and the tritan minimum (reported only). */
  cvd: PairResult & { kind: 'protan' | 'deutan'; state: 'pass' | 'floor' | 'fail' };
  tritan: number;
  /** Worst pair under normal vision (hard gate ≥ 15). */
  normal: PairResult & { state: 'pass' | 'fail' };
  /** Slots below 3:1 against the surface — "relief" (direct labels / table) rather than a failure. */
  lowContrast: { hex: string; ratio: number }[];
  /** The validator's verdict: band, chroma, CVD ≥ floor and the normal-vision floor. */
  ok: boolean;
}

function pairList(n: number, pairs: 'adjacent' | 'all'): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pairs === 'all' || j === i + 1) out.push([i, j]);
    }
  }
  return out;
}

/** The validator's categorical checks (2–5), as numbers. */
export function validateCategorical(palette: readonly string[], opts: { mode?: Mode; surface?: string; pairs?: 'adjacent' | 'all' } = {}): CategoricalReport {
  const mode = opts.mode ?? 'light';
  const surface = opts.surface ?? DEFAULT_SURFACE[mode];
  const [lo, hi] = LIGHTNESS_BAND[mode];
  const offBand = palette.map((hex) => ({ hex, L: oklch(hex).L })).filter((x) => x.L < lo || x.L > hi);
  const lowChroma = palette.map((hex) => ({ hex, C: oklch(hex).C })).filter((x) => x.C < CHROMA_FLOOR);
  const pairs = pairList(palette.length, opts.pairs ?? 'adjacent');

  let cvd: PairResult & { kind: 'protan' | 'deutan' } = { deltaE: 99, a: '', b: '', kind: 'protan' };
  for (const kind of ['protan', 'deutan'] as const) {
    for (const [i, j] of pairs) {
      const d = deltaE(palette[i], palette[j], kind);
      if (d < cvd.deltaE) cvd = { deltaE: d, a: palette[i], b: palette[j], kind };
    }
  }
  const tritan = pairs.length ? Math.min(...pairs.map(([i, j]) => deltaE(palette[i], palette[j], 'tritan'))) : 99;
  let normal: PairResult = { deltaE: 99, a: '', b: '' };
  for (const [i, j] of pairs) {
    const d = deltaE(palette[i], palette[j]);
    if (d < normal.deltaE) normal = { deltaE: d, a: palette[i], b: palette[j] };
  }
  const cvdState = cvd.deltaE >= CVD_TARGET ? 'pass' : cvd.deltaE >= CVD_FLOOR ? 'floor' : 'fail';
  const normalState = normal.deltaE >= NORMAL_FLOOR ? 'pass' : 'fail';
  const lowContrast = palette.map((hex) => ({ hex, ratio: contrast(hex, surface) })).filter((x) => x.ratio < CONTRAST_MIN);
  return {
    offBand,
    lowChroma,
    cvd: { ...cvd, state: cvdState },
    tritan,
    normal: { ...normal, state: normalState },
    lowContrast,
    ok: offBand.length === 0 && lowChroma.length === 0 && cvdState !== 'fail' && normalState === 'pass',
  };
}

export interface OrdinalReport {
  /** L per step, in input order. */
  lightness: number[];
  /** Steps read light→dark or dark→light without a reversal. */
  monotone: boolean;
  /** Smallest adjacent ΔL. */
  minGap: number;
  /** The lightest step (light mode) or darkest (dark mode) and its contrast against the surface. */
  lightEnd: { hex: string; ratio: number };
  /** Hue spread in degrees (≤ 40 = one hue). */
  hueSpread: number;
  ok: boolean;
}

/** The validator's ordinal checks: monotone L, adjacent ΔL ≥ 0.06, light end ≥ 2:1, one hue. */
export function validateOrdinal(palette: readonly string[], opts: { mode?: Mode; surface?: string } = {}): OrdinalReport {
  const mode = opts.mode ?? 'light';
  const surface = opts.surface ?? DEFAULT_SURFACE[mode];
  const Ls = palette.map((h) => oklch(h).L);
  const order = [...Ls.keys()].sort((a, b) => Ls[a] - Ls[b]);
  const monotone = order.every((v, i) => v === i) || order.every((v, i) => v === Ls.length - 1 - i);
  const gaps = Ls.slice(1).map((l, i) => Math.abs(l - Ls[i]));
  const minGap = gaps.length ? Math.min(...gaps) : Infinity;
  const byL = [...palette].sort((a, b) => oklch(a).L - oklch(b).L);
  const endHex = mode === 'light' ? byL[byL.length - 1] : byL[0];
  const ratio = endHex ? contrast(endHex, surface) : Infinity;
  const hues = palette.map((h) => oklch(h).h);
  let hueSpread = hues.length ? Math.max(...hues) - Math.min(...hues) : 0;
  if (hueSpread > 180) hueSpread = 360 - hueSpread;
  return {
    lightness: Ls,
    monotone,
    minGap,
    lightEnd: { hex: endHex ?? '', ratio },
    hueSpread,
    ok: monotone && minGap >= ORDINAL_MIN_DL && ratio >= ORDINAL_LIGHT_FLOOR && hueSpread <= 40,
  };
}

/**
 * Resolves a CSS custom property to a hex through `var()` chains (token maps parsed with
 * ui/lib/contrast.ts `parseDeclarations`). Null when it does not end in a #rrggbb value.
 */
export function tokenHex(name: string, tokens: ReadonlyMap<string, string>): string | null {
  let value = tokens.get(name);
  for (let depth = 0; value !== undefined && depth < 20; depth++) {
    const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value.trim());
    if (!m) break;
    value = tokens.get(m[1]) ?? m[2];
  }
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}
