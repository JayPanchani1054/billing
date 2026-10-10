/**
 * Electron main-process entry (bundled to out/main/index.cjs by scripts/build.mjs).
 *
 * Boot order matters:
 *   1. before 'ready': path overrides, single-instance lock, settings carry-over from a pre-rename
 *                      installation (legacyUserData.ts), sandbox, privileged schemes, global guards
 *   2. on 'ready':     session hardening, app:// protocol, core worker (started, awaited), IPC, menu,
 *                      main window
 *   3. on quit:        windows close (unsaved-work prompt) → 'will-quit' → core shutdown (bounded) →
 *                      before-exit hooks (a downloaded update's installer) → app.exit (quit.ts)
 *
 * In-app updates (updates/): the service is created on 'ready' but loads electron-updater (a separate
 * bundle, out/main/updater.cjs) only when the user checks or a weekly check is due — never on start-up.
 *
 * The accounting core does not run on this thread: it runs on a worker thread (core-worker.ts) behind
 * a proxy with the same Runtime interface (core-proxy.ts), so heavy routes never freeze the windows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme, protocol, safeStorage, session, shell } from 'electron';
import { APP_ID, APP_NAME } from '../shared/constants.ts';
import { CORE_RESTARTED_COMMAND } from '../shared/bridge.ts';
import { loadAnchorKeyForWorker } from './anchor-key.ts';
import { onUserChoice } from './user-choices.ts';
import { absoluteEnvPath, APP_START_URL, bakedVersion, bundlePaths, resolveDevServer } from './config.ts';
import { registerIpc } from './ipc.ts';
import { describeError, log, setLogSink } from './log.ts';
import { createCoreProxy, nodeWorkerSpawner, workerScriptPath } from './core-proxy.ts';
import type { CoreProxy } from './core-proxy.ts';
import { buildApplicationMenu } from './menu.ts';
import { createNativeHandler } from './native.ts';
import { createPrefsStore, isThemeMode } from './prefs.ts';
import { createPrintService } from './print.ts';
import { PRIVILEGED_SCHEMES, registerAppProtocol } from './protocol.ts';
import { createQuitController, QUIT_DEADLINE_MS } from './quit.ts';
import { loadUpdaterBundle } from './updates/loader.ts';
import { policyFilePath, readPolicyFile, resolveUpdatePolicy } from './updates/policy.ts';
import { createUpdateService, menuCheckMessage, UPDATER_PARTITION } from './updates/service.ts';
import type { UpdateService } from './updates/service.ts';
import { contentSecurityPolicy, hardenAppSession, hardenWebContents } from './security.ts';
import { evaluateSmoke, SMOKE_SCRIPT, SMOKE_TIMEOUT_MS } from './smoke.ts';
import type { SmokeVerdict } from './smoke.ts';
import { createWindowManager } from './window.ts';
import { migrateLegacyUserData } from './legacyUserData.ts';
import type { LegacyMigrationResult } from './legacyUserData.ts';
import type { WindowManager } from './window.ts';

const isE2E = process.env.PEVQORI_E2E === '1';
/** Packaged-app smoke test (CI): check the bridge → core path once, then quit with 0/1 (smoke.ts). */
const isSmoke = process.env.PEVQORI_SMOKE_TEST === '1';
/** No modal dialogs: automated runs must never block on a prompt nobody can answer. */
const unattended = isE2E || isSmoke;
const dev = resolveDevServer(process.env.PEVQORI_DEV_SERVER_URL, app.isPackaged);
if (process.env.PEVQORI_DEV_SERVER_URL && !dev) {
  log('warn', 'Ignoring PEVQORI_DEV_SERVER_URL (only loopback http URLs are accepted, and never in packaged builds)');
}
if (!app.isPackaged) process.setSourceMapsEnabled(true);

/** The core proxy, from the moment the worker is spawned (so quitting during start-up stops it too). */
let core: CoreProxy | null = null;
let windows: WindowManager | null = null;
let updates: UpdateService | null = null;
/**
 * Unsaved-work flags as the renderers last reported them (mirrors the window manager's own map, which it
 * does not expose): read by "Restart to update" to ask before quitting. Reset on navigation / crash /
 * destruction exactly like window.ts resets its copy.
 */
const unsaved = new Map<number, boolean>();

