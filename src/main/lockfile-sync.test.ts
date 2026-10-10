// scripts/lockfile-sync.mjs decides between `npm ci` (lockfile in sync) and `npm install` in CI, and
// makes a release refuse to build without a matching lockfile (docs/BUILD.md §5.2, §6).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface LockfileSync {
  lockfileProblems(pkg: unknown, lock: unknown): string[];
  lockfileStatus(root: string): { status: 'in-sync' | 'stale' | 'missing'; problems: string[] };
}
const sync = (await import(pathToFileURL(path.join(root, 'scripts/lockfile-sync.mjs')).href)) as LockfileSync;

const PKG = {
  name: 'demo',
  version: '1.0.0',
  dependencies: { react: '^19.1.0' },
  devDependencies: { electron: '^44.5.1', typescript: '^6.0.2' },
};

/** What `npm install --package-lock-only` writes for PKG (abridged to the fields the check reads). */
function lockFor(pkg: typeof PKG): Record<string, unknown> {
  return {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: pkg.name, version: pkg.version, dependencies: { ...pkg.dependencies }, devDependencies: { ...pkg.devDependencies } },
      'node_modules/react': { version: '19.1.1' },
      'node_modules/electron': { version: '44.5.1', dev: true },
      'node_modules/typescript': { version: '6.0.2', dev: true },
    },
  };
}

describe('lockfile sync check (scripts/lockfile-sync.mjs)', () => {
  it('accepts a lockfile generated from the same package.json', () => {
    assert.deepEqual(sync.lockfileProblems(PKG, lockFor(PKG)), []);
  });

  it('reports a changed range, an added and a removed dependency', () => {
    const lock = lockFor(PKG);
    const changed = { ...PKG, devDependencies: { electron: '^45.0.0', '@electron/fuses': '^1.8.0' } };
    const problems = sync.lockfileProblems(changed, lock);
    assert.ok(problems.some((p) => /devDependencies\.electron is \^45\.0\.0 in package\.json but \^44\.5\.1/.test(p)), problems.join('\n'));
    assert.ok(problems.some((p) => /@electron\/fuses .* is not in the lockfile/.test(p)), problems.join('\n'));
    assert.ok(problems.some((p) => /typescript is in the lockfile but no longer in package\.json/.test(p)), problems.join('\n'));
  });

  it('reports a declared dependency with no resolved package, and npm 6 lockfiles', () => {
    const lock = lockFor(PKG);
    delete (lock.packages as Record<string, unknown>)['node_modules/react'];
    assert.match(sync.lockfileProblems(PKG, lock).join('\n'), /dependencies\.react has no resolved package/);
    assert.match(sync.lockfileProblems(PKG, { lockfileVersion: 1, dependencies: {} }).join('\n'), /lockfileVersion 1 is not supported/);
  });

  it('classifies a project folder as in-sync, stale or missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pevqori-lock-'));
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify(PKG));
      assert.equal(sync.lockfileStatus(dir).status, 'missing');
      writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lockFor(PKG)));
      assert.equal(sync.lockfileStatus(dir).status, 'in-sync');
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...PKG, dependencies: { react: '^20.0.0' } }));
      assert.equal(sync.lockfileStatus(dir).status, 'stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every workflow installs through it: npm ci when in sync, never a silent float in a release', () => {
    const wf = (name: string) => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
    const ci = wf('ci.yml');
    const installs = ci.match(/- name: Install dependencies[\s\S]*?(?=\n {6}- |\n {2}\S|$)/g) ?? [];
    assert.ok(installs.length >= 3, 'verify, windows-installer and e2e install dependencies');
    for (const step of installs) {
      assert.match(step, /node scripts\/lockfile-sync\.mjs/);
      assert.match(step, /npm ci --no-audit --no-fund/);
    }
    const release = wf('release.yml');
    assert.match(release, /node scripts\/lockfile-sync\.mjs \|\|/);
    // A release installs without running dependency install scripts (scripts/install-scripts.mjs runs the reviewed ones).
    assert.match(release, /npm ci --ignore-scripts --no-audit --no-fund/);
    assert.doesNotMatch(release, /npm install --no-audit/, 'a release never resolves versions afresh');
  });
});
