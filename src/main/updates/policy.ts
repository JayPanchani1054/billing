/**
 * Update policy, URL allowlist and release-notes text for the in-app updater (docs/SECURITY.md "Updates").
 * Pure functions plus one small file reader — no Electron imports, unit-tested in policy.test.ts.
 *
 * Offline-first: the effective mode decides whether the updater may ever touch the network.
 *   off     never (the updater module is not even loaded)
 *   manual  only when the user clicks "Check for updates" (the default)
 *   weekly  also a background check when the last one is at least 7 days old
 *
 * Precedence (first match wins):
 *   1. a test run (PEVQORI_E2E=1 / PEVQORI_SMOKE_TEST=1)  → off
 *   2. an unpackaged app (developer / e2e build)          → off ("only in the installed app")
 *   3. the machine policy file (%ProgramData%\Pevqori\policy.json {"updates":{"mode":…}}); a malformed or
 *      unreadable file fails closed → off
 *   4. the PEVQORI_UPDATES environment variable (off | manual | weekly); an unknown value fails closed → off
 *   5. the user's own choice (shell-preferences.json), default manual
 */
import fs from 'node:fs';
import path from 'node:path';
import type { UpdateMode, UpdatePolicy } from '../../shared/bridge.ts';

export type { UpdateMode, UpdatePolicy } from '../../shared/bridge.ts';

/** The GitHub repository whose Releases feed the updater (electron-builder.yml `publish`). */
export const UPDATE_REPO = { owner: 'JayPanchani1054', repo: 'billing' } as const;

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Largest release-notes text kept (UTF-8 bytes). */
export const MAX_NOTES_BYTES = 20 * 1024;
/** Largest policy file read. */
export const MAX_POLICY_BYTES = 64 * 1024;

export const REASONS = {
  testRun: 'Updates are turned off for this test run.',
  unpackaged: 'Updates are available only in the installed app.',
  policy: 'Managed by your administrator.',
  policyOff: 'Updates are turned off by your administrator.',
  policyBroken: 'Updates are turned off because the update policy file on this computer could not be read. Ask your administrator.',
  env: 'Managed by the PEVQORI_UPDATES setting on this computer.',
  envOff: 'Updates are turned off by the PEVQORI_UPDATES setting on this computer.',
  envBroken: 'Updates are turned off because PEVQORI_UPDATES has an unknown value (use off, manual or weekly).',
} as const;

/** Marker for a policy file that exists but could not be read (permissions, too large, not JSON). */
export const POLICY_UNREADABLE: unique symbol = Symbol('policy-unreadable');

const MODES: readonly UpdateMode[] = ['off', 'manual', 'weekly'];

function isMode(v: unknown): v is UpdateMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

function isUserMode(v: unknown): v is 'manual' | 'weekly' {
  return v === 'manual' || v === 'weekly';
}

/** The machine-wide policy file: %ProgramData%\Pevqori\policy.json on Windows, /etc/pevqori/policy.json elsewhere. */
export function policyFilePath(env: Record<string, string | undefined>, platform: string): string {
  if (platform === 'win32') {
    const raw = env.ProgramData ?? env.PROGRAMDATA ?? env.ALLUSERSPROFILE;
    const base = raw && path.win32.isAbsolute(raw) && !raw.includes('\0') ? raw : 'C:\\ProgramData';
    return path.win32.join(base, 'Pevqori', 'policy.json');
  }
  return '/etc/pevqori/policy.json';
}

/**
 * Read the policy file: `undefined` when it does not exist, POLICY_UNREADABLE when it exists but cannot be
 * read or parsed, otherwise the parsed JSON (validated by resolveUpdatePolicy).
 */
export function readPolicyFile(file: string): unknown {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? undefined : POLICY_UNREADABLE;
  }
  if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) return POLICY_UNREADABLE;
  try {
    // A UTF-8 BOM (Notepad) is tolerated.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return POLICY_UNREADABLE;
  }
}

