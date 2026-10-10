/**
 * Brand gate. The product is called Pevqori; the earlier product name and the names of other accounting
 * products appear nowhere in the repository — UI text, docs, code, comments, tests, CI, file names —
 * with exactly these exceptions (docs/ARCHITECTURE.md, "Naming rule"):
 *
 *   - src/core/modules/data/xmlFormat.ts — element names fixed by the XML interchange format, and the
 *     values earlier builds stored for imported vouchers;
 *   - src/core/lib/legacyNames.ts, src/main/legacyUserData.ts — formats and folder names written by
 *     builds before the rename (only ever read).
 *
 * Even there each occurrence must be the value of an `export const` (no comments, no other use). The
 * gate also looks for spelled-around variants (split strings, separated letters, escapes, char codes,
 * base64, reversed, look-alike letters) so the rule cannot be dodged. The words themselves are taken
 * from those modules' constants, and other products' names are compared by hash, so this file spells
 * none of them.
 *
 * Scans the files git knows about (tracked plus untracked-not-ignored); falls back to a directory walk
 * when git is unavailable.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LEGACY_BACKUP_EXTENSION, LEGACY_BACKUP_FORMAT, LEGACY_BACKUP_MAGIC, LEGACY_IMPORT_SOURCE } from '../lib/legacyNames.ts';
import { MESSAGE_TAG } from '../modules/data/xmlFormat.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SELF = 'src/core/testing/brand.test.ts';

/** The earlier product name (from the legacy backup format "<name>-backup"). */
const OLD_NAME = LEGACY_BACKUP_FORMAT.slice(0, LEGACY_BACKUP_FORMAT.indexOf('-')).toLowerCase();
/** The other product whose XML interchange format the XML data import / export speaks. */
const FORMAT_VENDOR = LEGACY_IMPORT_SOURCE.toLowerCase();

interface Rule {
  word: string;
  /** The only files allowed to contain the word (as `export const` values). */
  allowed: ReadonlySet<string>;
}
const RULES: readonly Rule[] = [
  { word: OLD_NAME, allowed: new Set(['src/core/lib/legacyNames.ts', 'src/main/legacyUserData.ts']) },
  { word: FORMAT_VENDOR, allowed: new Set(['src/core/modules/data/xmlFormat.ts']) },
];

/**
 * Names of other accounting products (lower case, letters only), as the first 16 hex digits of their
 * SHA-256 — so this file does not spell them. Names that are also ordinary English or Hindi words are
 * not listed (they are reviewed by hand); the multi-word ones are listed with their spaces removed and
 * matched against adjacent words.
 */
const OTHER_PRODUCTS: ReadonlySet<string> = new Set([
  'adc9b9d6144323a9', 'cb2317426a5c336d', '884945522da706f9', '58b4537b616e6572', '1044e0e35135e0d6',
  '0f4277c252ec200b', '1dd8cb03d5dc9395', '615fc4fc0da886b3', '404e91050d105f97', '52f37777c4344c1f',
  '0cabc9d79279fff7', '80c207fb5721d976', '175144ba77273007', 'b8f278f242cf2fee', 'd1f6f53d41ab1298',
  '1c041f5b599bfd13', '238c960e4b9789ff', 'd1982f74ce26b1a2', '63508c686990d7d3',
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'release', 'coverage', 'test-results', 'playwright-report', '.tmp']);

function repoFiles(): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return [...new Set(out.toString('utf8').split('\0').filter((f) => f !== ''))];
  } catch {
    const files: string[] = [];
    const walk = (rel: string): void => {
      for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const r = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(r);
        } else if (e.isFile() && !e.name.endsWith('.log')) files.push(r);
      }
    };
    walk('');
    return files;
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The only shape a permitted occurrence may take: `export const NAME = '…';`. */
const CONSTANT_LINE = /^export const [A-Z][A-Z0-9_]* = '[^'\\]*';$/;

