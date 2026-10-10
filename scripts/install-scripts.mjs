#!/usr/bin/env node
// Dependency install scripts in a RELEASE build (.github/workflows/release.yml, docs/BUILD.md §7).
//
// The release installs with `npm ci --ignore-scripts`, so no dependency's install/postinstall script
// runs on the machine that later signs the installer (a script could otherwise leave code behind in
// node_modules that runs in the signing step). The few install scripts the build needs are reviewed
// here and run explicitly, by path, from the lockfile-pinned package:
//
//   node scripts/install-scripts.mjs --check   exit 1 when the lockfile has an install script that is
//                                              not reviewed below (a new dependency: review, then list it)
//   node scripts/install-scripts.mjs --run     --check, then run the reviewed 'run' scripts
//
// Pure metadata for --check (package-lock.json `hasInstallScript`); --run reads each package's own
// package.json and runs its postinstall only when it is exactly the command reviewed here.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lockfile paths with an install script → what the release does with it.
 * @type {Readonly<Record<string, { action: 'run', command: string, why: string } | { action: 'skip', why: string }>>}
 */
export const REVIEWED_INSTALL_SCRIPTS = {
  'node_modules/esbuild': { action: 'run', command: 'node install.js', why: 'checks / links the platform binary of esbuild (bundling main, worker, preload)' },
  'node_modules/vite/node_modules/esbuild': { action: 'run', command: 'node install.js', why: "the same for vite's own esbuild (renderer bundle)" },
  'node_modules/fsevents': { action: 'skip', why: 'macOS file watching only; never installed on Windows' },
  'node_modules/electron-winstaller': { action: 'skip', why: 'Squirrel.Windows target only; the installer is NSIS' },
};

/** @param {unknown} v */
function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {};
}

/**
 * Packages of a parsed package-lock.json that have an install script nobody reviewed.
 * @param {unknown} lock
 * @returns {string[]}
 */
export function unreviewedInstallScripts(lock) {
  const out = [];
  for (const [key, entry] of Object.entries(record(record(lock).packages))) {
    if (key === '' || record(entry).hasInstallScript !== true) continue;
    if (!Object.hasOwn(REVIEWED_INSTALL_SCRIPTS, key)) out.push(key);
  }
  return out.sort();
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const unreviewed = unreviewedInstallScripts(lock);
  if (unreviewed.length > 0) {
    console.error('Dependencies with install scripts that are not reviewed in scripts/install-scripts.mjs:');
    for (const k of unreviewed) console.error(`  - ${k}`);
    console.error('Review what each script does, then add it to REVIEWED_INSTALL_SCRIPTS (run or skip).');
    process.exit(1);
  }
  if (process.argv.includes('--run')) {
    const installed = record(lock.packages);
    for (const [key, rule] of Object.entries(REVIEWED_INSTALL_SCRIPTS)) {
      if (rule.action !== 'run' || !Object.hasOwn(installed, key)) continue;
      const dir = path.join(root, ...key.split('/'));
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      } catch {
        continue; // optional / not installed on this platform
      }
      const script = record(pkg.scripts).postinstall;
      if (script !== rule.command) {
        console.error(`${key}: postinstall is ${JSON.stringify(script)}, reviewed was ${JSON.stringify(rule.command)}. Review it again.`);
        process.exit(1);
      }
      console.log(`${key}: ${rule.command} (${rule.why})`);
      execFileSync(process.execPath, rule.command.split(' ').slice(1), { cwd: dir, stdio: 'inherit' });
    }
  }
  console.log('Install scripts: all reviewed.');
}