function policyFromFile(policyFile: unknown): UpdatePolicy | null {
  if (policyFile === undefined) return null;
  const broken: UpdatePolicy = { mode: 'off', locked: true, source: 'policy', reason: REASONS.policyBroken };
  if (policyFile === POLICY_UNREADABLE || policyFile === null || typeof policyFile !== 'object' || Array.isArray(policyFile)) return broken;
  const root = policyFile as Record<string, unknown>;
  // A policy file that says nothing about updates leaves the decision to the next level.
  if (!Object.hasOwn(root, 'updates')) return null;
  const updates = root.updates;
  if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) return broken;
  const mode = (updates as Record<string, unknown>).mode;
  if (!isMode(mode)) return broken;
  return { mode, locked: true, source: 'policy', reason: mode === 'off' ? REASONS.policyOff : REASONS.policy };
}

function policyFromEnv(raw: string | undefined): UpdatePolicy | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = raw.trim().toLowerCase();
  if (!isMode(value)) return { mode: 'off', locked: true, source: 'env', reason: REASONS.envBroken };
  return { mode: value, locked: true, source: 'env', reason: value === 'off' ? REASONS.envOff : REASONS.env };
}

/** The effective policy (see the precedence at the top of this file). Never throws. */
export function resolveUpdatePolicy(input: {
  env: Record<string, string | undefined>;
  policyFile: unknown;
  userPref: unknown;
  packaged: boolean;
}): UpdatePolicy {
  const { env } = input;
  if (env.PEVQORI_E2E === '1' || env.PEVQORI_SMOKE_TEST === '1') {
    return { mode: 'off', locked: true, source: 'env', reason: REASONS.testRun };
  }
  if (!input.packaged) return { mode: 'off', locked: true, source: 'build', reason: REASONS.unpackaged };
  const fromFile = policyFromFile(input.policyFile);
  if (fromFile) return fromFile;
  const fromEnv = policyFromEnv(env.PEVQORI_UPDATES);
  if (fromEnv) return fromEnv;
  return { mode: isUserMode(input.userPref) ? input.userPref : 'manual', locked: false, source: 'user', reason: null };
}

/** Weekly mode: due when there was no check yet, the last one is 7+ days old, or the clock went back a day. */
export function isDue(lastCheckIso: string | null, now: Date, mode: UpdateMode): boolean {
  if (mode !== 'weekly') return false;
  if (!lastCheckIso) return true;
  const last = Date.parse(lastCheckIso);
  if (!Number.isFinite(last)) return true;
  const age = now.getTime() - last;
  return age >= WEEK_MS || age < -24 * 60 * 60 * 1000;
}

// ───────────────────────────── network allowlist ─────────────────────────────

const ASSET_HOSTS = new Set(['objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

/** `prefix` itself, anything below it, or one of the exact `suffixes` (the feed's `releases.atom`). */
function underRepo(pathname: string, prefix: string, suffixes: readonly string[] = []): boolean {
  const p = pathname.toLowerCase();
  const base = prefix.toLowerCase();
  return p === base || p.startsWith(`${base}/`) || suffixes.some((s) => p === `${base}${s}`);
}

/**
 * The only URLs the updater's session may load: https, default port, no credentials, and
 *   github.com/JayPanchani1054/billing/releases…           (feed, latest.yml, installer download)
 *   api.github.com/repos/JayPanchani1054/billing/…
 *   objects.githubusercontent.com, release-assets.githubusercontent.com   (where GitHub redirects downloads)
 * Look-alike hosts (github.com.evil.example, IDN homographs, trailing dots), userinfo tricks and encoded
 * path separators are refused. Every request — redirects included — passes through this check.
 */
export function isAllowedUpdateUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false;
  // Encoded separators could be re-interpreted by a server: never needed by the release URLs.
  if (/%(2f|5c)/i.test(url.pathname)) return false;
  const host = url.hostname;
  if (ASSET_HOSTS.has(host)) return true;
  // electron-updater's GitHub provider reads <repo>/releases.atom, <repo>/releases/latest and
  // <repo>/releases/download/<tag>/<file>; nothing else of the repository (and no sibling repo) is needed.
  if (host === 'github.com') return underRepo(url.pathname, `/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases`, ['.atom']);
  if (host === 'api.github.com') return underRepo(url.pathname, `/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}`);
  return false;
}

/**
 * Request headers the updater session never sends. electron-updater adds `x-user-staging-id` (a random
 * UUID it keeps in <userData>/.updaterId) to every feed and latest.yml request; it would let the server
 * recognise this installation across checks. Staged roll-outs are decided on this computer, so dropping
 * it changes nothing else.
 */
export const STRIPPED_REQUEST_HEADERS: readonly string[] = ['x-user-staging-id'];

/** A copy of `headers` without STRIPPED_REQUEST_HEADERS (names compared case-insensitively). */
export function withoutIdentifyingHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!STRIPPED_REQUEST_HEADERS.includes(name.toLowerCase())) out[name] = value;
  }
  return out;
}

