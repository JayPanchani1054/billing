#!/usr/bin/env node
// Is package-lock.json present and in step with package.json? Used by CI and release to pick the
// install command (.github/workflows/*.yml, docs/BUILD.md §5.2):
//
//   node scripts/lockfile-sync.mjs     exit 0  in sync           → `npm ci` (exact, reproducible)
//                                      exit 1  out of date       → CI warns and uses `npm install`;
//                                      exit 2  missing/unreadable    a release refuses to build
//
// Pure metadata comparison, no network: npm (v7+, lockfileVersion ≥ 2) records the dependency specs
// of package.json in the lockfile's root entry (packages[""]) and every installed package under
// packages["node_modules/<name>"]. `npm ci` itself would only find a mismatch after starting to fetch,
// and it cannot tell "stale lockfile" apart from a network error.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** @param {unknown} v */
function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {};
}

/**
 * Compare a parsed package.json with a parsed package-lock.json.
 * @param {unknown} pkg
 * @param {unknown} lock
 * @returns {string[]} human-readable problems (empty when the lockfile matches package.json)
 */
export function lockfileProblems(pkg, lock) {
  const problems = [];
  const l = record(lock);
  const version = l.lockfileVersion;
  if (typeof version !== 'number' || version < 2) {
    return [`lockfileVersion ${String(version)} is not supported (npm 7+ writes 2 or 3)`];
  }
  const packages = record(l.packages);
  const rootEntry = record(packages['']);
  const p = record(pkg);
  for (const field of FIELDS) {
    const declared = record(p[field]);
    const locked = record(rootEntry[field]);
    for (const [name, spec] of Object.entries(declared)) {
      if (!(name in locked)) problems.push(`${field}.${name} (${String(spec)}) is not in the lockfile`);
      else if (locked[name] !== spec) problems.push(`${field}.${name} is ${String(spec)} in package.json but ${String(locked[name])} in the lockfile`);
      else if (field !== 'peerDependencies' && field !== 'optionalDependencies' && !(`node_modules/${name}` in packages)) {
        problems.push(`${field}.${name} has no resolved package in the lockfile`);
      }
    }
    for (const name of Object.keys(locked)) {
      if (!(name in declared)) problems.push(`${field}.${name} is in the lockfile but no longer in package.json`);
    }
  }
  return problems;
}

/**
 * @param {string} root  project folder
 * @returns {{ status: 'in-sync' | 'stale' | 'missing', problems: string[] }}
 */
export function lockfileStatus(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  let lock;
  try {
    lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  } catch (err) {
    const code = /** @type {{ code?: unknown }} */ (err).code;
    return { status: 'missing', problems: [code === 'ENOENT' ? 'package-lock.json does not exist' : `package-lock.json cannot be read: ${String(err)}`] };
  }
  const problems = lockfileProblems(pkg, lock);
  return { status: problems.length === 0 ? 'in-sync' : 'stale', problems };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { status, problems } = lockfileStatus(root);
  if (status === 'in-sync') {
    console.log('package-lock.json is in sync with package.json');
  } else {
    console.log(`package-lock.json is ${status === 'missing' ? 'missing' : 'out of date'}:`);
    for (const p of problems.slice(0, 20)) console.log(`  - ${p}`);
    if (problems.length > 20) console.log(`  … and ${problems.length - 20} more`);
  }
  process.exitCode = status === 'in-sync' ? 0 : status === 'stale' ? 1 : 2;
}
