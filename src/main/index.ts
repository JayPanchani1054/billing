/**
 * Electron main-process entry (bundled to out/main/index.cjs by scripts/build.mjs).
 *
 * Boot order matters:
 *   1. before 'ready': path overrides, single-instance lock, sandbox, privileged schemes, global guards
 *   2. on 'ready':     session hardening, app:// protocol, core runtime, IPC, menu, main window
 *   3. on quit:        windows close (unsaved-work prompt) → runtime.shutdown() → exit
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme, protocol, session, shell } from 'electron';
import { APP_ID, APP_NAME } from '../shared/constants.ts';
import { createRuntime } from '../core/app/runtime.ts';
import { chosenFolders } from './user-choices.ts';
import type { Runtime } from '../core/app/runtime.ts';
import { absoluteEnvPath, APP_START_URL, bakedVersion, bundlePaths, resolveDevServer } from './config.ts';
import { registerIpc } from './ipc.ts';
import { describeError, log, setLogSink } from './log.ts';
import { buildApplicationMenu } from './menu.ts';
import { createNativeHandler } from './native.ts';
import { createPrefsStore, isThemeMode } from './prefs.ts';
import { createPrintService } from './print.ts';
import { PRIVILEGED_SCHEMES, registerAppProtocol } from './protocol.ts';
import { contentSecurityPolicy, hardenAppSession, hardenWebContents } from './security.ts';
import { createWindowManager } from './window.ts';
import type { WindowManager } from './window.ts';

const isE2E = process.env.BAHI_E2E === '1';
const dev = resolveDevServer(process.env.BAHI_DEV_SERVER_URL, app.isPackaged);
if (process.env.BAHI_DEV_SERVER_URL && !dev) {
  log('warn', 'Ignoring BAHI_DEV_SERVER_URL (only loopback http URLs are accepted, and never in packaged builds)');
}
if (!app.isPackaged) process.setSourceMapsEnabled(true);

let runtime: Runtime | null = null;
let windows: WindowManager | null = null;
let shutdownState: 'idle' | 'running' | 'done' = 'idle';

// ───────────────────────────── crash safety ─────────────────────────────

let lastErrorBoxAt = 0;
let errorBoxes = 0;

function reportFatal(kind: string, err: unknown): void {
  log('error', kind, describeError(err));
  if (isE2E || !app.isReady()) {
    if (!app.isReady()) console.error(`[bahi] ${kind}:`, err);
    return;
  }
  const now = Date.now();
  if (now - lastErrorBoxAt < 10_000 || errorBoxes >= 3) return; // never spam modal boxes
  lastErrorBoxAt = now;
  errorBoxes++;
  dialog.showErrorBox(
    `${APP_NAME} — unexpected error`,
    'Something went wrong inside Bahi ERP. Your saved data is safe.\n\n' +
      'If the problem continues, restart the app. Technical details were written to the log file ' +
      '(Help › Open Logs Folder).',
  );
}

process.on('uncaughtException', (err) => reportFatal('Uncaught exception in main process', err));
process.on('unhandledRejection', (reason) => reportFatal('Unhandled promise rejection in main process', reason));

// ───────────────────────────── pre-ready setup ─────────────────────────────

/**
 * Unpackaged (dev / E2E) runs use a separate profile and default data folder so a developer machine
 * never touches the installed app's settings or company data by accident.
 */
const PROFILE_NAME = app.isPackaged ? APP_NAME : `${APP_NAME} Dev`;

function applyPathOverrides(): void {
  // `electron out/main/index.cjs` (used by E2E) has no package.json next to it → name would be "Electron".
  if (app.getName() !== APP_NAME) app.setName(APP_NAME);
  const userData = absoluteEnvPath(process.env.BAHI_USER_DATA);
  if (userData) {
    fs.mkdirSync(userData, { recursive: true });
    app.setPath('userData', userData);
  } else if (!app.isPackaged) {
    app.setPath('userData', path.join(app.getPath('appData'), PROFILE_NAME));
  }
  app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
}

applyPathOverrides();
app.setAppUserModelId(APP_ID);
app.enableSandbox();
if (process.env.BAHI_DISABLE_GPU === '1') app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES);

// The lock is keyed on the userData directory, so E2E runs with their own BAHI_USER_DATA never collide.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

// ───────────────────────────── lifecycle ─────────────────────────────

function appVersion(): string {
  return app.isPackaged ? app.getVersion() : (bakedVersion() ?? app.getVersion());
}

function requestQuit(options: { relaunch: boolean }): void {
  windows?.allowCloseWithoutPrompt();
  if (options.relaunch) app.relaunch();
  app.quit();
}

function showAbout(): void {
  const parent = windows?.getMainWindow() ?? null;
  const box = {
    type: 'info' as const,
    title: `About ${APP_NAME}`,
    message: APP_NAME,
    detail:
      `Version ${appVersion()}\n` +
      'Offline-first GST accounting, invoicing and inventory.\n\n' +
      `Electron ${process.versions.electron ?? '?'} · Chromium ${process.versions.chrome ?? '?'} · Node ${process.versions.node}\n` +
      `© ${new Date().getFullYear()} Bahi ERP`,
    buttons: ['OK'],
    noLink: true,
  };
  void (parent ? dialog.showMessageBox(parent, box) : dialog.showMessageBox(box));
}

