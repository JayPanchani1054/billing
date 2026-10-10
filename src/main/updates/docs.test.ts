/**
 * The documents against the in-app updater's code. What docs/SECURITY.md §3.11, docs/INSTALL.md,
 * docs/USER_GUIDE.md and docs/ARCHITECTURE.md promise about updates — the repository and hosts, the
 * timings, the machine policy file and its texts — is what src/main/updates does, and no user-facing
 * document still says that Pevqori never goes online or has no update mechanism (2.0 added the opt-in
 * update check; docs/SCOPE.md said otherwise). A changed constant or a stale sentence fails here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BEFORE_EXIT_MS } from '../quit.ts';
import { isAllowedUpdateUrl, MAX_NOTES_BYTES, policyFilePath, REASONS, resolveUpdatePolicy, UPDATE_REPO, WEEK_MS } from './policy.ts';
import { FIRST_CHECK_DELAY_MS, INSTALL_GRACE_MS, RECHECK_INTERVAL_MS } from './service.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** A document with LF line ends (a Windows checkout gives CRLF). */
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n?/g, '\n');
/** Line breaks and runs of spaces as one space, so a phrase wrapped across lines still matches. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** One `### …` / `## …` section of a markdown text, up to the next heading of the same or a higher level. */
function section(markdown: string, heading: RegExp): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  assert.ok(start >= 0, `section ${heading} not found`);
  const level = /^#+/.exec(lines[start])?.[0].length ?? 2;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

