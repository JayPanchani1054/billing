#!/usr/bin/env node
// Development loop:
//   1. Vite dev server for the renderer (HMR) on http://127.0.0.1:5173
//   2. esbuild watch for main, the core worker and preload (unminified, linked source maps)
//   3. Electron, started once all three bundles exist and restarted whenever one of them changes
// Ctrl+C (or closing the app window) shuts everything down cleanly.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { context } from 'esbuild';
import { createServer } from 'vite';
import { DEV_HOST, DEV_PORT, electronBuildOptions, forbiddenPreloadRequires, forbiddenWorkerRequires, root, viteConfigFile } from './build-config.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
/** The `electron` npm package exports the path to the Electron binary when required from Node. */
const electronBinary = /** @type {string} */ (require('electron'));

/** @type {import('node:child_process').ChildProcess | null} */
let electron = null;
let expectedExit = false;
let shuttingDown = false;
/** @type {NodeJS.Timeout | null} */
let restartTimer = null;
const ready = { main: false, coreWorker: false, preload: false };
/** @type {import('esbuild').BuildContext[]} */
const contexts = [];
/** @type {import('vite').ViteDevServer | null} */
let vite = null;
let devUrl = `http://${DEV_HOST}:${DEV_PORT}/`;

function log(message) {
  console.log(`\x1b[36m[dev]\x1b[0m ${message}`);
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    // Electron spawns GPU/renderer helpers; /T takes the whole tree down.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

function startElectron() {
  // PEVQORI_STRICT_INPUT: route inputs with keys the schema does not declare fail with VALIDATION in
  // development (src/core/api/dispatch.ts › setStrictRouteInput), so renderer typos surface at once.
  const env = { ...process.env, NODE_ENV: 'development', PEVQORI_DEV_SERVER_URL: devUrl, PEVQORI_STRICT_INPUT: '1' };
  // Some shells/IDEs export this; it would make Electron behave like plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  log('starting Electron');
  expectedExit = false;
  const child = spawn(electronBinary, ['.'], { cwd: root, stdio: 'inherit', env, windowsHide: false });
  electron = child;
  child.on('exit', (code, signal) => {
    if (electron === child) electron = null;
    if (expectedExit || shuttingDown) return;
    log(`Electron exited (${signal ?? code ?? 0}); stopping the dev server`);
    void shutdown(typeof code === 'number' ? code : 0);
  });
}

async function restartElectron() {
  const current = electron;
  if (current) {
    expectedExit = true;
    const exited = new Promise((resolve) => current.once('exit', resolve));
    killTree(current);
    await exited;
  }
  if (!shuttingDown) startElectron();
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartElectron();
  }, 150);
}

/** esbuild plugin: start/restart Electron after successful rebuilds of main, the core worker or preload. */
function onRebuild(name) {
  return {
    name: `pevqori-dev-${name}`,
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) {
          log(`${name} build failed — keeping the current Electron session`);
          return;
        }
        if (name === 'coreWorker') {
          const file = path.join(root, 'out/main/core-worker.cjs');
          const bad = forbiddenWorkerRequires(readFileSync(file, 'utf8'));
          if (bad.length > 0) {
            log(`core worker requires modules unavailable on a worker thread: ${bad.join(', ')}`);
            return;
          }
        }
        if (name === 'preload') {
          const file = path.join(root, 'out/preload/index.cjs');
          const bad = forbiddenPreloadRequires(readFileSync(file, 'utf8'));
          if (bad.length > 0) {
            log(`preload requires modules unavailable in a sandboxed preload: ${bad.join(', ')}`);
            return;
          }
        }
        ready[name] = true;
        if (!ready.main || !ready.coreWorker || !ready.preload) return;
        if (electron) log(`${name} rebuilt — restarting Electron`);
        scheduleRestart();
      });
    },
  };
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  killTree(electron);
  await Promise.allSettled(contexts.map((ctx) => ctx.dispose()));
  if (vite) await vite.close().catch(() => undefined);
  process.exit(code);
}

async function main() {
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  vite = await createServer({
    configFile: viteConfigFile,
    mode: 'development',
    server: { host: DEV_HOST, port: DEV_PORT, strictPort: true },
  });
  await vite.listen();
  devUrl = vite.resolvedUrls?.local?.[0] ?? devUrl;
  vite.printUrls();

  const opts = electronBuildOptions('development');
  for (const name of /** @type {const} */ (['main', 'coreWorker', 'preload'])) {
    const ctx = await context({ ...opts[name], plugins: [onRebuild(name)] });
    contexts.push(ctx);
    await ctx.watch();
  }
  log('watching src/main (incl. the core worker), src/preload, src/core and src/shared — Ctrl+C to stop');
}

main().catch(async (err) => {
  console.error('[dev] failed to start:', err && err.message ? err.message : err);
  await shutdown(1);
});
