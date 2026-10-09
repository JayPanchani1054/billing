// electron-builder afterPack hook (runs before signing): flip Electron fuses on the packaged binary,
// then read them back. The wanted fuses and why: scripts/fuses.cjs and docs/SECURITY.md §3.7.
//
// Fails closed: if @electron/fuses (a declared devDependency) cannot be loaded, a wanted fuse is
// unknown to it, flipping fails, or the read-back differs, the build FAILS — a release can never ship
// an unhardened binary with a green log. For a throw-away local experiment only, BAHI_ALLOW_UNFUSED=1
// downgrades this to a warning; CI never sets it.
'use strict';

const path = require('node:path');
const { WANTED_FUSES, fuseProblems } = require('./fuses.cjs');

function binaryPath(context) {
  const platform = context.electronPlatformName;
  const productFilename = context.packager.appInfo.productFilename;
  if (platform === 'win32') return path.join(context.appOutDir, `${productFilename}.exe`);
  if (platform === 'darwin') return path.join(context.appOutDir, `${productFilename}.app`);
  return path.join(context.appOutDir, context.packager.executableName);
}

async function applyFuses(context) {
  const fuses = require('@electron/fuses');
  const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } = fuses;
  const binary = binaryPath(context);
  const config = { version: FuseVersion.V1, resetAdHocDarwinSignature: context.electronPlatformName === 'darwin' };
  for (const [name, value] of Object.entries(WANTED_FUSES)) {
    if (FuseV1Options[name] === undefined) throw new Error(`Fuse ${name} is unknown to the installed @electron/fuses`);
    config[FuseV1Options[name]] = value;
  }
  await flipFuses(binary, config);
  const problems = fuseProblems(await getCurrentFuseWire(binary), fuses);
  if (problems.length > 0) throw new Error(`Fuses not as wanted after flipping: ${problems.join('; ')}`);
  console.log(`  • Electron fuses applied and verified on ${path.basename(binary)}`);
}

async function afterPack(context) {
  try {
    await applyFuses(context);
  } catch (err) {
    const message = `Electron fuses could not be applied: ${err && err.message ? err.message : String(err)}`;
    if (process.env.BAHI_ALLOW_UNFUSED === '1') {
      console.warn(`  • WARNING (BAHI_ALLOW_UNFUSED=1): ${message} — this build must not be distributed`);
      return;
    }
    throw new Error(message);
  }
}

// Works whether electron-builder loads the hook with require() (uses .default) or import() (uses module.exports).
module.exports = afterPack;
module.exports.default = afterPack;
