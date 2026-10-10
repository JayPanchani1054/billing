import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  cleanVersion,
  isAllowedUpdateUrl,
  isDue,
  isNewerVersion,
  MAX_NOTES_BYTES,
  POLICY_UNREADABLE,
  policyFilePath,
  readPolicyFile,
  REASONS,
  releaseNotesText,
  resolveUpdatePolicy,
  WEEK_MS,
} from './policy.ts';

const packaged = (over: Partial<Parameters<typeof resolveUpdatePolicy>[0]> = {}) =>
  resolveUpdatePolicy({ env: {}, policyFile: undefined, userPref: undefined, packaged: true, ...over });

describe('resolveUpdatePolicy — precedence and fail-closed parsing', () => {
  it('defaults to manual, owned by the user (offline-first: no automatic checks)', () => {
    assert.deepEqual(packaged(), { mode: 'manual', locked: false, source: 'user', reason: null });
    assert.equal(packaged({ userPref: 'weekly' }).mode, 'weekly');
    for (const junk of ['off', 'WEEKLY', 1, null, {}, ['weekly']]) {
      assert.equal(packaged({ userPref: junk }).mode, 'manual', `user pref ${JSON.stringify(junk)}`);
    }
  });

  it('test runs are always off, before anything else, with the e2e text', () => {
    for (const env of [{ PEVQORI_E2E: '1' }, { PEVQORI_SMOKE_TEST: '1' }]) {
      const p = resolveUpdatePolicy({ env: { ...env, PEVQORI_UPDATES: 'weekly' }, policyFile: { updates: { mode: 'weekly' } }, userPref: 'weekly', packaged: true });
      assert.deepEqual(p, { mode: 'off', locked: true, source: 'env', reason: 'Updates are turned off for this test run.' });
    }
    // Unpackaged e2e runs show the test-run reason, not the unpackaged one.
    assert.equal(resolveUpdatePolicy({ env: { PEVQORI_E2E: '1' }, policyFile: undefined, userPref: undefined, packaged: false }).reason, REASONS.testRun);
    // Only the exact value '1' counts.
    assert.equal(packaged({ env: { PEVQORI_E2E: 'true' } }).mode, 'manual');
  });

  it('an unpackaged app never updates', () => {
    const p = resolveUpdatePolicy({ env: { PEVQORI_UPDATES: 'weekly' }, policyFile: { updates: { mode: 'weekly' } }, userPref: 'weekly', packaged: false });
    assert.deepEqual(p, { mode: 'off', locked: true, source: 'build', reason: 'Updates are available only in the installed app.' });
  });

  it('machine policy file beats the environment and the user', () => {
    for (const mode of ['off', 'manual', 'weekly'] as const) {
      const p = packaged({ env: { PEVQORI_UPDATES: 'weekly' }, policyFile: { updates: { mode } }, userPref: 'weekly' });
      assert.equal(p.mode, mode);
      assert.equal(p.locked, true);
      assert.equal(p.source, 'policy');
    }
    assert.equal(packaged({ policyFile: { updates: { mode: 'off' } } }).reason, REASONS.policyOff);
    assert.equal(packaged({ policyFile: { updates: { mode: 'weekly' } } }).reason, 'Managed by your administrator.');
  });

  it('a malformed or unreadable policy file turns updates off (fail closed)', () => {
    const broken = [POLICY_UNREADABLE, null, 42, 'off', [], { updates: null }, { updates: 'off' }, { updates: [] }, { updates: {} }, { updates: { mode: 'OFF' } }, { updates: { mode: 'daily' } }, { updates: { mode: 1 } }];
    for (const policyFile of broken) {
      const p = packaged({ policyFile, env: { PEVQORI_UPDATES: 'weekly' }, userPref: 'weekly' });
      assert.deepEqual(p, { mode: 'off', locked: true, source: 'policy', reason: REASONS.policyBroken }, `policy ${String(policyFile === POLICY_UNREADABLE ? 'unreadable' : JSON.stringify(policyFile))}`);
    }
  });

  it('a policy file without an updates key leaves the decision to the next level', () => {
    assert.equal(packaged({ policyFile: {}, userPref: 'weekly' }).source, 'user');
    assert.equal(packaged({ policyFile: { other: true }, env: { PEVQORI_UPDATES: 'off' } }).source, 'env');
    // A prototype key is not an own "updates" key.
    assert.equal(packaged({ policyFile: JSON.parse('{"__proto__":{"updates":{"mode":"off"}}}') as unknown }).source, 'user');
  });

  it('PEVQORI_UPDATES: valid values lock the mode; unknown values fail closed; empty is unset', () => {
    assert.deepEqual(packaged({ env: { PEVQORI_UPDATES: 'off' } }), { mode: 'off', locked: true, source: 'env', reason: REASONS.envOff });
    assert.equal(packaged({ env: { PEVQORI_UPDATES: ' Weekly ' } }).mode, 'weekly');
    assert.equal(packaged({ env: { PEVQORI_UPDATES: 'manual' } }).locked, true);
    for (const v of ['0', 'false', 'daily', 'weekly;manual', 'of f']) {
      assert.deepEqual(packaged({ env: { PEVQORI_UPDATES: v }, userPref: 'weekly' }), { mode: 'off', locked: true, source: 'env', reason: REASONS.envBroken }, v);
    }
    assert.equal(packaged({ env: { PEVQORI_UPDATES: '' }, userPref: 'weekly' }).source, 'user');
    assert.equal(packaged({ env: { PEVQORI_UPDATES: '   ' }, userPref: 'weekly' }).mode, 'weekly');
  });
});

