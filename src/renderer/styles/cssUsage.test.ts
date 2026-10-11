/**
 * Dead-CSS guard (2.0, R2): every class a renderer stylesheet defines must be used by the renderer's
 * TypeScript — written out literally (`className="bx-card"`, `cx('is-open')`) or built at runtime
 * from a prefix declared below (`bx-badge--${tone}`). A class nobody renders is deleted, not
 * allowlisted. Every allowlist entry must still be needed and must point at the code that builds
 * the class (honesty check), so the list can only describe real dynamic class names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(RENDERER);
const cssFiles = files.filter((f) => f.endsWith('.css'));
/** Renderer code (tests excluded) with full-line comments removed, so a class named only in a comment does not count. */
const source = files
  .filter((f) => /\.(tsx?|html)$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n'),
  )
  .join('\n');
const sourceTokens = new Set(source.match(/[A-Za-z0-9_-]+/g) ?? []);

interface Dynamic {
  /** Class-name prefix (or pattern) produced at runtime. */
  match: string | RegExp;
  /** Text that must appear in the renderer code building the class (defaults to `${match}${`). */
  evidence?: string;
}

/**
 * Class names built at runtime. Keep sorted by prefix; each one names the template literal that
 * builds it. A prefix no class needs any more, or whose builder is gone, fails the test below.
 */
export const DYNAMIC_CLASSES: readonly Dynamic[] = [
  { match: 'bx-badge--' }, // Badge: tone, variant, size
  { match: 'bx-banner--' }, // Banner: tone
  { match: 'bx-btn--' }, // Button: variant, size
  { match: 'bx-card__body--' }, // Card: padding
  { match: 'bx-chart--o-' }, // graph kit: ordinal ramp step (ui/lib/chart.ts colorClass)
  { match: 'bx-chart--s-' }, // charts: series slot
  { match: 'bx-chart__key--' }, // chart legend: key shape
  { match: 'bx-db-alert__icon--' }, // dashboard alerts: tone
  { match: 'bx-divider--' }, // Divider: orientation
  { match: 'bx-drawer--' }, // Drawer: size
  { match: 'bx-empty--' }, // EmptyState: size
  { match: 'bx-field--' }, // Field: layout
  { match: 'bx-fieldgroup--cols-' }, // FieldGroup: columns
  { match: 'bx-gate__main--' }, // Gateway: width
  { match: 'bx-icon-btn--' }, // IconButton: variant, size
  { match: 'bx-input--' }, // inputs: size
  { match: 'bx-input__field--' }, // inputs: alignment
  { match: 'bx-kbd--' }, // Kbd: tone
  { match: 'bx-kbd-group--' }, // Kbd: tone, size
  { match: 'bx-kv--' }, // KeyValueList: layout, columns
  { match: 'bx-modal--' }, // Modal: size
  { match: 'bx-os-lvl-' }, // outstanding ageing levels
  { match: 'bx-progress--' }, // ProgressBar: tone, size
  { match: 'bx-radio-group--' }, // RadioGroup: orientation
  { match: 'bx-screen-layout--' }, // Screen: width
  { match: 'bx-sec-diff__row--' }, // edit log diff: change kind
  { match: 'bx-sec-timeline__item--' }, // edit log timeline: action
  { match: 'bx-segmented--' }, // SegmentedControl: size
  { match: 'bx-select--' }, // Select: size
  { match: 'bx-skeleton--' }, // Skeleton: variant
  { match: 'bx-sparkline--' }, // Sparkline: tone
  { match: 'bx-spinner--' }, // Spinner: size
  { match: 'bx-split--' }, // SplitPane: direction
  { match: 'bx-strength--' }, // password strength meter (company wizard)
  { match: 'bx-tag--' }, // Tag: tone
  { match: 'bx-td--' }, // DataTable: cell kind / alignment
  { match: 'bx-th--' }, // DataTable: header alignment
  { match: 'bx-toast--' }, // Toast: tone
  { match: 'bx-toolbar--' }, // Toolbar: variant
  { match: 'bx-vch-col--' }, // voucher grids: column ids
  { match: /^is-[0-4]$/, evidence: 'is-${s.score}' }, // data module: password strength score
  { match: 'is-reachable', evidence: 'is-${state}' }, // company wizard stepper states
];

/**
 * Unused classes in files another 2.0 package owns, left for that owner to delete (WP-01 may not
 * edit them). An entry that is no longer defined, or is now used, fails the test: remove it.
 */
export const PENDING_OTHER_OWNER: Readonly<Record<string, string>> = {};

/**
 * Tokens a 2.1 lane left without a reader (SPEC-21 §6.1 (iii)): one sorted line each, value = why. They
 * may be unread until the next wave merge, where the integrator deletes them from tokens.css and empties
 * this list. An entry that tokens.css no longer declares fails the test below: remove it.
 */
