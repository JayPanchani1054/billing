// Shared build configuration for scripts/build.mjs and scripts/dev.mjs.
// Main and preload are bundled by esbuild into CommonJS (Electron's main process and sandboxed preloads
// load CJS); the renderer is built by Vite using vite.config.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const outDir = path.join(root, 'out');
export const viteConfigFile = path.join(root, 'vite.config.ts');

/** Vite dev server location (must match vite.config.ts → server). Loopback only. */
export const DEV_HOST = '127.0.0.1';
export const DEV_PORT = 5173;

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
export const appVersion = String(pkg.version);

/**
 * esbuild options for the three Electron bundles:
 *   main        out/main/index.cjs        Electron main thread (windows, IPC, dialogs)
 *   coreWorker  out/main/core-worker.cjs  the accounting core on a node:worker_threads thread; shipped
 *                                          outside app.asar (electron-builder.yml → asarUnpack)
 *   preload     out/preload/index.cjs     sandboxed preload (only require('electron'))
 * @param {'production' | 'development'} mode
 * @returns {{ main: import('esbuild').BuildOptions, coreWorker: import('esbuild').BuildOptions, preload: import('esbuild').BuildOptions }}
 */
export function electronBuildOptions(mode) {
  const production = mode === 'production';
  /** @type {import('esbuild').BuildOptions} */
  const common = {
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // Electron is provided at runtime; node:* builtins are never bundled.
    external: ['electron', 'node:*'],
    tsconfig: path.join(root, 'tsconfig.node.json'),
    sourcemap: production ? false : 'linked',
    minify: production,
    keepNames: true,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'info',
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
      __BAHI_VERSION__: JSON.stringify(appVersion),
    },
  };
  // Core code is ESM-first; if it ever reads import.meta.* keep it working in the CJS bundles.
  const importMeta = {
    define: {
      ...common.define,
      'import.meta.url': '__bahi_import_meta_url',
      'import.meta.dirname': '__dirname',
      'import.meta.filename': '__filename',
    },
    banner: { js: "const __bahi_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  };
  return {
    main: {
      ...common,
      ...importMeta,
      entryPoints: [path.join(root, 'src/main/index.ts')],
      outfile: path.join(outDir, 'main/index.cjs'),
    },
    coreWorker: {
      ...common,
      ...importMeta,
      entryPoints: [path.join(root, 'src/main/core-worker.ts')],
      outfile: path.join(outDir, 'main/core-worker.cjs'),
      // Electron's main-process API does not exist on worker threads: never let it be bundled in.
      external: ['node:*'],
    },
    preload: {
      ...common,
      entryPoints: [path.join(root, 'src/preload/index.ts')],
      outfile: path.join(outDir, 'preload/index.cjs'),
    },
  };
}

/**
 * The core worker runs on a node:worker_threads thread, where only node:* builtins exist (no
 * 'electron', and nothing from node_modules is shipped). Fail the build if anything else is required.
 * @param {string} code
 * @returns {string[]} offending module ids
 */
export function forbiddenWorkerRequires(code) {
  const bad = new Set();
  for (const m of code.matchAll(/\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    if (!m[1].startsWith('node:')) bad.add(m[1]);
  }
  return [...bad];
}

/**
 * Sandboxed preload scripts can only require('electron') (plus a few polyfilled modules). Fail the
 * build early if anything else slipped into the preload bundle instead of failing at runtime.
 * @param {string} code
 * @returns {string[]} offending module ids
 */
export function forbiddenPreloadRequires(code) {
  const bad = new Set();
  for (const m of code.matchAll(/\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    if (m[1] !== 'electron') bad.add(m[1]);
  }
  return [...bad];
}