/** Cyrillic / Greek letters that look like Latin ones (enough for look-alike spellings). */
const LOOKALIKE: Readonly<Record<string, string>> = {
  'а': 'a', 'А': 'A', 'в': 'b', 'В': 'B', 'Ь': 'b', 'һ': 'h', 'Н': 'H', 'і': 'i', 'І': 'I', 'ӏ': 'l', 'Ӏ': 'l',
  'т': 't', 'Т': 'T', 'у': 'y', 'У': 'Y', 'Υ': 'Y', 'α': 'a', 'Α': 'A', 'Β': 'B', 'Η': 'H', 'ι': 'i', 'Ι': 'I',
  'Τ': 'T', 'τ': 't', 'γ': 'y', 'ℓ': 'l', 'ı': 'i',
};
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** The line with escapes decoded, invisible characters dropped and look-alike letters mapped. */
function decoded(line: string): string {
  return line
    .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|&#x([0-9a-f]{1,6});|&#(\d{1,7});|%([0-9a-f]{2})/gi, (m, a, b, c, d, e, f) => {
      const code = parseInt(a ?? b ?? c ?? d ?? f ?? '', 16) || parseInt(e ?? '', 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/[^\x00-\x7f]/g, (ch) => LOOKALIKE[ch] ?? ch);
}

/** Text of runs of character codes (`84, 97, …`, `0x54, 0x61, …`) in the line. */
function charCodeRuns(line: string): string[] {
  const runs = line.match(/(?:\b(?:0x[0-9a-f]{2}|\d{2,3})\b\s*,\s*){2,}\b(?:0x[0-9a-f]{2}|\d{2,3})\b/gi) ?? [];
  return runs.map((run) =>
    run
      .split(',')
      .map((n) => Number(n.trim()))
      .map((n) => (n >= 32 && n < 127 ? String.fromCharCode(n) : '\0'))
      .join(''),
  );
}

/** Text of base64 / base64url tokens in the text, decoded. */
function base64Runs(line: string): string[] {
  const tokens = line.match(/[A-Za-z0-9+/_-]{6,}={0,2}/g) ?? [];
  // Decoded from each of the four character offsets, so a token glued to other text is read too.
  const out: string[] = [];
  for (const t of tokens) for (let o = 0; o < 4 && t.length - o >= 6; o++) out.push(Buffer.from(t.slice(o), 'base64').toString('latin1'));
  return out;
}

interface Finding {
  file: string;
  line: number;
  why: string;
  text: string;
}

interface Detector {
  word: string;
  plain: RegExp;
  reversed: RegExp;
  spaced: RegExp;
}
const DETECTORS: readonly Detector[] = RULES.map(({ word }) => ({
  word,
  plain: new RegExp(escapeRe(word), 'i'),
  reversed: new RegExp(escapeRe([...word].reverse().join('')), 'i'),
  // Every letter separated: "x-y-z", "x y z", "x.y.z" …
  spaced: new RegExp([...word].map(escapeRe).join('[\\s._\\-*/\\\\|+\'"`]{1,3}'), 'i'),
}));

/** Other readings of a text that a disguised spelling would show through. */
interface Views {
  /** 'ab' + 'cd', 'ab', 'cd' (array join) and `ab${''}cd` joined up. */
  joined: string;
  /** Escapes decoded, invisible characters dropped, look-alike letters mapped (null: nothing to decode). */
  decoded: string | null;
  /** Runs of character codes as text. */
  codes: string[];
  /** Base64 tokens, decoded. */
  base64: string[];
}