// ───────────────────────────── versions ─────────────────────────────

function parseVersion(v: string): { nums: number[]; pre: string | null } | null {
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** True when `candidate` is a strictly newer semantic version than `current` (a pre-release sorts before its release). */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  if (a.pre === b.pre) return false;
  if (a.pre === null) return true;
  if (b.pre === null) return false;
  return a.pre > b.pre;
}

/** A version string safe to show (semver only), or null. */
export function cleanVersion(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const p = parseVersion(v);
  return p ? v.trim().replace(/^v/, '') : null;
}

// ───────────────────────────── release notes ─────────────────────────────

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  rarr: '→',
  larr: '←',
  times: '×',
  rupee: '₹',
};

function decodeEntities(s: string): string {
  // One pass: "&amp;lt;" becomes "&lt;" (text), never "<".
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// Tag bodies are matched with [^<>]* (not [^>]*): a tag never spans another '<', so every regex below
// runs in linear time even on hostile notes such as '<a<a<a…' (with [^>]* that froze main for ~30 s).
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?(-->|$)/g, '')
      .replace(/<(script|style|template|iframe|object|svg|math)\b[\s\S]*?(<\/\1\s*>|$)/gi, '')
      .replace(/<br\b[^<>]*>/gi, '\n')
      .replace(/<li\b[^<>]*>/gi, '\n• ')
      .replace(/<\/(p|div|ul|ol|h[1-6]|tr|pre|blockquote|section|table)\s*>/gi, '\n')
      .replace(/<(p|h[1-6])\b[^<>]*>/gi, '\n')
      .replace(/<\/?[a-z][^<>]*>/gi, ''),
  );
}

function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const ellipsis = '…';
  let bytes = Buffer.byteLength(ellipsis, 'utf8');
  let out = '';
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    bytes += b;
    out += ch;
  }
  return out.trimEnd() + ellipsis;
}

/**
 * Release notes as plain text: tags stripped (script/style bodies dropped), entities decoded once,
 * control and bidi-override characters removed, whitespace collapsed, at most MAX_NOTES_BYTES. Accepts
 * the feed's HTML string or electron-updater's `[{ version, note }]` list. Shown as a text node only.
 */
export function releaseNotesText(raw: unknown): string {
  let html: string;
  if (typeof raw === 'string') html = raw;
  else if (Array.isArray(raw)) {
    html = raw
      .slice(0, 50)
      .map((n: unknown) => {
        if (n === null || typeof n !== 'object') return '';
        const { version, note } = n as { version?: unknown; note?: unknown };
        const head = typeof version === 'string' ? `<p>${version}</p>` : '';
        return `${head}${typeof note === 'string' ? note : ''}`;
      })
      .join('\n');
  } else return '';
  // Bound the work before any regex runs on hostile input.
  const text = htmlToText(html.slice(0, 512 * 1024))
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncateUtf8(text, MAX_NOTES_BYTES);
}