const security = read('docs/SECURITY.md');
const updatesSection = section(security, /^### 3\.11 Updates/);

describe('docs/SECURITY.md §3.11 matches src/main/updates', () => {
  it('names the repository electron-builder.yml publishes to and the updater reads', () => {
    const repo = `${UPDATE_REPO.owner}/${UPDATE_REPO.repo}`;
    assert.ok(updatesSection.includes(`\`${repo}\``), `SECURITY.md §3.11 does not name ${repo}`);
    const builder = read('electron-builder.yml');
    assert.match(builder, new RegExp(`owner: ${UPDATE_REPO.owner}\\b`));
    assert.match(builder, new RegExp(`repo: ${UPDATE_REPO.repo}\\b`));
  });

  it('every host it lists is allowed, and the GitHub hosts it does not list are refused', () => {
    const hosts = [...new Set([...flat(updatesSection).matchAll(/`((?:api\.)?github\.com|[a-z-]+\.githubusercontent\.com)[/`]/g)].map((m) => m[1]))];
    assert.ok(hosts.length >= 4, `only ${hosts.join(', ')} found — has the "Where." paragraph moved?`);
    const sample: Record<string, string> = {
      'github.com': `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest`,
      'api.github.com': `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest`,
    };
    for (const host of hosts) {
      const url = sample[host] ?? `https://${host}/github-production-release-asset/1/x`;
      assert.equal(isAllowedUpdateUrl(url), true, `${host} is listed in SECURITY.md but refused by isAllowedUpdateUrl`);
    }
    for (const host of ['raw.githubusercontent.com', 'codeload.github.com', 'gist.githubusercontent.com', 'uploads.github.com']) {
      assert.equal(hosts.includes(host), false);
      assert.equal(isAllowedUpdateUrl(`https://${host}/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/x`), false, `${host} is allowed but not documented`);
    }
  });

  it('states the timings and limits the code uses', () => {
    const text = flat(updatesSection);
    const phrases = [
      `${FIRST_CHECK_DELAY_MS / 60_000} minutes after start-up`,
      `every ${RECHECK_INTERVAL_MS / 3_600_000} hours`,
      `at least ${WEEK_MS / 86_400_000} days old`,
      `at most ${MAX_NOTES_BYTES / 1024} KB`,
      `up to ${INSTALL_GRACE_MS / 1000} s`,
    ];
    for (const p of phrases) assert.ok(text.includes(p), `SECURITY.md §3.11 should say "${p}"`);
    // The quit sequence (§3.8) caps asynchronous before-exit hooks, which the installer start relies on.
    assert.ok(flat(section(security, /^### 3\.8 /)).includes(`async hooks get at most ${BEFORE_EXIT_MS / 1000} s`));
    assert.ok(INSTALL_GRACE_MS < BEFORE_EXIT_MS, 'the installer grace period must fit in the before-exit cap');
  });

  it('the policy file it documents is the one read, and its example turns updates off', () => {
    assert.equal(policyFilePath({ ProgramData: 'C:\\ProgramData' }, 'win32'), 'C:\\ProgramData\\Pevqori\\policy.json');
    for (const doc of ['docs/SECURITY.md', 'docs/INSTALL.md', 'docs/ARCHITECTURE.md']) {
      assert.ok(read(doc).includes('%ProgramData%\\Pevqori\\policy.json'), `${doc} does not name the policy file`);
    }
    const example = /```json\n([\s\S]*?)```/.exec(updatesSection)?.[1];
    assert.ok(example, 'SECURITY.md §3.11 has no policy.json example');
    const inline = /`(\{ "updates": \{ "mode": "off" \} \})`/.exec(read('docs/INSTALL.md'))?.[1];
    assert.ok(inline, 'INSTALL.md has no policy.json example');
    for (const json of [example, inline]) {
      const p = resolveUpdatePolicy({ env: {}, policyFile: JSON.parse(json) as unknown, userPref: 'weekly', packaged: true });
      assert.deepEqual([p.mode, p.locked, p.source], ['off', true, 'policy']);
    }
    // "The policy file wins over the variable; both win over the user's switch."
    const both = resolveUpdatePolicy({ env: { PEVQORI_UPDATES: 'weekly' }, policyFile: { updates: { mode: 'manual' } }, userPref: 'weekly', packaged: true });
    assert.equal(both.mode, 'manual');
    for (const mode of ['off', 'manual', 'weekly'] as const) {
      const t = flat(updatesSection);
      assert.ok(t.includes(`"${mode}"`) || t.includes(`\`${mode}\``), `SECURITY.md §3.11 does not name the mode ${mode}`);
      assert.equal(resolveUpdatePolicy({ env: { PEVQORI_UPDATES: mode }, policyFile: undefined, userPref: 'weekly', packaged: true }).mode, mode);
    }
  });

  it('the panel texts the documents quote are the ones the policy shows', () => {
    const managed = REASONS.policy.replace(/\.$/, '');
    for (const doc of ['docs/SECURITY.md', 'docs/USER_GUIDE.md']) {
      assert.ok(flat(read(doc)).includes(managed), `${doc} should quote "${managed}"`);
    }
  });
});

describe('no user-facing document denies the update check', () => {
  // 2.0: Pevqori contacts the network only for the update check the user starts (or turns on weekly).
  // A sentence saying it never does, or that there is no update mechanism, is now false.
  const STALE: ReadonlyArray<{ re: RegExp; why: string }> = [
    { re: /makes no network (?:calls|requests)(?! except)/i, why: 'the update check is a network request' },
    { re: /(?:there is )?no automatic update/i, why: 'in-app updates exist (opt-in)' },
    { re: /\|\s*\*\*Automatic updates\*\*/, why: 'the update check is no longer out of scope' },
    { re: /nothing to verify an update against/i, why: 'downloads are checked against the sha512 in latest.yml' },
  ];
  for (const doc of ['README.md', 'docs/INSTALL.md', 'docs/SCOPE.md', 'docs/USER_GUIDE.md', 'docs/SECURITY.md']) {
    it(doc, () => {
      const text = flat(read(doc));
      const hits = STALE.filter((s) => s.re.test(text)).map((s) => `${s.re.exec(text)?.[0]} — ${s.why}`);
      assert.deepEqual(hits, []);
    });
  }
});