function views(text: string): Views {
  return {
    joined: text.replace(/['"`]\s*[+,]\s*['"`]/g, '').replace(/\$\{\s*(?:''|""|``)\s*\}/g, ''),
    decoded: /[\\&%]|[^\x00-\x7f]/.test(text) ? decoded(text) : null,
    codes: /\d\s*,/.test(text) ? charCodeRuns(text) : [],
    base64: base64Runs(text),
  };
}

/** Why `text` spells `d.word` in a roundabout way, or null. */
function disguised(d: Detector, text: string, v: Views = views(text)): string | null {
  if (d.plain.test(v.joined)) return 'split string';
  if (d.spaced.test(text)) return 'separated letters';
  if (d.reversed.test(text)) return 'reversed';
  if (v.decoded !== null && d.plain.test(v.decoded)) return 'escapes / look-alike letters';
  if (v.codes.some((s) => d.plain.test(s))) return 'character codes';
  if (v.base64.some((s) => d.plain.test(s))) return 'base64';
  return null;
}

interface Scan {
  files: string[];
  findings: Finding[];
  /** Every lower-case word, and every pair of adjacent words joined, of a product name's length, with a file it is in. */
  words: Map<string, string>;
}

/** Lengths of the names in OTHER_PRODUCTS (shorter / longer words are not hashed). */
const NAME_LENGTH = { min: 4, max: 11 };

function scanLines(file: string, text: string, findings: Finding[]): void {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let r = 0; r < RULES.length; r++) {
      const d = DETECTORS[r];
      if (d.plain.test(line)) {
        if (!RULES[r].allowed.has(file)) findings.push({ file, line: i + 1, why: 'named', text: line });
        else if (!CONSTANT_LINE.test(line.trim())) findings.push({ file, line: i + 1, why: 'permitted module, but not an `export const` value', text: line });
        continue;
      }
      if (file === SELF) continue;
      const why = disguised(d, line);
      if (why !== null) findings.push({ file, line: i + 1, why, text: line });
    }
  }
}

function scan(): Scan {
  const files = repoFiles();
  const findings: Finding[] = [];
  const words = new Map<string, string>();
  for (const file of files) {
    for (const d of DETECTORS) {
      if (d.plain.test(file) || d.spaced.test(file) || d.reversed.test(decoded(file))) {
        findings.push({ file, line: 0, why: 'file name', text: file });
      }
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(ROOT, file));
    } catch {
      continue; // deleted in the working tree, or a submodule / directory
    }
    // UTF-16 text (and any other text with NULs between the letters) is scanned with the NULs removed.
    const raw = buf.toString('utf8');
    const text = buf.includes(0) ? raw.replace(/\0/g, '') : raw;
    // Whole-file checks first; only a file that trips one is gone through line by line.
    const v = file === SELF ? null : views(text);
    const hit = DETECTORS.find((d) => d.plain.test(text) || (v !== null && disguised(d, text, v) !== null));
    if (hit !== undefined) {
      const before = findings.length;
      scanLines(file, text, findings);
      if (findings.length === before && !RULES.some((r) => r.allowed.has(file))) {
        findings.push({ file, line: 0, why: `spread over several lines (${disguised(hit, text) ?? 'named'})`, text: '' });
      }
    }
    if (file === SELF) continue;
    const lw = text.toLowerCase().match(/[a-z]+/g) ?? [];
    for (let k = 0; k < lw.length; k++) {
      const w = lw[k];
      if (w.length >= NAME_LENGTH.min && w.length <= NAME_LENGTH.max && !words.has(w)) words.set(w, file);
      if (k > 0 && lw[k - 1].length + w.length <= NAME_LENGTH.max) {
        const pair = lw[k - 1] + w;
        if (!words.has(pair)) words.set(pair, file);
      }
    }
  }
  return { files, findings, words };
}

const report = (findings: readonly Finding[]): string =>
  findings
    .slice(0, 50)
    .map((f) => `  ${f.file}${f.line > 0 ? `:${f.line}` : ''} (${f.why}): ${f.text.trim().slice(0, 160)}`)
    .join('\n');