const quit = createQuitController({
  shutdown: () => (core ? core.shutdown() : Promise.resolve()),
  exit: (code) => app.exit(code),
  log,
  deadlineMs: QUIT_DEADLINE_MS,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

// ───────────────────────────── crash safety ─────────────────────────────

let lastErrorBoxAt = 0;
let errorBoxes = 0;

function reportFatal(kind: string, err: unknown): void {
  log('error', kind, describeError(err));
  if (unattended || !app.isReady()) {
    if (!app.isReady()) console.error(`[pevqori] ${kind}:`, err);
    return;
  }
  const now = Date.now();
  if (now - lastErrorBoxAt < 10_000 || errorBoxes >= 3) return; // never spam modal boxes
  lastErrorBoxAt = now;
  errorBoxes++;
  dialog.showErrorBox(
    `${APP_NAME} — unexpected error`,
    'Something went wrong inside Pevqori. Your saved data is safe.\n\n' +
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
  const userData = absoluteEnvPath(process.env.PEVQORI_USER_DATA);
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
if (process.env.PEVQORI_DISABLE_GPU === '1') app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES);

/** Outcome of carryOverLegacySettings, logged once the log file exists (initialise). */
let legacySettings: LegacyMigrationResult | null = null;

// The lock is keyed on the userData directory, so E2E runs with their own PEVQORI_USER_DATA never collide.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  carryOverLegacySettings();
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
      `© ${new Date().getFullYear()} Pevqori`,
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

/** PEVQORI_DATA_DIR (tests / smoke runs), else <Documents>/<profile name>. */
function dataDirOverride(): string | null {
  return absoluteEnvPath(process.env.PEVQORI_DATA_DIR);
}
function defaultDataDir(): string {
  return dataDirOverride() ?? path.join(documentsDir(), PROFILE_NAME);
}

/**
 * First launch after the product rename: copy the settings of the installation made by an older build
 * (legacyUserData.ts). Runs before 'ready' — before Chromium reads the userData folder's "Local State"
 * (the safeStorage sealing key on Windows) and before anything of ours reads userData — and after the
 * single-instance lock, so two first launches never copy at once. Skipped when a test / smoke run
 * points userData or the data folder somewhere explicit. Never stops the app from starting.
 */
function carryOverLegacySettings(): void {
  if (dataDirOverride() || absoluteEnvPath(process.env.PEVQORI_USER_DATA)) return;
  try {
    legacySettings = migrateLegacyUserData({
      appDataDir: app.getPath('appData'),
      userDataDir: app.getPath('userData'),
      documentsDir: documentsDir(),
      defaultDataDir: defaultDataDir(),
      dev: !app.isPackaged,
    });
    if (legacySettings.status === 'migrated') console.log(`[pevqori] settings of the earlier installation carried over from ${legacySettings.from}`);
  } catch (err) {
    log('warn', 'Settings of the earlier installation could not be carried over', describeError(err));
  }
}

/** Record the carry-over in the log file (the log file only exists once the core runs). */
function logLegacySettings(): void {
  const r = legacySettings;
  if (!r || r.status !== 'migrated') return;
  log('info', 'Settings of the earlier installation were carried over', { from: r.from, copied: r.copied, dataDir: r.dataDir });
  if (r.skipped.length > 0) {
    log('warn', 'Some settings of the earlier installation were not carried over; edit-log check-points start afresh', { skipped: r.skipped });
  }
}

/** The Documents folder, or the home folder on profiles where Windows/XDG cannot resolve it. */
function documentsDir(): string {
  try {
    return app.getPath('documents');
  } catch {
    return app.getPath('home');
  }
}

/** A worker-side fault (uncaught exception inside the core) reported like a main-process one. */
function faultError(error: { name: string; message: string; stack?: string }): Error {
  const err = new Error(error.message);
  err.name = error.name;
  if (error.stack) err.stack = error.stack;
  return err;
}

/**
 * Start the core on its worker thread and wait until it is ready. The path checks the core used to get
 * as callbacks (authorizeDataDir, authorizePath) are answered inside the worker from a mirror of the
 * user's dialog choices (user-choices.ts → authorizeChoice), so they never need a synchronous round
 * trip to this thread.
 */
async function bootRuntime(): Promise<CoreProxy | null> {
  // The edit-log anchor key is sealed with the OS here (safeStorage exists only on this thread) and
  // handed to the worker; see anchor-key.ts and docs/SECURITY.md T4.
  const auditAnchorKey = loadAnchorKeyForWorker(app.getPath('userData'), safeStorage, log);
  const proxy = createCoreProxy({
    appVersion: appVersion(),
    spawn: nodeWorkerSpawner(workerScriptPath(__dirname), {
      userDataDir: app.getPath('userData'),
      defaultDataDir: defaultDataDir(),
      appVersion: appVersion(),
      logDir: app.getPath('logs'),
      consoleLog: !app.isPackaged,
      ...(auditAnchorKey ? { auditAnchorKey } : {}),
    }),
    log,
    onRestarted: () => windows?.broadcast('command', { id: CORE_RESTARTED_COMMAND }),
    onFault: (kind, error) => reportFatal(kind, faultError(error)),
  });
  core = proxy;
  onUserChoice((choice) => proxy.authorizeChoice(choice));
  try {
    await proxy.start();
    return proxy;
  } catch (err) {
    log('error', 'Core runtime failed to start', describeError(err));
    if (!unattended) {
      dialog.showErrorBox(
        `${APP_NAME} could not start`,
        'The accounting engine failed to start. Your data has not been changed.\n\n' +
          `Details were written to the log folder:\n${app.getPath('logs')}`,
      );
    }
    return null;
  }
}

function initialThemeFrom(rt: CoreProxy): 'system' | 'light' | 'dark' {
  try {
    const mode = rt.getTheme();
    return isThemeMode(mode) ? mode : 'system';
  } catch {
    return 'system';
  }
}

async function initialise(): Promise<void> {
  const csp = contentSecurityPolicy(dev);
  hardenAppSession(session.defaultSession, dev);
  registerAppProtocol(protocol, bundlePaths().renderer, csp);

  const rt = await bootRuntime();
  if (!rt) {
    app.exit(1);
    return;
  }
  // The runtime mirrors to the console itself in unpackaged runs (consoleLog), so don't double-print.
  setLogSink((level, message, meta) => rt.app.log(level, message, meta), { mirrorToConsole: false });
  nativeTheme.themeSource = initialThemeFrom(rt);
  const prefs = createPrefsStore(app.getPath('userData'));
  log('info', `${APP_NAME} ${appVersion()} starting`, {
    electron: process.versions.electron,
    packaged: app.isPackaged,
    dev: dev !== null,
    e2e: isE2E,
    smoke: isSmoke,
  });
  logLegacySettings();

  const wm = createWindowManager({
    userDataDir: app.getPath('userData'),
    startUrl: dev ? dev.url : APP_START_URL,
    prefs,
    isPackaged: app.isPackaged,
    isE2E: unattended,
  });
  windows = wm;

  const updateService = createUpdates(prefs, wm);
  updates = updateService;
  quit.onBeforeExit(() => updateService.beforeExit());

  const native = createNativeHandler({
    runtime: rt,
    windows: wm,
    print: createPrintService(),
    appVersion: appVersion(),
    paths: { userData: app.getPath('userData'), logs: app.getPath('logs'), documents: documentsDir() },
    requestQuit,
    updates: updateService,
  });
  // The IPC layer reports unsaved work to the window manager; keep our mirror of it on the way through.
  const ipcWindows: WindowManager = {
    ...wm,
    setDirty(contents, dirty) {
      if (wm.isAppWebContents(contents)) unsaved.set(contents.id, dirty);
      wm.setDirty(contents, dirty);
    },
  };
  registerIpc({ runtime: rt, native, windows: ipcWindows, dev });

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
      checkForUpdates: () => checkForUpdatesFromMenu(updateService, wm),
    }),
  );

  nativeTheme.on('updated', () => {
    wm.syncBackground();
    wm.broadcast('theme-changed', { dark: nativeTheme.shouldUseDarkColors });
  });

  const win = wm.createMainWindow();
  watchUpdateQuit(win);
  if (isSmoke) runSmokeTest(win);
  // Weekly mode only arms a timer here (first check 2 minutes later); manual / off do nothing at all.
  updateService.start();
}

