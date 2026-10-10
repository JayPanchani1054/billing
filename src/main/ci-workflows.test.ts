// Regression tests for the CI/release supply-chain rules (docs/BUILD.md §5–§7, docs/SECURITY.md):
// pinned actions, no persisted tokens, signing secrets confined to the packaging step, write access
// only where something is pushed or published. Text-level checks: no YAML parser in node:*.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowDir = path.join(root, '.github/workflows');
const read = (name: string): string => fs.readFileSync(path.join(workflowDir, name), 'utf8').replace(/\r\n/g, '\n');
const WORKFLOWS = fs.readdirSync(workflowDir).filter((f) => f.endsWith('.yml'));

/** Split a workflow into its jobs (two-space indented keys under `jobs:`). */
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const out = new Map<string, string>();
  const parts = body.split(/\n(?= {2}[A-Za-z0-9_-]+:\n)/);
  for (const part of parts) {
    const m = /^ {2}([A-Za-z0-9_-]+):\n/.exec(part);
    if (m) out.set(m[1], part);
  }
  return out;
}

/** Split a job into its steps (`      - ` items). */
function steps(job: string): string[] {
  return job.split(/\n(?= {6}- )/).slice(1);
}

describe('GitHub workflows', () => {
  it('pin every third-party action to a full commit SHA with a version comment', () => {
    for (const file of WORKFLOWS) {
      for (const line of read(file).split('\n')) {
        const m = /^\s*(?:- )?uses:\s*(\S+)(.*)$/.exec(line);
        if (!m || m[1].startsWith('./')) continue;
        assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}: ${line.trim()} is not SHA-pinned`);
        assert.match(m[2], /#\s*v\d/, `${file}: ${line.trim()} has no version comment`);
      }
    }
  });

  it('do not persist the job token in .git/config, except where the job pushes a commit', () => {
    for (const file of WORKFLOWS) {
      for (const [name, job] of jobs(read(file))) {
        for (const step of steps(job)) {
          if (!/uses:\s*actions\/checkout@/.test(step)) continue;
          if (file === 'lockfile.yml') continue; // pushes package-lock.json; runs no package code (--ignore-scripts)
          assert.match(step, /persist-credentials:\s*false/, `${file} › ${name}: checkout must set persist-credentials: false`);
        }
      }
    }
  });

  it('default to a read-only token; only the release publisher and the lockfile updater may write', () => {
    for (const file of WORKFLOWS) {
      const text = read(file);
      assert.match(text, /^permissions:\n {2}contents: read$/m, `${file}: workflow-level permissions must be contents: read`);
      for (const [name, job] of jobs(text)) {
        const writes = /contents:\s*write/.test(job);
        const allowed = (file === 'release.yml' && name === 'publish') || (file === 'lockfile.yml' && name === 'lockfile');
        assert.equal(writes, allowed, `${file} › ${name}: contents: write ${writes ? 'not allowed' : 'expected'}`);
      }
    }
  });

  it('release: the signing secrets reach only the packaging step, never npm install, tests or $GITHUB_ENV', () => {
    const release = read('release.yml');
    assert.doesNotMatch(release, /GITHUB_ENV/);
    const build = jobs(release).get('build');
    assert.ok(build, 'release.yml has a build job');
    const withSecrets = steps(build).filter((s) => /\$\{\{\s*secrets\./.test(s));
    assert.equal(withSecrets.length, 1, 'exactly one step sees secrets');
    assert.match(withSecrets[0], /electron-builder/);
    assert.match(withSecrets[0], /npx --no --/, 'the signing step runs the already-installed electron-builder only');
    assert.doesNotMatch(withSecrets[0], /npm (ci|install)/);
    // The job-level env carries no secrets either.
    const jobHeader = build.slice(0, build.indexOf('\n    steps:'));
    assert.doesNotMatch(jobHeader, /secrets\./);
    // The publisher runs no repository code: no checkout, no npm.
    const publish = jobs(release).get('publish') ?? '';
    assert.doesNotMatch(publish, /actions\/checkout@|npm |npx /);
  });

  it('release: dependency install scripts never run unreviewed (npm ci --ignore-scripts + reviewed list)', async () => {
    const build = jobs(read('release.yml')).get('build') ?? '';
    const install = steps(build).find((s) => /npm ci/.test(s)) ?? '';
    assert.match(install, /npm ci --ignore-scripts/);
    assert.match(install, /node scripts\/install-scripts\.mjs --check/);
    assert.match(install, /node scripts\/install-scripts\.mjs --run/);
    assert.ok(install.indexOf('--check') < install.indexOf('npm ci') && install.indexOf('npm ci') < install.indexOf('--run'));
    const { unreviewedInstallScripts, REVIEWED_INSTALL_SCRIPTS } = (await import(pathToFileURL(path.join(root, 'scripts/install-scripts.mjs')).href)) as {
      unreviewedInstallScripts(lock: unknown): string[];
      REVIEWED_INSTALL_SCRIPTS: Record<string, { action: string }>;
    };
    // The committed lockfile has no unreviewed install script; a new one is reported.
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
    assert.deepEqual(unreviewedInstallScripts(lock), []);
    assert.deepEqual(unreviewedInstallScripts({ packages: { ...lock.packages, 'node_modules/evil': { version: '1.0.0', hasInstallScript: true } } }), ['node_modules/evil']);
    assert.equal(REVIEWED_INSTALL_SCRIPTS['node_modules/esbuild']?.action, 'run');
  });

  it('no ${{ … }} expression is pasted into a run: script (a tag or branch name is attacker-chosen text; pass it through env)', () => {
    for (const file of WORKFLOWS) {
      for (const [name, job] of jobs(read(file))) {
        for (const step of steps(job)) {
          const at = step.search(/^ {8}run:/m);
          if (at < 0) continue;
          const rest = step.slice(at);
          const next = rest.slice(1).search(/^ {8}[A-Za-z_-]+:/m);
          const script = next < 0 ? rest : rest.slice(0, next + 1);
          assert.doesNotMatch(script, /\$\{\{/, `${file} › ${name}: ${/- name: (.+)/.exec(step)?.[1] ?? 'a step'} interpolates an expression into its script`);
        }
      }
    }
  });

  it('release: builds from the lockfile alone — no dependency or build cache another run could have written', () => {
    const release = read('release.yml');
    assert.doesNotMatch(release, /actions\/cache@/);
    assert.doesNotMatch(release, /^\s+cache:/m, 'setup-node must not restore the npm cache in a release');
  });

  it('lockfile updater: never re-triggers itself and leaves Dependabot branches alone (read-only token there)', () => {
    const job = jobs(read('lockfile.yml')).get('lockfile') ?? '';
    assert.match(job, /^ {4}if: .*github\.actor != 'github-actions\[bot\]'.*$/m);
    assert.match(job, /^ {4}if: .*github\.actor != 'dependabot\[bot\]'.*$/m);
    assert.match(job, /npm install --package-lock-only --ignore-scripts/, 'no package code runs while the job holds a write token');
  });

  it('CI runs the unit tests on Windows and smoke-tests the installed packaged app', () => {
    const ci = read('ci.yml');
    const all = jobs(ci);
    assert.match(all.get('windows-installer') ?? '', /runs-on: windows-latest[\s\S]*run: npm test/);
    assert.match(all.get('windows-installer') ?? '', /run: npm run check:fuses/);
    assert.match(all.get('windows-smoke') ?? '', /smoke-installed\.ps1/);
    assert.match(all.get('e2e') ?? '', /windows-latest/);
    assert.match(all.get('e2e') ?? '', /test-results\//, 'traces and screenshots are uploaded on failure');
    assert.match(read('release.yml'), /smoke-installed\.ps1/);
  });
});

// ───────────────────────────── 2.0: in-place upgrades, update feed, release pipeline ─────────────────────────────

const readRoot = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

interface ReleaseAssets {
  PUBLISH: { provider: string; owner: string; repo: string };
  installerName(version: string): string;
  changelogSection(text: string, version: string): string | null;
  parseLatestYml(text: string): { version: string | null; path: string | null; sha512: string | null; files: { url: string; sha512: string | null; size: number | null }[] };
  checkReleaseFiles(version: string, read: (rel: string) => Buffer | null): string[];
}
const loadReleaseAssets = async (): Promise<ReleaseAssets> =>
  (await import(pathToFileURL(path.join(root, 'scripts/release-assets.mjs')).href)) as ReleaseAssets;

/** A top-level YAML block (`key:` … up to the next top-level key). */
function yamlBlock(text: string, key: string): string {
  const m = new RegExp(`^${key}:.*\\n((?:(?:[ \\t].*)?\\n)*)`, 'm').exec(text);
  return m ? m[0] : '';
}

describe('electron-builder.yml (installer, upgrades in place, update feed)', () => {
  const yml = readRoot('electron-builder.yml');

  it('keeps the identity that the uninstall key and folders derive from', () => {
    assert.match(yml, /^appId: com\.pevqori\.app$/m);
    assert.match(yml, /^productName: Pevqori$/m);
    assert.match(yml, /^ {2}artifactName: Pevqori-Setup-\$\{version\}\.\$\{ext\}$/m);
  });

  it('publishes to this repository’s GitHub Releases (release type), matching the updater’s allowlist', async () => {
    const publish = yamlBlock(yml, 'publish');
    assert.match(publish, /^ {2}- provider: github$/m);
    assert.match(publish, /^ {4}owner: JayPanchani1054$/m);
    assert.match(publish, /^ {4}repo: billing$/m);
    assert.match(publish, /^ {4}releaseType: release$/m);
    assert.doesNotMatch(yml, /^publish:\s*null/m);
    const { PUBLISH } = await loadReleaseAssets();
    const { UPDATE_REPO } = await import('./updates/policy.ts');
    assert.deepEqual({ owner: PUBLISH.owner, repo: PUBLISH.repo }, { ...UPDATE_REPO });
    assert.match(publish, new RegExp(`owner: ${PUBLISH.owner}\\n {4}repo: ${PUBLISH.repo}\\n`));
  });

  it('lets electron-updater verify the code signature (no verifyUpdateCodeSignature: false)', () => {
    assert.doesNotMatch(yml, /^\s*verifyUpdateCodeSignature:/m);
  });

  it('installs per user by default, per machine on request, and keeps data and settings on uninstall', () => {
    const nsis = yamlBlock(yml, 'nsis');
    assert.match(nsis, /^ {2}oneClick: false$/m);
    assert.match(nsis, /^ {2}perMachine: false$/m);
    assert.match(nsis, /^ {2}selectPerMachineByDefault: false$/m);
    assert.match(nsis, /^ {2}allowElevation: true$/m);
    assert.match(nsis, /^ {2}deleteAppDataOnUninstall: false$/m);
    assert.match(nsis, /^ {2}include: build\/installer\.nsh$/m);
  });

  it('brands the installer with the generated sidebar and header bitmaps', () => {
    const nsis = yamlBlock(yml, 'nsis');
    for (const [key, file] of [
      ['installerSidebar', 'build/installerSidebar.bmp'],
      ['uninstallerSidebar', 'build/installerSidebar.bmp'],
      ['installerHeader', 'build/installerHeader.bmp'],
    ]) {
      assert.match(nsis, new RegExp(`^ {2}${key}: ${file.replace(/[./]/g, '\\$&')}$`, 'm'));
      assert.ok(fs.existsSync(path.join(root, file)), `${file} exists (node scripts/make-icon.mjs)`);
    }
  });

  it('every electron-builder run uses --publish never (CI and release builds are never published by it)', () => {
    const pkg = JSON.parse(readRoot('package.json')) as { scripts: Record<string, string> };
    const runs: string[] = [];
    for (const [name, cmd] of Object.entries(pkg.scripts)) if (/electron-builder/.test(cmd)) runs.push(`package.json ${name}: ${cmd}`);
    for (const file of WORKFLOWS) for (const line of read(file).split('\n')) if (/\belectron-builder\s+--/.test(line)) runs.push(`${file}: ${line.trim()}`);
    assert.ok(runs.length >= 3, runs.join('\n'));
    for (const r of runs) assert.match(r, /--publish never/, r);
    // CI packages through npm run dist:win (which carries the flag).
    assert.match(jobs(read('ci.yml')).get('windows-installer') ?? '', /run: npm run dist:win/);
  });
});

describe('build/installer.nsh (running app, downgrade guard)', () => {
  const nsh = readRoot('build/installer.nsh');

  it('never force-closes Pevqori; replaces electron-builder’s check and also checks in .onInit', () => {
    assert.doesNotMatch(nsh, /taskkill|KillProcess|TerminateProcess/i);
    assert.match(nsh, /^!macro customCheckAppRunning$/m);
    const init = /^!macro customInit\n([\s\S]*?)^!macroend$/m.exec(nsh)?.[1] ?? '';
    assert.match(init, /!insertmacro _pevqoriDowngradeGuard/);
    assert.match(init, /!insertmacro _pevqoriWaitForApp/);
    assert.match(nsh, /"Pevqori is open\. Save your work and close it, then click Retry\."/);
    assert.match(nsh, /MB_RETRYCANCEL/);
  });

  it('silent install while Pevqori runs: waits 30 s, then exit code 3', () => {
    const wait = /^!macro _pevqoriWaitForApp\n([\s\S]*?)^!macroend$/m.exec(nsh)?.[1] ?? '';
    assert.match(wait, /\$\{If\} \$\{Silent\}/);
    assert.match(wait, /\$R1 >= 30/);
    assert.match(wait, /Sleep 1000/);
    assert.match(wait, /SetErrorLevel 3\n\s*Quit/);
  });

  it('downgrade: reads DisplayVersion (HKCU, then HKLM), compares without the pre-release suffix, exit code 4 unless /ALLOWDOWNGRADE', () => {
    const guard = /^!macro _pevqoriDowngradeGuard\n([\s\S]*?)^!macroend$/m.exec(nsh)?.[1] ?? '';
    assert.ok(guard.indexOf('ReadRegStr $R0 HKCU') < guard.indexOf('ReadRegStr $R0 HKLM'));
    assert.match(guard, /"DisplayVersion"/);
    assert.match(guard, /\$\{GetOptions\} \$R1 "\/ALLOWDOWNGRADE"/);
    assert.match(guard, /_pevqoriStripPre \$R0 \$R2[\s\S]*_pevqoriStripPre "\$\{VERSION\}" \$R3[\s\S]*\$\{VersionCompare\} \$R2 \$R3 \$R1/);
    assert.match(guard, /MB_YESNO\|MB_ICONEXCLAMATION "A newer Pevqori \(\$R0\) is installed\. Installing \$\{VERSION\} is not supported/);
    assert.match(guard, /\/SD IDNO IDYES/);
    assert.match(guard, /SetErrorLevel 4\n\s*Quit/);
    assert.match(nsh, /!include "WordFunc\.nsh"/);
  });

  it('the decisions themselves: process scope, Retry/Cancel loop, refusal only for a newer version, /ALLOWDOWNGRADE bypass', () => {
    const body = (name: string): string => new RegExp(`^!macro ${name}(?: [^\\n]*)?\\n([\\s\\S]*?)^!macroend$`, 'm').exec(nsh)?.[1] ?? '';
    // electron-builder 26 runs customCheckAppRunning INSTEAD of its own (force-closing) check, in the
    // installer and the uninstaller: it must be the wait-or-ask logic, not empty.
    assert.match(body('customCheckAppRunning'), /^\s*!insertmacro _pevqoriWaitForApp\s*$/);
    // Per-machine installation ($installMode "all"): a copy open under any account counts; per-user: this account's only.
    const running = body('_pevqoriAppRunning');
    assert.match(
      running,
      /\$\{If\} \$installMode == "all"\n\s*nsExec::Exec `"\$SYSDIR\\cmd\.exe" \/c tasklist \/FI "IMAGENAME eq \$\{APP_EXECUTABLE_FILENAME\}" \/NH \| "\$SYSDIR\\find\.exe" \/I "\$\{APP_EXECUTABLE_FILENAME\}"`\n\s*\$\{Else\}\n\s*nsExec::Exec `"\$SYSDIR\\cmd\.exe" \/c tasklist \/FI "USERNAME eq %USERNAME%" \/FI "IMAGENAME eq \$\{APP_EXECUTABLE_FILENAME\}" \/NH \| "\$SYSDIR\\find\.exe" \/I "\$\{APP_EXECUTABLE_FILENAME\}"`\n\s*\$\{EndIf\}\n\s*Pop \$\{_RESULT\}/,
    );
    const wait = body('_pevqoriWaitForApp');
    assert.match(wait, /!insertmacro _pevqoriAppRunning \$R0\n\s*\$\{If\} \$R0 == 0\n\s*\$\{If\} \$\{Silent\}/, 'acts only when Pevqori runs');
    // Silent: re-check every second; after 30 s exit code 3.
    assert.match(wait, /\$\{DoWhile\} \$R0 == 0\n\s*\$\{If\} \$R1 >= 30\n[\s\S]*?SetErrorLevel 3\n\s*Quit\n\s*\$\{EndIf\}\n\s*Sleep 1000\n\s*IntOp \$R1 \$R1 \+ 1\n\s*!insertmacro _pevqoriAppRunning \$R0\n\s*\$\{Loop\}/);
    // Interactive: Cancel → exit code 3, Retry → check again (the loop ends once Pevqori is closed).
    assert.match(
      wait,
      /\$\{DoWhile\} \$R0 == 0\n\s*\$\{If\} \$\{Cmd\} `MessageBox MB_RETRYCANCEL\|MB_ICONEXCLAMATION "[^"`]+" \/SD IDCANCEL IDCANCEL`\n\s*SetErrorLevel 3\n\s*Quit\n\s*\$\{EndIf\}\n\s*!insertmacro _pevqoriAppRunning \$R0\n\s*\$\{Loop\}/,
    );
    const guard = body('_pevqoriDowngradeGuard');
    assert.match(guard, /\$\{GetOptions\} \$R1 "\/ALLOWDOWNGRADE" \$R2\n\s*\$\{If\} \$\{Errors\}/, 'the guard runs only when /ALLOWDOWNGRADE is absent');
    assert.match(guard, /\$\{VersionCompare\} \$R2 \$R3 \$R1\n\s*\$\{If\} \$R1 == 1\n/, 'refused only when the installed version is newer (1 = the first is newer)');
    assert.match(guard, /\$\{If\} \$R0 != ""/, 'no installed version → nothing to compare');
    const strip = body('_pevqoriStripPre');
    assert.match(strip, /\$R8 == ""\n\s*\$\{OrIf\} \$R8 == "-"\n\s*\$\{OrIf\} \$R8 == "\+"\n\s*\$\{Break\}/);
    // The elevated inner instance of an "Anyone who uses this computer" install does not ask again.
    assert.match(body('customInit'), /\$\{IfNot\} \$\{UAC_IsInnerInstance\}[\s\S]*_pevqoriDowngradeGuard[\s\S]*_pevqoriWaitForApp[\s\S]*\$\{EndIf\}/);
  });

  it('two installations side by side (per-user + per-machine): the NEWER installed version counts, not just the per-user one', () => {
    // A per-user 1.0 next to a per-machine 3.0: installing 2.0 (per-user, the default when both exist) must
    // still be refused — a company the per-machine 3.0 opened cannot be opened by 2.0. HKLM used to be read
    // only when HKCU had no entry, so the newer per-machine installation was never seen.
    const guard = new RegExp(`^!macro _pevqoriDowngradeGuard\\n([\\s\\S]*?)^!macroend$`, 'm').exec(nsh)?.[1] ?? '';
    const reads = /ReadRegStr \$R0 HKCU ("[^"\n]+") "DisplayVersion"\n\s*StrCpy \$R1 \$R0\n\s*ReadRegStr \$R0 HKLM \1 "DisplayVersion"\n/g;
    assert.equal([...guard.matchAll(reads)].length, 2, 'both keys are always read (with and without UNINSTALL_REGISTRY_KEY), HKCU kept in $R1');
    assert.doesNotMatch(guard, /\$\{If\} \$R0 == ""\n\s*ReadRegStr \$R0 HKLM/, 'HKLM is not read only as a fallback');
    assert.match(
      guard,
      /\$\{If\} \$R0 == ""\n\s*StrCpy \$R0 \$R1\n\s*\$\{ElseIf\} \$R1 != ""\n\s*!insertmacro _pevqoriStripPre \$R1 \$R2\n\s*!insertmacro _pevqoriStripPre \$R0 \$R3\n\s*\$\{VersionCompare\} \$R2 \$R3 \$R2\n\s*\$\{If\} \$R2 == 1\n\s*StrCpy \$R0 \$R1\n\s*\$\{EndIf\}\n\s*\$\{EndIf\}\n/,
      'the newer of the two (pre-release suffix dropped) is the installed version compared with ${VERSION}',
    );
    // …and that choice is made before the comparison with the version being installed.
    assert.ok(guard.indexOf('StrCpy $R0 $R1') < guard.indexOf('${If} $R0 != ""'));
  });

  it('stays warning-free: no Var or Function declarations (unused in one of electron-builder’s two passes)', () => {
    assert.doesNotMatch(nsh, /^\s*(Var|Function)\b/m);
    // The uninstall log note is kept.
    assert.match(nsh, /^!macro customUnInstall$/m);
  });
});