describe('policy file', () => {
  it('lives under ProgramData on Windows and /etc elsewhere; relative or odd ProgramData values are ignored', () => {
    assert.equal(policyFilePath({ ProgramData: 'D:\\PD' }, 'win32'), 'D:\\PD\\Pevqori\\policy.json');
    assert.equal(policyFilePath({}, 'win32'), 'C:\\ProgramData\\Pevqori\\policy.json');
    assert.equal(policyFilePath({ ProgramData: 'relative\\dir' }, 'win32'), 'C:\\ProgramData\\Pevqori\\policy.json');
    assert.equal(policyFilePath({}, 'linux'), '/etc/pevqori/policy.json');
  });

  it('reads absent, valid, BOM-prefixed, malformed, oversized and folder paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pevqori-policy-'));
    try {
      const file = path.join(dir, 'policy.json');
      assert.equal(readPolicyFile(file), undefined);
      fs.writeFileSync(file, '{"updates":{"mode":"off"}}');
      assert.deepEqual(readPolicyFile(file), { updates: { mode: 'off' } });
      fs.writeFileSync(file, '\uFEFF{"updates":{"mode":"weekly"}}');
      assert.deepEqual(readPolicyFile(file), { updates: { mode: 'weekly' } });
      fs.writeFileSync(file, '{"updates":');
      assert.equal(readPolicyFile(file), POLICY_UNREADABLE);
      fs.writeFileSync(file, `{"pad":"${'x'.repeat(70_000)}"}`);
      assert.equal(readPolicyFile(file), POLICY_UNREADABLE);
      assert.equal(readPolicyFile(dir), POLICY_UNREADABLE);
      assert.equal(readPolicyFile(path.join(file, 'below-a-file.json')), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isDue', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  it('only weekly mode is ever due', () => {
    assert.equal(isDue(null, now, 'manual'), false);
    assert.equal(isDue(null, now, 'off'), false);
    assert.equal(isDue(null, now, 'weekly'), true);
  });
  it('weekly: 7 days or more since the last check, a broken timestamp, or a clock that went back', () => {
    assert.equal(isDue(new Date(now.getTime() - WEEK_MS + 1000).toISOString(), now, 'weekly'), false);
    assert.equal(isDue(new Date(now.getTime() - WEEK_MS).toISOString(), now, 'weekly'), true);
    assert.equal(isDue('not a date', now, 'weekly'), true);
    assert.equal(isDue(new Date(now.getTime() + 2 * 86_400_000).toISOString(), now, 'weekly'), true);
    assert.equal(isDue(new Date(now.getTime() + 3_600_000).toISOString(), now, 'weekly'), false);
  });
});

