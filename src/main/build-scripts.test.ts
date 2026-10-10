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
    assert.doesNotMatch(hook, /PEVQORI_REQUIRE_FUSES/);
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

// ───────────────────────────── in-app updater bundle (2.0) ─────────────────────────────

interface BuildConfig {
  electronBuildOptions(mode: string): Record<string, { outfile: string; external: string[]; entryPoints: string[] }>;
  mainBundlesUpdater(code: string): boolean;
  forbiddenUpdaterRequires(code: string): string[];
}
const loadBuildConfig = async (): Promise<BuildConfig> =>
  (await import(pathToFileURL(path.join(root, 'scripts/build-config.mjs')).href)) as BuildConfig;

/** Every source file reachable from `entry` through static imports / literal requires (relative paths only). */
function sourceGraph(entry: string): { files: Set<string>; packages: Map<string, string[]> } {
  const files = new Set<string>();
  const packages = new Map<string, string[]>();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const code = fs.readFileSync(file, 'utf8');
    const specs = [
      ...code.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
      ...code.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (spec.startsWith('.')) todo.push(path.resolve(path.dirname(file), spec));
      else packages.set(spec, [...(packages.get(spec) ?? []), path.relative(root, file)]);
    }
  }
  return { files, packages };
}

describe('in-app updater bundle (electron-updater, src/main/updates)', () => {
  it('is a separate esbuild entry next to index.cjs; Electron stays external', async () => {
    const opts = (await loadBuildConfig()).electronBuildOptions('production');
    assert.ok(opts.updater, 'scripts/build-config.mjs has an updater entry');
    assert.equal(path.relative(root, opts.updater.outfile), path.join('out', 'main', 'updater.cjs'));
    assert.equal(path.dirname(opts.updater.outfile), path.dirname(opts.main.outfile), 'updates/loader.ts looks next to index.cjs');
    assert.deepEqual(opts.updater.entryPoints, [path.join(root, 'src/main/updates/entry.ts')]);
    assert.ok(opts.updater.external.includes('electron'));
    const loader = fs.readFileSync(path.join(root, 'src/main/updates/loader.ts'), 'utf8');
    assert.match(loader, /UPDATER_BUNDLE = 'updater\.cjs'/);
  });

  it('main never imports electron-updater statically; only the updater entry does (zero bytes on the start-up path)', () => {
    const main = sourceGraph(path.join(root, 'src/main/index.ts'));
    assert.equal(main.packages.has('electron-updater'), false, `reached from: ${main.packages.get('electron-updater')?.join(', ')}`);
    assert.equal(main.files.has(path.join(root, 'src/main/updates/entry.ts')), false, 'index.ts must not import updates/entry.ts');
    assert.ok(main.files.has(path.join(root, 'src/main/updates/service.ts')), 'the graph walker follows the service');
    const updater = sourceGraph(path.join(root, 'src/main/updates/entry.ts'));
    assert.deepEqual([...new Set(updater.packages.get('electron-updater'))], [path.join('src', 'main', 'updates', 'entry.ts')]);
    // The loader's require is computed, so esbuild cannot follow it into index.cjs.
    const loader = fs.readFileSync(path.join(root, 'src/main/updates/loader.ts'), 'utf8');
    assert.doesNotMatch(loader, /require\(\s*['"`]/);
  });

  it('the build guards recognise the library and refuse anything that is not shipped', async () => {
    const cfg = await loadBuildConfig();
    assert.equal(cfg.mainBundlesUpdater('const a = "electron-updater"; class X {}'), false, 'the partition name alone is not the library');
    assert.equal(cfg.mainBundlesUpdater('exports.NsisUpdater = NsisUpdater;'), true);
    assert.deepEqual(cfg.forbiddenUpdaterRequires("require('electron');require('fs');require('node:path');require('original-fs');require('child_process')"), []);
    assert.deepEqual(cfg.forbiddenUpdaterRequires("require('js-yaml');require('electron')"), ['js-yaml']);
    const build = fs.readFileSync(path.join(root, 'scripts/build.mjs'), 'utf8');
    assert.match(build, /esbuild\(opts\.updater\)/);
    assert.match(build, /mainBundlesUpdater\(readFileSync\(path\.join\(outDir, 'main\/index\.cjs'\)/);
    assert.match(build, /'main\/updater\.cjs'/);
  });

  it('electron-updater is an exactly pinned devDependency (bundled, so nothing from node_modules ships)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies: Record<string, string> };
    assert.match(pkg.devDependencies['electron-updater'] ?? '', /^6\.\d+\.\d+$/);
    assert.equal(pkg.dependencies?.['electron-updater'], undefined);
  });

  it('the packaged app includes out/main/updater.cjs (electron-builder files: out/**/*)', () => {
    const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    // (Any position in the files list: electron-builder.yml belongs to WP-11, which may add entries.)
    const files = /^files:\s*\n((?:[ \t]+-.*\n?)+)/m.exec(yml)?.[1] ?? '';
    assert.match(files, /^[ \t]+- ["']?out\/\*\*\/\*["']?[ \t]*$/m);
    assert.doesNotMatch(yml, /!out\/main\/updater/);
  });

  const built = fs.existsSync(path.join(root, 'out/main/index.cjs')) && fs.existsSync(path.join(root, 'out/main/updater.cjs'));
  it('after a build: index.cjs does not contain electron-updater, updater.cjs does', { skip: built ? false : 'run after `npm run build`' }, async () => {
    const cfg = await loadBuildConfig();
    assert.equal(cfg.mainBundlesUpdater(fs.readFileSync(path.join(root, 'out/main/index.cjs'), 'utf8')), false);
    const updater = fs.readFileSync(path.join(root, 'out/main/updater.cjs'), 'utf8');
    assert.equal(cfg.mainBundlesUpdater(updater), true);
    assert.deepEqual(cfg.forbiddenUpdaterRequires(updater), []);
  });
});