// ───────────────────────────── in-app updates ─────────────────────────────

/** The update service, wired to Electron (updates/service.ts holds the rules and is unit-tested). */
function createUpdates(prefs: ReturnType<typeof createPrefsStore>, wm: WindowManager): UpdateService {
  // Read once at start-up: the machine policy file and the environment (a change needs a restart).
  const env = { ...process.env };
  const policyFile = readPolicyFile(policyFilePath(env, process.platform));
  const service = createUpdateService({
    currentVersion: appVersion(),
    policyFor: (userPref) => resolveUpdatePolicy({ env, policyFile, userPref, packaged: app.isPackaged }),
    prefs: {
      get: () => prefs.get().updates,
      set: (next) => prefs.update({ updates: next }),
    },
    loadUpdater: () => loadUpdaterBundle(__dirname),
    session: () => {
      // electron-updater makes every request through this partition; cache off, nothing persisted.
      const ses = session.fromPartition(UPDATER_PARTITION, { cache: false });
      return {
        onBeforeRequest: (allow) => ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allow(details.url) })),
        onBeforeRedirect: (listener) => ses.webRequest.onBeforeRedirect((details) => listener(details.url, details.redirectURL)),
        denyPermissions: () => {
          ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
          ses.setPermissionCheckHandler(() => false);
        },
      };
    },
    emit: (status) => wm.broadcast('update-status', status),
    log,
    now: () => new Date(),
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    hasUnsavedWork: () => [...unsaved.values()].some(Boolean),
    confirmDiscard: async () => {
      if (unattended) return false;
      const parent = wm.getMainWindow();
      const box = {
        type: 'warning' as const,
        title: APP_NAME,
        message: 'You have unsaved changes.',
        detail: 'If you restart Pevqori now to install the update, the changes on the open screen will be lost.',
        buttons: ['Discard changes and restart', 'Keep working'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const { response } = await (parent ? dialog.showMessageBox(parent, box) : dialog.showMessageBox(box));
      return response === 0;
    },
    // Deferred so the IPC reply reaches the renderer before the windows start closing.
    requestQuit: ({ skipPrompt }) =>
      setImmediate(() => {
        if (skipPrompt) requestQuit({ relaunch: false });
        else app.quit();
      }),
  });
  const p = service.status().policy;
  log('info', 'Updates', { mode: p.mode, source: p.source, locked: p.locked });
  return service;
}

