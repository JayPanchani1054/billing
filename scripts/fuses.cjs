// The Electron fuses Bahi ERP ships with — one list shared by scripts/after-pack.cjs (flips them on the
// packaged binary) and scripts/check-fuses.cjs (reads them back in CI). Rationale: docs/SECURITY.md §3.7.
// https://www.electronjs.org/docs/latest/tutorial/fuses
'use strict';

/** Fuse name (FuseV1Options key in @electron/fuses) → wanted state (true = enabled). */
const WANTED_FUSES = Object.freeze({
  RunAsNode: false, //                            ELECTRON_RUN_AS_NODE cannot turn Bahi ERP.exe into a Node runtime
  EnableCookieEncryption: true, //                Chromium cookie store encrypted with the OS key store
  EnableNodeOptionsEnvironmentVariable: false, // NODE_OPTIONS is ignored (no --require injection)
  EnableNodeCliInspectArguments: false, //        --inspect / --inspect-brk are ignored (no debugger attach)
  OnlyLoadAppFromAsar: true, //                   app code is only loaded from resources/app.asar
  GrantFileProtocolExtraPrivileges: false, //     file:// pages get no extra privileges (we never use file://)
});

/**
 * Compare a fuse wire read with @electron/fuses getCurrentFuseWire() against WANTED_FUSES.
 * @param {Record<string|number, unknown>} wire  getCurrentFuseWire() result
 * @param {{ FuseV1Options: Record<string, number>, FuseState: Record<string, number> }} fuses  the @electron/fuses module
 * @returns {string[]} human-readable problems (empty when every fuse is as wanted)
 */
function fuseProblems(wire, fuses) {
  const problems = [];
  for (const [name, enabled] of Object.entries(WANTED_FUSES)) {
    const index = fuses.FuseV1Options[name];
    if (index === undefined) {
      problems.push(`${name}: unknown to the installed @electron/fuses`);
      continue;
    }
    const actual = wire[index];
    const expected = enabled ? fuses.FuseState.ENABLE : fuses.FuseState.DISABLE;
    if (actual !== expected) {
      const label = actual === fuses.FuseState.ENABLE ? 'enabled' : actual === fuses.FuseState.DISABLE ? 'disabled' : `state ${String(actual)}`;
      problems.push(`${name}: ${label}, expected ${enabled ? 'enabled' : 'disabled'}`);
    }
  }
  return problems;
}

module.exports = { WANTED_FUSES, fuseProblems };
