#!/usr/bin/env node
// Release helpers for .github/workflows/release.yml and ci.yml (docs/BUILD.md §6). node:* only.
//
//   node scripts/release-assets.mjs notes <version> <CHANGELOG.md> [out.md]
//       Extracts the "## [<version>]" (or "## <version>") section of the changelog — the release body.
//       Without [out.md] it only checks that the section exists (fail fast before a long build).
//   node scripts/release-assets.mjs check <release-dir> <version>
//       Checks what electron-builder wrote for the in-app updater: Pevqori-Setup-<version>.exe, its
//       .blockmap, latest.yml (version == <version>, path / url == the installer, sha512 and size of the
//       installer) and win-unpacked/resources/app-update.yml (provider github, owner, repo).
//
// Exit code 0 when fine, 1 with "::error::" lines otherwise.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The GitHub repository that hosts the releases (electron-builder.yml publish, src/main/updates/policy.ts). */
export const PUBLISH = { provider: 'github', owner: 'JayPanchani1054', repo: 'billing' };

export const installerName = (version) => `Pevqori-Setup-${version}.exe`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The body of the changelog section for `version` (heading "## [x.y.z]", "## x.y.z" or with a leading
 * "v", optionally followed by " — date"), without the heading, trimmed; null when absent or empty.
 */
export function changelogSection(text, version) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const heading = new RegExp(`^## \\[?v?${escapeRe(version)}\\]?(?:\\s|$)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body === '' ? null : `${body}\n`;
}

const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

/** The fields of electron-builder's latest.yml this pipeline relies on (flat `key: value` lines). */
export function parseLatestYml(text) {
  const out = { version: null, path: null, sha512: null, files: [] };
  let file = null;
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    let m = /^(version|path|sha512):\s*(.+)$/.exec(raw);
    if (m) {
      out[m[1]] = unquote(m[2]);
      file = null;
      continue;
    }
    m = /^\s*-\s*url:\s*(.+)$/.exec(raw);
    if (m) {
      file = { url: unquote(m[1]), sha512: null, size: null };
      out.files.push(file);
      continue;
    }
    m = /^\s+(sha512|size):\s*(.+)$/.exec(raw);
    if (m && file) file[m[1]] = m[1] === 'size' ? Number(unquote(m[2])) : unquote(m[2]);
  }
  return out;
}

/** `key: value` pairs of a flat YAML file such as resources/app-update.yml. */
export function parseFlatYml(text) {
  const out = {};
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(raw);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

/**
 * Problems with the update files for `version` (empty when all is well). `read(relativePath)` returns
 * the file's bytes or null — a release folder in the CLI, an in-memory map in tests.
 */
export function checkReleaseFiles(version, read) {
  const problems = [];
  const exeName = installerName(version);
  const exe = read(exeName);
  if (!exe) return [`${exeName} is missing`];
  const sha512 = createHash('sha512').update(exe).digest('base64');

  const blockmap = read(`${exeName}.blockmap`);
  if (!blockmap) problems.push(`${exeName}.blockmap is missing`);
  else if (blockmap.length < 2 || blockmap[0] !== 0x1f || blockmap[1] !== 0x8b) problems.push(`${exeName}.blockmap is not a gzip block map`);

  const latestRaw = read('latest.yml');
  if (!latestRaw) problems.push('latest.yml is missing');
  else {
    const latest = parseLatestYml(latestRaw.toString('utf8'));
    if (latest.version !== version) problems.push(`latest.yml version is ${latest.version}, expected ${version}`);
    if (latest.path !== exeName) problems.push(`latest.yml path is ${latest.path}, expected ${exeName}`);
    if (latest.sha512 !== sha512) problems.push(`latest.yml sha512 does not match ${exeName}`);
    const entry = latest.files.find((f) => f.url === exeName);
    if (!entry) problems.push(`latest.yml files has no entry for ${exeName}`);
    else {
      if (entry.sha512 !== sha512) problems.push(`latest.yml files[${exeName}].sha512 does not match the installer`);
      if (entry.size !== exe.length) problems.push(`latest.yml files[${exeName}].size is ${entry.size}, the installer has ${exe.length} bytes`);
    }
  }

  const appUpdate = read(path.join('win-unpacked', 'resources', 'app-update.yml'));
  if (!appUpdate) problems.push('win-unpacked/resources/app-update.yml is missing (electron-builder.yml publish)');
  else {
    const cfg = parseFlatYml(appUpdate.toString('utf8'));
    for (const [k, v] of Object.entries(PUBLISH)) {
      if (cfg[k] !== v) problems.push(`app-update.yml ${k} is ${cfg[k]}, expected ${v}`);
    }
  }
  return problems;
}

function readFrom(dir) {
  return (rel) => {
    const p = path.join(dir, rel);
    return existsSync(p) && statSync(p).isFile() ? readFileSync(p) : null;
  };
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'notes' && args.length >= 2) {
    const [version, changelog, out] = args;
    const body = changelogSection(readFileSync(changelog, 'utf8'), version);
    if (!body) {
      console.error(`::error::${changelog} has no "## [${version}]" section (the release body). Add it, commit and re-tag.`);
      return 1;
    }
    if (out) {
      writeFileSync(out, body);
      console.log(`${out}: ${body.length} characters from ${changelog} ## [${version}]`);
    } else console.log(`${changelog} has a section for ${version} (${body.length} characters)`);
    return 0;
  }
  if (cmd === 'check' && args.length === 2) {
    const [dir, version] = args;
    const problems = checkReleaseFiles(version, readFrom(dir));
    for (const p of problems) console.error(`::error::${p}`);
    if (problems.length === 0) console.log(`${dir}: ${installerName(version)}, .blockmap, latest.yml and app-update.yml are consistent`);
    return problems.length === 0 ? 0 : 1;
  }
  console.error('usage: release-assets.mjs notes <version> <CHANGELOG.md> [out.md] | check <release-dir> <version>');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