/**
 * "Restart to update" quits through the normal close sequence. If a window refuses to close (the
 * unsaved-work prompt was answered "Keep working"), that quit is over: disarm the pending install so a
 * later, ordinary quit does not install and relaunch by surprise. Registered after window.ts's own close
 * guard, so `defaultPrevented` already reflects its decision.
 */
function watchUpdateQuit(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (event.defaultPrevented) updates?.quitCancelled();
  });
}

/** Help › Check for Updates… — runs the check and shows its outcome in a native box. */
function checkForUpdatesFromMenu(service: UpdateService, wm: WindowManager): void {
  void service.check().then(
    (status) => {
      if (unattended) return;
      const { message, detail } = menuCheckMessage(status);
      const box = { type: status.state === 'error' ? ('warning' as const) : ('info' as const), title: 'Check for Updates', message, detail, buttons: ['OK'], noLink: true };
      const parent = wm.getMainWindow();
      void (parent ? dialog.showMessageBox(parent, box) : dialog.showMessageBox(box));
    },
    (err: unknown) => log('warn', 'Updates: the menu check failed', describeError(err)),
  );
}

/** PEVQORI_SMOKE_TEST=1: once the window has loaded, call app.state through the real bridge, then quit. */
function runSmokeTest(win: BrowserWindow): void {
  let done = false;
  const finish = (verdict: SmokeVerdict): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    log(verdict.ok ? 'info' : 'error', `Smoke test ${verdict.ok ? 'passed' : 'failed'}: ${verdict.detail}`);
    quit.setExitCode(verdict.ok ? 0 : 1);
    requestQuit({ relaunch: false });
  };
  const timer = setTimeout(() => finish({ ok: false, detail: `no answer within ${SMOKE_TIMEOUT_MS / 1000} s` }), SMOKE_TIMEOUT_MS);
  const contents = win.webContents;
  contents.once('did-fail-load', (_event: unknown, errorCode: number, errorDescription: string) =>
    finish({ ok: false, detail: `the window failed to load (${errorCode} ${errorDescription})` }),
  );
  contents.once('did-finish-load', () => {
    contents.executeJavaScript(SMOKE_SCRIPT, true).then(
      (result: unknown) => finish(evaluateSmoke(result, appVersion())),
      (err: unknown) => finish({ ok: false, detail: `the bridge call failed: ${describeError(err).message}` }),
    );
  });
}

function start(): void {
  // Guards for every WebContents ever created (main window, print windows, devtools).
  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents, dev);
    const id = contents.id;
    contents.on('did-navigate', () => unsaved.delete(id));
    contents.on('render-process-gone', () => unsaved.delete(id));
    contents.once('destroyed', () => unsaved.delete(id));
  });

  app.on('second-instance', () => windows?.focusMainWindow());

  app.on('window-all-closed', () => app.quit());

  app.on('activate', () => {
    if (windows && BrowserWindow.getAllWindows().length === 0) watchUpdateQuit(windows.createMainWindow());
  });

  app.on('child-process-gone', (_event, details: { type?: string; reason?: string; exitCode?: number }) => {
    if (details.reason !== 'clean-exit') log('warn', 'Child process gone', { type: details.type, reason: details.reason, exitCode: details.exitCode });
  });

  // Close the open company cleanly before the process exits: the core shutdown runs the F12 automatic
  // backup (bounded at 20 s in core), checkpoints WAL and releases the lock; the proxy bounds it again
  // and terminates the worker; quit.ts then calls app.exit (hard deadline QUIT_DEADLINE_MS).
  app.on('before-quit', () => quit.onBeforeQuit());
  app.on('will-quit', (event) => quit.onWillQuit(event));

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      windows?.allowCloseWithoutPrompt();
      app.quit();
    });
  }

  app
    .whenReady()
    .then(initialise)
    .catch((err: unknown) => {
      reportFatal('Startup failed', err);
      app.exit(1);
    });
}
