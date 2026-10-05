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
 * esbuild options for the two Electron bundles.
 * @param {'production' | 'development'} mode
 * @returns {{ main: import('esbuild').BuildOptions, preload: import('esbuild').BuildOptions }}
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
  return {
    main: {
      ...common,
      entryPoints: [path.join(root, 'src/main/index.ts')],
      outfile: path.join(outDir, 'main/index.cjs'),
      // Core code is ESM-first; if it ever reads import.meta.* keep it working in the CJS bundle.
      define: {
        ...common.define,
        'import.meta.url': '__bahi_import_meta_url',
        'import.meta.dirname': '__dirname',
        'import.meta.filename': '__filename',
      },
      banner: { js: "const __bahi_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
    },
    preload: {
      ...common,
      entryPoints: [path.join(root, 'src/preload/index.ts')],
      outfile: path.join(outDir, 'preload/index.cjs'),
    },
  };
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