describe('release pipeline (latest.yml, blockmap, notes, upgrade smoke)', () => {
  const release = read('release.yml');
  const build = jobs(release).get('build') ?? '';
  const smoke = jobs(release).get('smoke') ?? '';
  const publish = jobs(release).get('publish') ?? '';

  it('build: tag == package.json version, CHANGELOG section checked early, update files checked against the tag', () => {
    const names = steps(build).map((s) => /- name: (.+)/.exec(s)?.[1] ?? '');
    const at = (re: RegExp): number => names.findIndex((n) => re.test(n));
    assert.ok(at(/Check tag matches package\.json version/) >= 0);
    assert.ok(at(/CHANGELOG\.md has this version/) >= 0 && at(/CHANGELOG\.md has this version/) < at(/^Build/), 'notes are checked before the build');
    const check = steps(build).find((s) => /release-assets\.mjs check/.test(s)) ?? '';
    assert.match(check, /node scripts\/release-assets\.mjs check release "\$\{GITHUB_REF_NAME#v\}"/);
    assert.ok(at(/Check the update files/) > at(/^Package/), 'checked after packaging');
    assert.match(build, /node scripts\/release-assets\.mjs notes "\$\{GITHUB_REF_NAME#v\}" CHANGELOG\.md release\/release-notes\.md/);
  });

  it('build: checksums and uploads the installer, blockmap and latest.yml (plus the notes)', () => {
    const sums = steps(build).find((s) => /SHA256SUMS\.txt/.test(s) && /sha256sum/.test(s)) ?? '';
    assert.match(sums, /sha256sum Pevqori-Setup-\*\.exe Pevqori-Setup-\*\.exe\.blockmap latest\.yml \| tee SHA256SUMS\.txt/);
    const upload = steps(build).find((s) => /actions\/upload-artifact@/.test(s)) ?? '';
    for (const f of ['release/Pevqori-Setup-*.exe', 'release/Pevqori-Setup-*.exe.blockmap', 'release/latest.yml', 'release/SHA256SUMS.txt', 'release/release-notes.md']) {
      assert.ok(upload.includes(`            ${f}\n`), `uploads ${f}`);
    }
    assert.match(upload, /if-no-files-found: error/);
  });

  it('publish: one release step attaches exe + blockmap + latest.yml + SHA256SUMS.txt with the CHANGELOG body', () => {
    const releaseSteps = steps(publish).filter((s) => /softprops\/action-gh-release@/.test(s));
    assert.equal(releaseSteps.length, 1);
    const step = releaseSteps[0];
    assert.match(step, /body_path: release\/release-notes\.md/);
    assert.match(step, /fail_on_unmatched_files: true/);
    assert.doesNotMatch(step, /generate_release_notes/);
    for (const f of ['release/Pevqori-Setup-*.exe', 'release/Pevqori-Setup-*.exe.blockmap', 'release/latest.yml', 'release/SHA256SUMS.txt']) {
      assert.ok(step.includes(`            ${f}\n`) || step.endsWith(`            ${f}`), `attaches ${f}`);
    }
    assert.match(publish, /sha256sum --check SHA256SUMS\.txt/);
    assert.match(publish, /grep -qx "version: \$\{GITHUB_REF_NAME#v\}" latest\.yml/);
    assert.doesNotMatch(publish, /actions\/checkout@|npm |npx /);
  });

  it('smoke: fresh install, then the upgrade over the previous release (read-only token, skipped with a notice when none)', () => {
    assert.match(smoke, /permissions:\n {6}contents: read/);
    const download = steps(smoke).find((s) => /gh release download/.test(s)) ?? '';
    assert.match(download, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.doesNotMatch(download, /secrets\./);
    assert.match(download, /--pattern 'Pevqori-Setup-\*\.exe'/);
    assert.match(download, /::notice::/);
    assert.match(download, /exit 0/);
    const upgrade = steps(smoke).find((s) => /-Previous/.test(s)) ?? '';
    assert.match(upgrade, /if: hashFiles\('previous\/Pevqori-Setup-\*\.exe'\) != ''/);
    assert.match(upgrade, /smoke-installed\.ps1 -Installer .* -Previous /);
  });

  it('CI: checks the update files after packaging and smoke-tests the running-app and downgrade variants', () => {
    const ci = read('ci.yml');
    const installer = jobs(ci).get('windows-installer') ?? '';
    assert.match(installer, /node scripts\/release-assets\.mjs check release/);
    const winSmoke = jobs(ci).get('windows-smoke') ?? '';
    assert.match(winSmoke, /smoke-installed\.ps1 -Installer/);
    assert.match(winSmoke, /smoke-installed\.ps1 -Scenario RunningApp /);
    assert.match(winSmoke, /smoke-installed\.ps1 -Scenario Downgrade /);
    assert.doesNotMatch(ci, /contents:\s*write/);
  });
});

describe('scripts/smoke-installed.ps1 (installer scenarios)', () => {
  const ps1 = readRoot('scripts/smoke-installed.ps1');

  it('offers the install, upgrade, running-app and downgrade scenarios with the installer’s exit codes', () => {
    assert.match(ps1, /\[ValidateSet\('Install', 'Upgrade', 'RunningApp', 'Downgrade'\)\]\[string\]\$Scenario = 'Install'/);
    assert.match(ps1, /\[string\]\$Previous = ''/);
    assert.match(ps1, /\$ExitAppRunning = 3/);
    assert.match(ps1, /\$ExitDowngrade = 4/);
    assert.match(ps1, /\/ALLOWDOWNGRADE/);
  });

  it('upgrade: no folder given to the new installer; same entry, folder and data; version N; older release refused', () => {
    const upgrade = /'Upgrade' \{\n([\s\S]*?)\n {4}\}\n\n {4}'RunningApp'/.exec(ps1)?.[1] ?? '';
    assert.match(upgrade, /Invoke-Installer \$installerPath @\('\/S', '\/currentuser'\)\)/, 'N is installed without /D=');
    assert.match(upgrade, /\$new\.Location -ne \$old\.Location/);
    assert.match(upgrade, /\$new\.Key -ne \$old\.Key/);
    assert.match(upgrade, /Assert-ExeVersion/);
    assert.match(upgrade, /Assert-SameTree \$dataBefore/);
    assert.match(upgrade, /Assert-SameTree \$settingsBefore/);
    assert.match(upgrade, /\$ExitDowngrade/);
    assert.match(upgrade, /::notice::Upgrade smoke skipped/);
  });

  it('downgrade: also with a newer per-machine installation next to the per-user one (stand-in HKLM entry, always removed)', () => {
    const downgrade = /'Downgrade' \{\n([\s\S]*?)\n {4}\}\n {2}\}\n/.exec(ps1)?.[1] ?? '';
    assert.match(downgrade, /\$machineKey = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\$\(\$after\.Key\)"/);
    assert.match(downgrade, /Set-ItemProperty -Path \$machineKey -Name 'DisplayVersion' -Value '999\.0\.0'/);
    assert.match(downgrade, /Invoke-Installer \$installerPath @\('\/S', '\/currentuser'\)\) \$ExitDowngrade "Installing \$version per user while a newer per-machine/);
    // The stand-in entry has no DisplayName (never counted as an installation) and is removed on every path.
    assert.doesNotMatch(downgrade, /-Name 'DisplayName'/);
    assert.match(ps1, /^\$script:fakeMachineKey = \$null$/m);
    assert.match(/\nfinally \{\n([\s\S]*)$/.exec(ps1)?.[1] ?? '', /if \(\$script:fakeMachineKey\) \{ Remove-Item -Path \$script:fakeMachineKey -Recurse -Force/);
  });

  it('the harness never relies on the installer closing Pevqori, and uninstalling keeps data and settings', () => {
    assert.doesNotMatch(ps1, /taskkill/i);
    const running = /'RunningApp' \{\n([\s\S]*?)\n {4}\}\n\n {4}'Downgrade'/.exec(ps1)?.[1] ?? '';
    assert.match(running, /\$running\.HasExited\) \{ throw 'Pevqori was closed by the installer' \}/);
    assert.match(running, /CloseMainWindow\(\)/);
    assert.match(ps1, /function Assert-UninstalledKeepsData/);
    assert.match(ps1, /The data folder was deleted by the uninstaller/);
    assert.match(ps1, /was deleted by the uninstaller/);
  });

  it('StrictMode-safe: a function that may return nothing is counted through @() (.Count on $null throws)', () => {
    assert.match(ps1, /^Set-StrictMode -Version Latest$/m);
    const counted = [...ps1.matchAll(/(@?)\((Get-[A-Za-z]+)\b[^()]*\)\.Count/g)];
    assert.ok(counted.length >= 4, `${counted.length} counted calls`);
    for (const [call, at, fn] of counted) {
      // Get-UninstallEntries returns its array as ONE object (`return , $found`), so it is never $null.
      if (fn === 'Get-UninstallEntries') assert.equal(at, '', call);
      else assert.equal(at, '@', `${call} must be @(${fn} …).Count`);
    }
    assert.match(ps1, /function Get-UninstallEntries \{[\s\S]*?return , \$found\n\}/);
  });
});

describe('scripts/release-assets.mjs', () => {
  it('extracts the CHANGELOG section of a version (with or without brackets), and nothing else', async () => {
    const { changelogSection } = await loadReleaseAssets();
    const log = '# Changelog\n\nIntro.\n\n## [2.0.0] — 2026-11-01\n\n### Added\n- Home.\n\n## 1.0.0 — 2026-10-10\n\n- First.\n';
    assert.equal(changelogSection(log, '2.0.0'), '### Added\n- Home.\n');
    assert.equal(changelogSection(log, '1.0.0'), '- First.\n');
    assert.equal(changelogSection(log, '2.0'), null, 'no prefix match');
    assert.equal(changelogSection(log, '3.0.0'), null);
    assert.equal(changelogSection('## [2.0.0]\n\n## 1.0.0\n- x\n', '2.0.0'), null, 'an empty section is no release body');
    assert.equal(changelogSection('## v2.0.0-beta.1\r\n- y\r\n', '2.0.0-beta.1'), '- y\n');
  });

  it('accepts consistent update files and reports each inconsistency', async () => {
    const { checkReleaseFiles, installerName } = await loadReleaseAssets();
    const { createHash } = await import('node:crypto');
    const { gzipSync } = await import('node:zlib');
    const exe = Buffer.from('MZ fake installer bytes');
    const sha = createHash('sha512').update(exe).digest('base64');
    const name = installerName('2.0.0');
    const latest = (v: string, s = sha, size = exe.length): string =>
      `version: ${v}\nfiles:\n  - url: ${name}\n    sha512: ${s}\n    size: ${size}\npath: ${name}\nsha512: ${s}\nreleaseDate: '2026-11-01T00:00:00.000Z'\n`;
    const files = (over: Record<string, Buffer | null> = {}): ((rel: string) => Buffer | null) => {
      const map: Record<string, Buffer | null> = {
        [name]: exe,
        [`${name}.blockmap`]: gzipSync(Buffer.from('{}')),
        'latest.yml': Buffer.from(latest('2.0.0')),
        [path.join('win-unpacked', 'resources', 'app-update.yml')]: Buffer.from('owner: JayPanchani1054\nrepo: billing\nprovider: github\nreleaseType: release\nupdaterCacheDirName: pevqori-updater\n'),
        ...over,
      };
      return (rel) => map[rel] ?? null;
    };
    assert.deepEqual(checkReleaseFiles('2.0.0', files()), []);
    assert.deepEqual(checkReleaseFiles('2.0.1', files()), ['Pevqori-Setup-2.0.1.exe is missing']);
    assert.match(checkReleaseFiles('2.0.0', files({ 'latest.yml': Buffer.from(latest('1.9.0')) })).join('\n'), /latest\.yml version is 1\.9\.0, expected 2\.0\.0/);
    assert.match(checkReleaseFiles('2.0.0', files({ 'latest.yml': Buffer.from(latest('2.0.0', 'AAAA')) })).join('\n'), /sha512 does not match/);
    // The top-level path / sha512 (what electron-updater reads first) are checked on their own too.
    const topLevelOnly = (from: string, to: string): Buffer => Buffer.from(latest('2.0.0').replace(new RegExp(`^${from}$`, 'm'), to));
    assert.deepEqual(checkReleaseFiles('2.0.0', files({ 'latest.yml': topLevelOnly(`sha512: ${sha.replace(/[+/]/g, '\\$&')}`, 'sha512: AAAA') })), [`latest.yml sha512 does not match ${name}`]);
    assert.deepEqual(checkReleaseFiles('2.0.0', files({ 'latest.yml': topLevelOnly(`path: ${name.replace(/\./g, '\\.')}`, 'path: Other.exe') })), [`latest.yml path is Other.exe, expected ${name}`]);
    assert.deepEqual(
      checkReleaseFiles('2.0.0', files({ 'latest.yml': Buffer.from(latest('2.0.0').replace(`  - url: ${name}`, '  - url: Other.exe')) })),
      [`latest.yml files has no entry for ${name}`],
    );
    assert.match(checkReleaseFiles('2.0.0', files({ 'latest.yml': Buffer.from(latest('2.0.0', sha, 3)) })).join('\n'), /size is 3/);
    assert.match(checkReleaseFiles('2.0.0', files({ 'latest.yml': null })).join('\n'), /latest\.yml is missing/);
    assert.match(checkReleaseFiles('2.0.0', files({ [`${name}.blockmap`]: null })).join('\n'), /blockmap is missing/);
    assert.match(checkReleaseFiles('2.0.0', files({ [`${name}.blockmap`]: Buffer.from('{}') })).join('\n'), /not a gzip block map/);
    assert.match(checkReleaseFiles('2.0.0', files({ [path.join('win-unpacked', 'resources', 'app-update.yml')]: null })).join('\n'), /app-update\.yml is missing/);
    assert.match(
      checkReleaseFiles('2.0.0', files({ [path.join('win-unpacked', 'resources', 'app-update.yml')]: Buffer.from('owner: someone\nrepo: billing\nprovider: github\n') })).join('\n'),
      /app-update\.yml owner is someone, expected JayPanchani1054/,
    );
  });

  it('reads latest.yml with quoted values and CRLF line ends', async () => {
    const { parseLatestYml } = await loadReleaseAssets();
    const parsed = parseLatestYml("version: '2.0.0'\r\nfiles:\r\n  - url: 'a.exe'\r\n    sha512: \"x\"\r\n    size: 12\r\npath: a.exe\r\nsha512: x\r\n");
    assert.deepEqual(parsed, { version: '2.0.0', path: 'a.exe', sha512: 'x', files: [{ url: 'a.exe', sha512: 'x', size: 12 }] });
  });
});
