/**
 * Core worker thread entry (bundled by scripts/build.mjs to out/main/core-worker.cjs).
 *
 * The whole accounting core — node:sqlite connections, the company lock, the session, every route
 * handler — runs here, on a node:worker_threads thread inside the Electron main process, so a slow
 * report, import, export or integrity check never freezes windows, menus or native dialogs (the main
 * thread only forwards IPC). The protocol is described in core-protocol.ts; main's side is
 * core-proxy.ts.
 *
 * This file must never import 'electron' (the build fails if it does): Electron's main-process API is
 * not available on worker threads. Anything that needs it (dialogs, windows) stays in main.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createRuntime } from '../core/app/runtime.ts';
import { announceReady, startCoreHost } from './core-host.ts';
import type { CoreWorkerInit, FromWorker } from './core-protocol.ts';

const port = parentPort;
if (!port) throw new Error('core-worker must run on a worker thread');

const init = workerData as CoreWorkerInit;
const post = (message: FromWorker, transfer?: ArrayBuffer[]): void => {
  if (transfer && transfer.length > 0) port.postMessage(message, transfer);
  else port.postMessage(message);
};

const host = startCoreHost({
  createRuntime: (authorizers) =>
    createRuntime({
      userDataDir: init.userDataDir,
      defaultDataDir: init.defaultDataDir,
      appVersion: init.appVersion,
      logDir: init.logDir,
      consoleLog: init.consoleLog,
      authorizeDataDir: authorizers.authorizeDataDir,
      authorizePath: authorizers.authorizePath,
      ...(init.auditAnchorKey ? { auditAnchorKey: init.auditAnchorKey } : {}),
    }),
  post,
  choices: init.choices,
});

if (host.runtime) {
  // Same policy the main process had: log, tell main (which may show the error box), keep serving.
  process.on('uncaughtException', (err) => host.fault('Uncaught exception in the core worker', err));
  process.on('unhandledRejection', (reason) => host.fault('Unhandled promise rejection in the core worker', reason));
  port.on('message', (message: unknown) => host.handle(message));
  announceReady(host, post);
}
// Otherwise 'startup-failed' was posted; with no message listener the thread simply ends.
