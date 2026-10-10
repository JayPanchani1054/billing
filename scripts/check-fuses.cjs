#!/usr/bin/env node
// Read the Electron fuses back from a packaged binary and fail unless every one is as wanted
// (scripts/fuses.cjs). Run by CI after packaging:
//
//   node scripts/check-fuses.cjs "release/win-unpacked/Pevqori.exe"
'use strict';

const path = require('node:path');
const { fuseProblems, WANTED_FUSES } = require('./fuses.cjs');

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/check-fuses.cjs <path to the packaged Electron binary>');
    process.exit(2);
  }
  const fuses = require('@electron/fuses');
  const wire = await fuses.getCurrentFuseWire(path.resolve(target));
  const problems = fuseProblems(wire, fuses);
  if (problems.length > 0) {
    for (const p of problems) console.error(`✖ ${p}`);
    console.error(`\n${problems.length} fuse(s) not hardened on ${target}`);
    process.exit(1);
  }
  for (const [name, enabled] of Object.entries(WANTED_FUSES)) console.log(`✔ ${name}: ${enabled ? 'enabled' : 'disabled'}`);
}

main().catch((err) => {
  console.error(`✖ could not read the fuses: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