function openLogsFolder(): void {
  const dir = app.getPath('logs');
  fs.mkdirSync(dir, { recursive: true });
  void shell.openPath(dir).then((error) => {
    if (error) log('warn', 'Could not open the logs folder', { error });
  });
}

/** The Documents folder, or the home folder on profiles where Windows/XDG cannot resolve it. */
function documentsDir(): string {
  try {
    return app.getPath('documents');
  } catch {
    return app.getPath('home');
  }
}

function bootRuntime(): Runtime | null {
  try {
    const dataDirOverride = absoluteEnvPath(process.env.BAHI_DATA_DIR);
    return createRuntime({
      userDataDir: app.getPath('userData'),
      defaultDataDir: dataDirOverride ?? path.join(documentsDir(), PROFILE_NAME),
      appVersion: appVersion(),
      logDir: app.getPath('logs'),
      consoleLog: !app.isPackaged,
      // Only folders picked in the native folder dialog may become the data folder.
      authorizeDataDir: (absPath) => chosenFolders.has(absPath),
    });
  } catch (err) {
    log('error', 'Core runtime failed to start', describeError(err));
    if (!isE2E) {
      dialog.showErrorBox(
        `${APP_NAME} could not start`,
        'The accounting engine failed to start. Your data has not been changed.\n\n' +
          `Details were written to the log folder:\n${app.getPath('logs')}`,
      );
    }
    return null;
  }
}

function initialThemeFrom(rt: Runtime): 'system' | 'light' | 'dark' {
  try {
    const mode = rt.getTheme();
    return isThemeMode(mode) ? mode : 'system';
  } catch {
    return 'system';
  }
}

function initialise(): void {
  const csp = contentSecurityPolicy(dev);
  hardenAppSession(session.defaultSession, dev);
  registerAppProtocol(protocol, bundlePaths().renderer, csp);

  const rt = bootRuntime();
  if (!rt) {
    app.exit(1);
    return;
  }
  runtime = rt;
  // The runtime mirrors to the console itself in unpackaged runs (consoleLog), so don't double-print.
  setLogSink((level, message, meta) => rt.app.log(level, message, meta), { mirrorToConsole: false });
  nativeTheme.themeSource = initialThemeFrom(rt);
  const prefs = createPrefsStore(app.getPath('userData'));
  log('info', `${APP_NAME} ${appVersion()} starting`, {
    electron: process.versions.electron,
    packaged: app.isPackaged,
    dev: dev !== null,
    e2e: isE2E,
  });

  const wm = createWindowManager({
    userDataDir: app.getPath('userData'),
    startUrl: dev ? dev.url : APP_START_URL,
    prefs,
    isPackaged: app.isPackaged,
    isE2E,
  });
  windows = wm;

  const native = createNativeHandler({
    runtime: rt,
    windows: wm,
    print: createPrintService(),
    appVersion: appVersion(),
    paths: { userData: app.getPath('userData'), logs: app.getPath('logs'), documents: documentsDir() },
    requestQuit,
  });
  registerIpc({ runtime: rt, native, windows: wm, dev });

  const focusedContents = () => (BrowserWindow.getFocusedWindow() ?? wm.getMainWindow())?.webContents ?? null;
  Menu.setApplicationMenu(
    buildApplicationMenu({
      isPackaged: app.isPackaged,
      command: (id) => {
        const contents = focusedContents();
        if (contents && wm.isAppWebContents(contents)) wm.send(contents, 'command', { id });
      },
      zoom: (direction) => {
        const contents = focusedContents();
        if (contents) wm.stepZoom(contents, direction);
      },
      toggleFullScreen: () => {
        const win = BrowserWindow.getFocusedWindow() ?? wm.getMainWindow();
        if (win) win.setFullScreen(!win.isFullScreen());
      },
      showAbout,
      openLogsFolder,
    }),
  );

  nativeTheme.on('updated', () => {
    wm.syncBackground();
    wm.broadcast('theme-changed', { dark: nativeTheme.shouldUseDarkColors });
  });

  wm.createMainWindow();
}

function start(): void {
  // Guards for every WebContents ever created (main window, print windows, devtools).
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, dev));

  app.on('second-instance', () => windows?.focusMainWindow());

  app.on('window-all-closed', () => app.quit());

  app.on('activate', () => {
    if (windows && BrowserWindow.getAllWindows().length === 0) windows.createMainWindow();
  });

  app.on('child-process-gone', (_event, details: { type?: string; reason?: string; exitCode?: number }) => {
    if (details.reason !== 'clean-exit') log('warn', 'Child process gone', { type: details.type, reason: details.reason, exitCode: details.exitCode });
  });

  // Close the open company cleanly (checkpoint WAL, release locks) before the process exits.
  app.on('will-quit', (event) => {
    if (shutdownState === 'done' || !runtime) return;
    event.preventDefault();
    if (shutdownState === 'running') return;
    shutdownState = 'running';
    const rt = runtime;
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 8_000));
    void Promise.race([rt.shutdown(), timeout])
      .catch((err: unknown) => log('error', 'Shutdown failed', describeError(err)))
      .finally(() => {
        shutdownState = 'done';
        app.quit();
      });
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      windows?.allowCloseWithoutPrompt();
      app.quit();
    });
  }

  app
    .whenReady()
    .then(() => initialise())
    .catch((err: unknown) => {
      reportFatal('Startup failed', err);
      app.exit(1);
    });
}
