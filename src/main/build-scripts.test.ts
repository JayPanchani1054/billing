// Regression tests for the build/packaging contract the core worker and the fuses depend on
// (scripts/*.mjs|cjs, electron-builder.yml). Plain Node: nothing is bundled or packaged here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

interface FusesModule {
  WANTED_FUSES: Record<string, boolean>;
  fuseProblems(wire: Record<string | number, unknown>, fuses: { FuseV1Options: Record<string, number>; FuseState?: Record<string, number> }): string[];
}
const { WANTED_FUSES, fuseProblems } = require(path.join(root, 'scripts/fuses.cjs')) as FusesModule;

// The shape of @electron/fuses (1.x): option indexes and the ASCII state bytes '0'/'1'.
const FAKE = {
  FuseV1Options: {
    RunAsNode: 0,
    EnableCookieEncryption: 1,
    EnableNodeOptionsEnvironmentVariable: 2,
    EnableNodeCliInspectArguments: 3,
    EnableEmbeddedAsarIntegrityValidation: 4,
    OnlyLoadAppFromAsar: 5,
    LoadBrowserProcessSpecificV8Snapshot: 6,
    GrantFileProtocolExtraPrivileges: 7,
  },
  FuseState: { DISABLE: 48, ENABLE: 49, REMOVED: 114, INHERIT: 144 },
};

function wireFor(states: Record<string, boolean>): Record<number, number> {
  const wire: Record<number, number> = {};
  for (const [name, on] of Object.entries(states)) wire[FAKE.FuseV1Options[name as keyof typeof FAKE.FuseV1Options]] = on ? 49 : 48;
  return wire;
}

describe('Electron fuses (scripts/fuses.cjs)', () => {
  it('hardens exactly the documented fuses', () => {
    assert.deepEqual(WANTED_FUSES, {
      RunAsNode: false,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      OnlyLoadAppFromAsar: true,
      GrantFileProtocolExtraPrivileges: false,
    });
  });

  it('accepts a correctly fused binary and reports every deviation', () => {
    assert.deepEqual(fuseProblems(wireFor(WANTED_FUSES), FAKE), []);
    const stock = wireFor({ ...WANTED_FUSES, RunAsNode: true, EnableNodeCliInspectArguments: true });
    assert.deepEqual(fuseProblems(stock, FAKE), ['RunAsNode: enabled, expected disabled', 'EnableNodeCliInspectArguments: enabled, expected disabled']);
    const missing = wireFor(WANTED_FUSES);
    delete missing[FAKE.FuseV1Options.GrantFileProtocolExtraPrivileges];
    assert.equal(fuseProblems(missing, FAKE).length, 1);
    const older = { ...FAKE, FuseV1Options: { ...FAKE.FuseV1Options, GrantFileProtocolExtraPrivileges: undefined as unknown as number } };
    assert.match(fuseProblems(wireFor(WANTED_FUSES), older)[0], /unknown to the installed @electron\/fuses/);
  });

  it('works with the real @electron/fuses 1.x exports, which do not include FuseState (regression: CI packaging threw "reading DISABLE")', () => {
    const { FuseState: _omitted, ...realShape } = FAKE;
    assert.deepEqual(fuseProblems(wireFor(WANTED_FUSES), realShape), []);
    const stock = wireFor({ ...WANTED_FUSES, RunAsNode: true });
    assert.deepEqual(fuseProblems(stock, realShape), ['RunAsNode: enabled, expected disabled']);
  });

  it('the afterPack hook fails closed (no warn-and-continue path without the explicit opt-out)', () => {
    const hook = fs.readFileSync(path.join(root, 'scripts/after-pack.cjs'), 'utf8');
    assert.match(hook, /throw new Error\(message\)/);
    assert.doesNotMatch(hook, /BAHI_REQUIRE_FUSES/);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    assert.ok(pkg.devDependencies['@electron/fuses'], '@electron/fuses must be a declared devDependency');
  });
});

describe('core worker bundle', () => {
  it('is built next to main and may only require node:* builtins', async () => {
    const cfg = (await import(pathToFileURL(path.join(root, 'scripts/build-config.mjs')).href)) as {
      electronBuildOptions(mode: string): Record<string, { outfile: string; external: string[]; entryPoints: string[] }>;
      forbiddenWorkerRequires(code: string): string[];
    };
    const opts = cfg.electronBuildOptions('production');
    assert.equal(path.relative(root, opts.coreWorker.outfile), path.join('out', 'main', 'core-worker.cjs'));
    assert.equal(path.dirname(opts.coreWorker.outfile), path.dirname(opts.main.outfile), 'workerScriptPath() looks next to index.cjs');
    assert.deepEqual(opts.coreWorker.external, ['node:*'], "'electron' must not be external (it would be required at runtime)");
    assert.deepEqual(cfg.forbiddenWorkerRequires("require('node:sqlite');require(\"node:fs\")"), []);
    assert.deepEqual(cfg.forbiddenWorkerRequires("require('electron');require('fs')"), ['electron', 'fs']);
  });

  it('is shipped outside app.asar by electron-builder', () => {
    const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    assert.match(yml, /^asarUnpack:\s*\n\s+- out\/main\/core-worker\.cjs\s*$/m);
  });
});
