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
