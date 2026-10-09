#!/usr/bin/env node
// Production build: out/main/index.cjs + out/main/core-worker.cjs + out/preload/index.cjs (esbuild)
// and out/renderer (Vite).
//
//   node scripts/build.mjs          production build (minified, no source maps)
//   node scripts/build.mjs --dev    unminified main/preload with linked source maps (debugging)
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electronBuildOptions, forbiddenPreloadRequires, forbiddenWorkerRequires, outDir, root, viteConfigFile } from './build-config.mjs';

const mode = process.argv.includes('--dev') ? 'development' : 'production';

async function main() {
  const started = performance.now();
  process.env.NODE_ENV = 'production'; // the renderer is always a production build

  console.log(`\n▸ Cleaning ${path.relative(root, outDir)}/`);
  await rm(outDir, { recursive: true, force: true });

  console.log(`▸ Bundling main + core worker + preload (${mode})`);
  const opts = electronBuildOptions(mode);
  await Promise.all([esbuild(opts.main), esbuild(opts.coreWorker), esbuild(opts.preload)]);

  const preloadFile = path.join(outDir, 'preload/index.cjs');
  const bad = forbiddenPreloadRequires(readFileSync(preloadFile, 'utf8'));
  if (bad.length > 0) {
    throw new Error(`Preload bundle requires modules unavailable in a sandboxed preload: ${bad.join(', ')}`);
  }

  const workerFile = path.join(outDir, 'main/core-worker.cjs');
  const badWorker = forbiddenWorkerRequires(readFileSync(workerFile, 'utf8'));
  if (badWorker.length > 0) {
    throw new Error(`Core worker bundle requires modules unavailable on a worker thread: ${badWorker.join(', ')}`);
  }

  console.log('▸ Building renderer (Vite)');
  await viteBuild({ configFile: viteConfigFile, mode: 'production', logLevel: 'info' });

  const expected = ['main/index.cjs', 'main/core-worker.cjs', 'preload/index.cjs', 'renderer/index.html'];
  const missing = expected.filter((f) => !existsSync(path.join(outDir, f)));
  if (missing.length > 0) throw new Error(`Build output missing: ${missing.join(', ')}`);

  console.log(`\n✔ Build complete in ${((performance.now() - started) / 1000).toFixed(1)}s → ${path.relative(root, outDir)}/`);
}

main().catch((err) => {
  console.error('\n✖ Build failed');
  if (err && err.message) console.error(err.message);
  process.exitCode = 1;
});