describe('brand gate (docs/ARCHITECTURE.md, Naming rule)', () => {
  test('the words come from the permitted modules and still mean what the gate expects', () => {
    assert.equal(OLD_NAME.length, 4);
    assert.equal(LEGACY_BACKUP_EXTENSION, `.${OLD_NAME}bak`);
    assert.ok(LEGACY_BACKUP_MAGIC.toLowerCase().startsWith(OLD_NAME));
    assert.equal(FORMAT_VENDOR.length, 5);
    assert.ok(MESSAGE_TAG.toLowerCase().startsWith(FORMAT_VENDOR));
  });

  test('disguised spellings are recognised (built at run time from the words)', () => {
    const cyrillicA = String.fromCodePoint(0x430);
    for (const d of DETECTORS) {
      const w = d.word;
      const title = w[0].toUpperCase() + w.slice(1);
      const cases: Record<string, string> = {
        'split string': `const x = '${title.slice(0, 2)}' + "${w.slice(2)}";`,
        'array join': `['${w.slice(0, 2)}', '${w.slice(2)}'].join('')`,
        'template': `\`${w.slice(0, 1)}\${''}${w.slice(1)}\``,
        'separated letters': [...title].join('-'),
        'reversed': [...w].reverse().join(''),
        'unicode escapes': [...w].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
        'hex escapes': [...w].map((c) => `\\x${c.charCodeAt(0).toString(16)}`).join(''),
        'html entities': [...w].map((c) => `&#${c.charCodeAt(0)};`).join(''),
        'character codes': `String.fromCharCode(${[...title].map((c) => c.charCodeAt(0)).join(', ')})`,
        'hex character codes': `[${[...w].map((c) => `0x${c.charCodeAt(0).toString(16)}`).join(', ')}]`,
        'base64': `atob('${Buffer.from(title).toString('base64')}')`,
        'base64 in a sentence': `x${Buffer.from(`the ${w.toUpperCase()} name`).toString('base64')}`,
        'look-alike letter': w.replace('a', cyrillicA),
        'zero-width space': `${w.slice(0, 2)}\u200b${w.slice(2)}`,
        'soft hyphen': `${w.slice(0, 3)}\u00ad${w.slice(3)}`,
        'fullwidth': [...w].map((c) => String.fromCodePoint(c.charCodeAt(0) + 0xfee0)).join(''),
      };
      for (const [kind, text] of Object.entries(cases)) {
        assert.equal(d.plain.test(text), false, `${kind}: the case itself must not spell the word`);
        assert.notEqual(disguised(d, text), null, `${kind} not recognised: ${text}`);
      }
      // Ordinary text near the letters is not flagged.
      for (const text of ['not at all, yes', 'a total, by date', 'the bank (A/c) has it', 'b, a, h', 'Tab, Alt, L']) {
        assert.equal(disguised(d, text), null, text);
      }
    }
  });

  test('a permitted module may hold the word only as an `export const` value', () => {
    for (const rule of RULES) {
      const file = [...rule.allowed][0];
      const w = rule.word.toUpperCase();
      const findings: Finding[] = [];
      scanLines(file, `export const NAME_TAG = '${w}';\n/** Read from ${w} files. */\nconst local = '${w}';\n`, findings);
      assert.deepEqual(findings.map((f) => f.line), [2, 3]);
      const other = RULES.find((r) => r !== rule) as Rule;
      const elsewhere: Finding[] = [];
      scanLines(file, `export const X = '${other.word}';\n`, elsewhere);
      assert.equal(elsewhere.length, 1, 'each permitted module is permitted one word only');
    }
  });

  const result = scan();

  test('the scan sees the repository', () => {
    assert.ok(result.files.length > 100, `only ${result.files.length} files found under ${ROOT}`);
    assert.ok(result.files.includes(SELF), 'this test file is not among the scanned files');
    for (const rule of RULES) for (const f of rule.allowed) assert.ok(result.files.includes(f), `${f} is missing`);
  });

  test('no file names, mentions or disguised spellings outside the permitted constants', () => {
    assert.equal(
      result.findings.length,
      0,
      `${result.findings.length} occurrence(s) of a removed product name. Rename or rephrase them ` +
        `(an ordinary word that merely contains one counts too — reword it). Element names of the XML ` +
        `interchange format go in src/core/modules/data/xmlFormat.ts, formats written before the rename in ` +
        `src/core/lib/legacyNames.ts / src/main/legacyUserData.ts:\n${report(result.findings)}`,
    );
  });

  test('no other accounting product is named', () => {
    const hits: Finding[] = [];
    for (const [w, file] of result.words) {
      if (OTHER_PRODUCTS.has(createHash('sha256').update(w).digest('hex').slice(0, 16))) {
        hits.push({ file, line: 0, why: 'another accounting product (word, or two adjacent words joined)', text: w });
      }
    }
    assert.deepEqual(hits, [], `Describe the behaviour instead of naming another product:\n${report(hits)}`);
  });
});
