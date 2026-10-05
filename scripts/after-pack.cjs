// electron-builder afterPack hook (runs before signing): flip Electron fuses on the packaged binary.
// https://www.electronjs.org/docs/latest/tutorial/fuses
//
//  RunAsNode=false                       ELECTRON_RUN_AS_NODE cannot turn Bahi ERP.exe into a Node runtime
//  EnableNodeOptionsEnvironmentVariable  NODE_OPTIONS is ignored (no --require injection)
//  EnableNodeCliInspectArguments=false   --inspect / --inspect-brk are ignored (no debugger attach)
//  OnlyLoadAppFromAsar=true              code is only loaded from resources/app.asar
//  EnableCookieEncryption=true           Chromium cookie store encrypted with the OS key store
//  GrantFileProtocolExtraPrivileges=false file:// pages get no extra privileges (we never use file://)
//
// @electron/fuses ships as a dependency of electron-builder. If it cannot be loaded the build continues
// with a loud warning, unless BAHI_REQUIRE_FUSES=1 (recommended for release pipelines once verified).
'use strict';

const path = require('node:path');

async function afterPack(context) {
  const required = process.env.BAHI_REQUIRE_FUSES === '1';
  let fuses;
  try {
    fuses = require('@electron/fuses');
  } catch (err) {
    const message = `@electron/fuses could not be loaded (${err && err.message}); Electron fuses NOT applied`;
    if (required) throw new Error(message);
    console.warn(`  • WARNING: ${message}`);
    return;
  }

  const { flipFuses, FuseVersion, FuseV1Options } = fuses;
  const platform = context.electronPlatformName;
  const productFilename = context.packager.appInfo.productFilename;
  const binary =
    platform === 'win32'
      ? path.join(context.appOutDir, `${productFilename}.exe`)
      : platform === 'darwin'
        ? path.join(context.appOutDir, `${productFilename}.app`)
        : path.join(context.appOutDir, context.packager.executableName);

  const wanted = {
    RunAsNode: false,
    EnableCookieEncryption: true,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    OnlyLoadAppFromAsar: true,
    GrantFileProtocolExtraPrivileges: false,
  };
  const config = { version: FuseVersion.V1, resetAdHocDarwinSignature: platform === 'darwin' };
  for (const [name, value] of Object.entries(wanted)) {
    // Skip fuses unknown to the installed @electron/fuses version instead of failing.
    if (FuseV1Options[name] !== undefined) config[FuseV1Options[name]] = value;
  }

  try {
    await flipFuses(binary, config);
    console.log(`  • Electron fuses applied to ${path.basename(binary)}`);
  } catch (err) {
    if (required) throw err;
    console.warn(`  • WARNING: could not apply Electron fuses: ${err && err.message}`);
  }
}

// Works whether electron-builder loads the hook with require() (uses .default) or import() (uses module.exports).
module.exports = afterPack;
module.exports.default = afterPack;
