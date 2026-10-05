/**
 * WCAG 2.x contrast math (used by the token contrast test to keep every text/background pair AA).
 * Pure — no DOM.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(r g b / a)', 'rgba(r, g, b, a)'. Null when unsupported. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const nums = m[1].split(/[\s,/]+/).filter(Boolean);
    if (nums.length < 3) return null;
    const [r, g, b] = nums.slice(0, 3).map(Number);
    const aRaw = nums[3];
    const a = aRaw === undefined ? 1 : aRaw.endsWith('%') ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw);
    if ([r, g, b, a].some((v) => !Number.isFinite(v))) return null;
    return { r, g, b, a };
  }
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  return null;
}

/** Composite a (possibly translucent) colour over an opaque background. */
export function blend(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** Contrast ratio 1–21 of `fg` over `bg` (translucent fg is composited over bg first). */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const top = fg.a < 1 ? blend(fg, bg) : fg;
  const l1 = relativeLuminance(top);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Resolve `var(--x)` chains against a token map (first fallback honoured). */
export function resolveToken(value: string, tokens: ReadonlyMap<string, string>, depth = 0): string {
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value.trim());
  if (!m || depth > 20) return value.trim();
  const next = tokens.get(m[1]);
  if (next === undefined) return m[2] ? resolveToken(m[2], tokens, depth + 1) : value.trim();
  return resolveToken(next, tokens, depth + 1);
}

/** Parse `--name: value;` declarations out of a CSS block body. */
export function parseDeclarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) out.set(m[1], m[2].trim());
  return out;
}

/** Body of the first top-level rule whose selector text equals `selector` exactly. */
export function extractBlock(css: string, selector: string): string | null {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const idx = clean.indexOf(`${selector} {`);
  if (idx < 0) return null;
  let depth = 0;
  const start = clean.indexOf('{', idx);
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') {
      depth--;
      if (depth === 0) return clean.slice(start + 1, i);
    }
  }
  return null;
}