export const RETIRING_TOKENS: Readonly<Record<string, string>> = {
  '--card-p': 'WP-A: cards are flat (no padding); WP-C1: KPI figures lost their card padding',
  '--tracking-caps': 'WP-A/WP-B1/WP-B3: no upper-case captions in 2.1 (the wave-1 sweep deletes it)',
};

/** Class names defined by a stylesheet (selectors only; comments, strings and url() ignored). */
export function definedClasses(css: string): Set<string> {
  const clean = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\([^)]*\)/g, '')
    .replace(/"[^"\n]*"|'[^'\n]*'/g, '""');
  const names = new Set<string>();
  for (const m of clean.matchAll(/([^{}]+)\{/g)) {
    const prelude = m[1].trim();
    if (prelude.startsWith('@')) continue;
    for (const c of prelude.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(c[1]);
  }
  return names;
}

function dynamicFor(name: string): Dynamic | undefined {
  return DYNAMIC_CLASSES.find((d) => (typeof d.match === 'string' ? name.startsWith(d.match) : d.match.test(name)));
}

function evidenceOf(d: Dynamic): string {
  return d.evidence ?? `${String(d.match)}\${`;
}

const defined = new Map<string, string[]>();
for (const f of cssFiles) {
  for (const name of definedClasses(readFileSync(f, 'utf8'))) {
    const where = defined.get(name) ?? [];
    where.push(relative(RENDERER, f));
    defined.set(name, where);
  }
}

test('definedClasses reads selectors, not declarations, comments or at-rules', () => {
  const css = `/* .bx-commented */ .bx-a, .bx-b:hover > .is-on { width: 0.5em; background: url(x.bx-img.png); }
@media (max-width: 720px) { .bx-c { content: ".bx-string"; } }
@keyframes bx-spin { to { transform: rotate(1turn); } }`;
  assert.deepEqual([...definedClasses(css)].sort(), ['bx-a', 'bx-b', 'bx-c', 'is-on']);
});

test('the scan sees the renderer stylesheets and code', () => {
  assert.ok(cssFiles.length >= 15, `found ${cssFiles.length} stylesheets`);
  assert.ok(defined.size > 800, `found ${defined.size} classes`);
  assert.ok(sourceTokens.has('bx-btn'), 'renderer code is scanned');
});

test('every class defined in renderer CSS is used by renderer code', () => {
  const dead: string[] = [];
  for (const [name, where] of defined) {
    if (sourceTokens.has(name)) continue;
    const d = dynamicFor(name);
    if (d && source.includes(evidenceOf(d))) continue;
    if (name in PENDING_OTHER_OWNER) continue;
    dead.push(`${name}  (${where.join(', ')})`);
  }
  assert.deepEqual(dead, [], `Unused CSS classes — delete the rules (or declare a real dynamic prefix):\n${dead.join('\n')}`);
});

test('every dynamic-class allowlist entry is still needed and its builder exists', () => {
  const problems: string[] = [];
  for (const d of DYNAMIC_CLASSES) {
    if (!source.includes(evidenceOf(d))) problems.push(`${String(d.match)}: no code builds it (looked for "${evidenceOf(d)}")`);
    const rescued = [...defined.keys()].filter((n) => !sourceTokens.has(n) && dynamicFor(n) === d);
    if (rescued.length === 0) problems.push(`${String(d.match)}: no CSS class needs this entry any more`);
  }
  assert.deepEqual(problems, []);
});

test('pending entries for other owners are still defined and still unused', () => {
  for (const [name, owner] of Object.entries(PENDING_OTHER_OWNER)) {
    assert.ok(defined.has(name), `${name} is gone — remove it from PENDING_OTHER_OWNER (${owner})`);
    assert.ok(!sourceTokens.has(name), `${name} is used now — remove it from PENDING_OTHER_OWNER (${owner})`);
  }
});

// Custom properties: nothing reads an undefined token, and tokens.css holds no unused semantic token.

const cssText = cssFiles.map((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
const PALETTE = /^--(slate|indigo|saffron|green|amber|red|blue)-\d+$/;

/** `--space-N` names `spaceVar()` (ui/types.ts) builds at runtime for every step of the `Space` scale. */
export function spaceTokens(typesTs: string): string[] {
  const union = /export type Space\s*=\s*([^;]+);/.exec(typesTs);
  assert.ok(union, 'ui/types.ts declares the Space scale');
  return union[1].split('|').map((step) => `--space-${step.trim().replace('.', '-')}`);
}
const SPACE_TOKENS = spaceTokens(readFileSync(join(RENDERER, 'ui', 'types.ts'), 'utf8'));

test('every custom property a stylesheet reads without a fallback is defined', () => {
  const declared = new Set<string>();
  for (const m of cssText.matchAll(/(--[A-Za-z][\w-]*)\s*:/g)) declared.add(m[1]);
  // Set from code: style={{ '--level': 2 }}, el.style.setProperty('--x', …)
  for (const m of source.matchAll(/['"`](--[A-Za-z][\w-]*)['"`]/g)) declared.add(m[1]);
  const missing = new Set<string>();
  for (const m of cssText.matchAll(/var\(\s*(--[A-Za-z][\w-]*)\s*\)/g)) if (!declared.has(m[1])) missing.add(m[1]);
  assert.deepEqual([...missing].sort(), []);
});

test('every token renderer code reads (inline var(), spaceVar steps) is defined in CSS', () => {
  const declared = new Set([...cssText.matchAll(/(--[A-Za-z][\w-]*)\s*:/g)].map((m) => m[1]));
  const read = new Set([...source.matchAll(/var\(\s*(--[A-Za-z][\w-]*)\s*[,)]/g)].map((m) => m[1]));
  for (const t of SPACE_TOKENS) read.add(t);
  assert.ok(read.has('--space-0') && read.has('--space-0-5'), 'spaceVar steps are scanned');
  assert.deepEqual([...read].filter((t) => !declared.has(t)).sort(), []);
});

test('tokens.css declares no unused semantic token (palette primitives excepted)', () => {
  const tokens = readFileSync(join(RENDERER, 'styles', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // The contrast test's pair lists count as readers: they keep a token's AA guarantee checked.
  const contrastPairs = readFileSync(join(RENDERER, 'ui', 'lib', 'contrast.test.ts'), 'utf8');
  // spaceVar() builds `var(--space-${step})` for every step of the Space scale (ui/types.ts).
  const readers = `${cssText}\n${source}\n${contrastPairs}\n${SPACE_TOKENS.map((t) => `var(${t})`).join('\n')}`;
  const unused: string[] = [];
  for (const name of new Set([...tokens.matchAll(/^\s*(--[a-z][\w-]*)\s*:/gm)].map((m) => m[1]))) {
    if (PALETTE.test(name) || name in RETIRING_TOKENS) continue;
    const read = new RegExp(`var\\(\\s*${name}\\s*[,)]|['"\`]${name}['"\`]`).test(readers);
    if (!read) unused.push(name);
  }
  assert.deepEqual(unused, []);
});

test('retiring tokens are still declared in tokens.css (delete the entry once the token is gone)', () => {
  const tokens = readFileSync(join(RENDERER, 'styles', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const declared = new Set([...tokens.matchAll(/^\s*(--[a-z][\w-]*)\s*:/gm)].map((m) => m[1]));
  const stale = Object.keys(RETIRING_TOKENS).filter((t) => !declared.has(t));
  assert.deepEqual(stale, []);
  const keys = Object.keys(RETIRING_TOKENS);
  assert.deepEqual(keys, [...keys].sort(), 'one sorted line per token');
});

// Type scale (docs/ARCHITECTURE.md §7a): captions are 12px (`--text-caption`); 11px (`--fs-11`) is
// for key chips only. Chart axis text stays 11px because ui/chartParts.tsx lays labels out with
// `textWidth(s, 11)`. No stylesheet is exempt (the 2.0 ratchet reached zero).

const FS11_SELECTORS = /^\.bx-kbd|^\.bx-chart__(tick|category|direct-label)$/;

/** Selectors of the rules that declare `font-size: var(--fs-11)`. */
export function fs11Selectors(css: string): string[] {
  const out: string[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/font-size:\s*var\(--fs-11\)/.test(m[2])) out.push(...m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')));
  }
  return out;
}

test('fs11Selectors finds the rules that use 11px', () => {
  assert.deepEqual(fs11Selectors('.a, .b { font-size: var(--fs-11); } .c { font-size: var(--fs-12); }'), ['.a', '.b']);
});

test('11px text is only for key chips (and chart axis labels)', () => {
  const offenders: string[] = [];
  for (const f of cssFiles) {
    const rel = relative(RENDERER, f).split('\\').join('/');
    const selectors = fs11Selectors(readFileSync(f, 'utf8'));
    for (const s of selectors) if (!FS11_SELECTORS.test(s)) offenders.push(`${s}  (${rel})`);
  }
  assert.deepEqual(offenders, [], 'use var(--text-caption) (12px) for captions');
});

test('the classed-list reset has zero specificity, so component list padding and markers win', () => {
  const base = readFileSync(join(RENDERER, 'styles', 'base.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(base, /:where\(ol\[class\], ul\[class\]\) \{\s*padding: 0;\s*list-style: none;/);
  assert.doesNotMatch(base.replace(/:where\([^)]*\)/g, ''), /\b(ul|ol)\[class\]/);
});