describe('isAllowedUpdateUrl', () => {
  it('accepts the release feed, downloads, API and GitHub asset hosts', () => {
    for (const u of [
      'https://github.com/JayPanchani1054/billing/releases.atom',
      'https://github.com/JayPanchani1054/billing/releases/latest',
      'https://github.com/JayPanchani1054/billing/releases/download/v2.1.0/latest.yml',
      'https://github.com/JayPanchani1054/billing/releases/download/v2.1.0/Pevqori-Setup-2.1.0.exe.blockmap',
      'https://github.com/jaypanchani1054/BILLING/releases/latest',
      'https://api.github.com/repos/JayPanchani1054/billing/releases/latest',
      'https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2?X-Amz-Signature=abc',
      'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r&sig=x',
      'https://GitHub.com/JayPanchani1054/billing/releases.atom',
      'https://github.com:443/JayPanchani1054/billing/releases.atom',
    ]) {
      assert.equal(isAllowedUpdateUrl(u), true, u);
    }
  });

  it('refuses http, other hosts, look-alikes, userinfo, ports, IDN, other repos and path tricks', () => {
    for (const u of [
      'http://github.com/JayPanchani1054/billing/releases.atom',
      'https://github.com.evil.example/JayPanchani1054/billing/releases.atom',
      'https://evilgithub.com/JayPanchani1054/billing/releases.atom',
      'https://github.com./JayPanchani1054/billing/releases.atom',
      'https://gіthub.com/JayPanchani1054/billing/releases.atom', // Cyrillic і
      'https://xn--gthub-n4a.com/JayPanchani1054/billing/releases.atom',
      'https://user@github.com/JayPanchani1054/billing/releases.atom',
      'https://github.com@evil.example/JayPanchani1054/billing/releases.atom',
      'https://user:pw@objects.githubusercontent.com/x',
      'https://github.com:8443/JayPanchani1054/billing/releases.atom',
      'https://objects.githubusercontent.com:444/x',
      'https://github.com/JayPanchani1054/billing',
      'https://github.com/JayPanchani1054/billing/issues',
      'https://github.com/JayPanchani1054/billing-evil/releases/latest',
      // A sibling repository of the same owner, or a made-up suffix after releases, is not the feed.
      'https://api.github.com/repos/JayPanchani1054/billing.evil/releases/latest',
      'https://github.com/JayPanchani1054/billing/releases.evil',
      'https://github.com/JayPanchani1054/billing/releases.atom.exe',
      'https://github.com/Other/billing/releases/latest',
      'https://github.com/JayPanchani1054/billing/releases/../../../Other/repo/releases',
      'https://github.com/JayPanchani1054/billing/releases%2F..%2F..%2Fother',
      'https://github.com/JayPanchani1054/billing/releases/x%5c..',
      'https://github.com\\@evil.example/JayPanchani1054/billing/releases',
      'https://api.github.com/repos/Other/billing/releases',
      'https://api.github.com/user',
      'https://raw.githubusercontent.com/JayPanchani1054/billing/main/x',
      'https://githubusercontent.com/x',
      'https://evil.objects.githubusercontent.com/x',
      'ftp://github.com/JayPanchani1054/billing/releases',
      'file:///C:/Windows/notepad.exe',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      assert.equal(isAllowedUpdateUrl(u), false, u);
    }
    assert.equal(isAllowedUpdateUrl(`https://objects.githubusercontent.com/${'a'.repeat(9000)}`), false);
    assert.equal(isAllowedUpdateUrl(42 as unknown as string), false);
  });
});

describe('versions', () => {
  it('compares semantic versions; pre-releases sort before their release', () => {
    assert.equal(isNewerVersion('2.1.0', '2.0.0'), true);
    assert.equal(isNewerVersion('2.0.10', '2.0.9'), true);
    assert.equal(isNewerVersion('2.0.0', '2.0.0'), false);
    assert.equal(isNewerVersion('1.9.9', '2.0.0'), false);
    assert.equal(isNewerVersion('2.0.0', '2.0.0-beta.1'), true);
    assert.equal(isNewerVersion('2.0.0-beta.1', '2.0.0'), false);
    assert.equal(isNewerVersion('v2.1.0', '2.0.0'), true);
    assert.equal(isNewerVersion('garbage', '2.0.0'), false);
  });
  it('cleanVersion keeps only semver text', () => {
    assert.equal(cleanVersion('v2.1.0'), '2.1.0');
    assert.equal(cleanVersion('2.1.0<script>'), null);
    assert.equal(cleanVersion(2), null);
  });
});

describe('releaseNotesText', () => {
  it('strips tags, drops script/style bodies, keeps list structure as text', () => {
    const t = releaseNotesText('<h2>What&#39;s new</h2><ul><li>Faster <b>GSTR-1</b></li><li>Fix &amp; polish</li></ul><script>alert(1)</script><style>p{}</style><p>Done</p>');
    assert.equal(t, "What's new\n\n• Faster GSTR-1\n• Fix & polish\n\nDone");
  });

  it('decodes entities exactly once (encoded markup stays text) and rejects invalid code points', () => {
    assert.equal(releaseNotesText('&lt;img src=x onerror=alert(1)&gt;'), '<img src=x onerror=alert(1)>');
    assert.equal(releaseNotesText('&amp;lt;b&amp;gt;'), '&lt;b&gt;');
    assert.equal(releaseNotesText('a&#0;b&#xD800;c&#x110000;d&unknown;'), 'abcd&unknown;');
    assert.equal(releaseNotesText('&#8377; 100 &rupee;'), '₹ 100 ₹');
  });

  it('removes control and bidi-override characters and collapses whitespace', () => {
    assert.equal(releaseNotesText('a\u0000b\u202Ec\r\n\r\n\r\n\r\nd   \t e'), 'abc\n\nd e');
  });

  it('accepts the [{version, note}] list form and ignores junk', () => {
    assert.equal(releaseNotesText([{ version: '2.1.0', note: '<p>New</p>' }, null, { note: 'x' }]), '2.1.0\n\nNew\n\nx');
    assert.equal(releaseNotesText(null), '');
    assert.equal(releaseNotesText({ note: 'x' }), '');
  });

  it('is at most 20 KB of UTF-8, ending with an ellipsis when cut', () => {
    const t = releaseNotesText(`<p>${'₹'.repeat(30_000)}</p>`);
    assert.ok(Buffer.byteLength(t, 'utf8') <= MAX_NOTES_BYTES);
    assert.ok(t.endsWith('…'));
    const unclosed = releaseNotesText(`<p>ok</p><script>${'x'.repeat(1_000_000)}`);
    assert.equal(unclosed, 'ok');
  });

  it('runs in linear time on hostile markup (unterminated tags never freeze the main process)', () => {
    // With a [^>]* tag body each of these took ~25-30 s on the main thread (quadratic backtracking).
    for (const hostile of ['<a'.repeat(100_000), '<li'.repeat(60_000), '<p '.repeat(60_000), '<br'.repeat(60_000), '<!--'.repeat(60_000)]) {
      const started = performance.now();
      const text = releaseNotesText(hostile);
      assert.ok(performance.now() - started < 1_000, `${hostile.slice(0, 4)}… took too long`);
      assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_NOTES_BYTES);
    }
    // A stray '<' never swallows the text that follows it.
    assert.equal(releaseNotesText('1 < 2 and <b>bold</b>'), '1 < 2 and bold');
  });
});
