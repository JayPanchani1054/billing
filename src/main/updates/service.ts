/**
 * The in-app update service (main process only; docs/SECURITY.md §3.11 "Updates").
 *
 * No Electron import here: the updater library and its network session are reached through two small
 * ports (UpdaterPort, UpdaterSessionPort) that src/main/index.ts wires to electron-updater (loaded lazily
 * from out/main/updater.cjs) and to `session.fromPartition(UPDATER_PARTITION)`. That keeps every rule
 * below unit-testable with fakes (service.test.ts):
 *
 *  - Network silence: the updater module is loaded — and its session hardened — only by the first
 *    `check()` or `download()`, and never while the policy is 'off'. 'manual' (the default) checks only
 *    when the user asks; 'weekly' checks 2 minutes after start-up and then every 24 hours *if* the last
 *    successful check is 7+ days old (isDue). Nothing runs on the start-up path.
 *  - Allowlist: every request of the updater session (redirects included) must pass isAllowedUpdateUrl;
 *    everything else is cancelled and logged. Permission requests are denied; the HTTP cache is off.
 *    The library's per-install `x-user-staging-id` header is stripped from every request.
 *  - Library settings: autoDownload, autoInstallOnAppQuit, allowDowngrade and allowPrerelease off,
 *    disableWebInstaller on. Integrity is electron-updater's: sha512 from latest.yml for every download,
 *    plus the Authenticode publisher check when the build is signed. A failed check deletes the file.
 *  - Install: "Restart to update" quits through the normal close sequence; unsaved work is confirmed
 *    first (cancel = nothing happens and nothing stays armed). The installer is started exactly once by
 *    `beforeExit()`, which index.ts registers as a quit-controller before-exit hook (quit.ts) — the
 *    library's own install-on-quit is never used because quit.ts ends with app.exit (no 'quit' event).
 */
import { AppError } from '../../core/lib/errors.ts';
import type { UpdateMode, UpdatePolicy, UpdateStatus } from '../../shared/bridge.ts';
import type { LogLevel } from '../log.ts';
import { cleanVersion, isAllowedUpdateUrl, isDue, isNewerVersion, releaseNotesText, withoutIdentifyingHeaders } from './policy.ts';

/** electron-updater's own network session partition (electron-updater 6.x electronHttpExecutor NET_SESSION_NAME). */
export const UPDATER_PARTITION = 'electron-updater';
/** Weekly mode: first background check after start-up, then the re-check interval. */
export const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
export const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * How long the before-exit hook keeps the process alive after starting the installer. electron-updater
 * spawns it synchronously, but reports a failed spawn (EACCES / UNKNOWN) asynchronously and only then
 * retries through its elevation helper: exiting at once would close Pevqori with nothing installed and,
 * after "Restart to update", nothing to start it again. (quit.ts caps every async hook at 3 s.)
 */
export const INSTALL_GRACE_MS = 1_500;

export const MESSAGES = {
  notVerified: 'The download could not be verified and was deleted. Try again later; if it happens again, download the installer from the Pevqori releases page.',
  unreachable: 'Update server not reachable. Check the internet connection and try again.',
  blocked: 'The update was stopped because the update server sent Pevqori to an address it does not trust.',
  diskFull: 'There is not enough free disk space to download the update.',
  generic: 'Something went wrong while updating. Details were written to the log file (Help › Open Logs Folder).',
  noAnswer: 'The update check did not complete. Try again later.',
} as const;

/** What the service needs from electron-updater (adapter: updates/entry.ts). */
export interface UpdaterSettings {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  disableWebInstaller: boolean;
}
export interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug(message: string): void;
}
export interface UpdateOffer {
  version: string;
  releaseDate: string;
  releaseNotes: unknown;
  sizeBytes: number;
}
export interface UpdaterPort {
  configure(settings: UpdaterSettings, logger: UpdaterLogger): void;
  /** null when the library refused to check (e.g. not packaged). */
  check(): Promise<{ available: boolean; offer: UpdateOffer } | null>;
  download(onProgress: (p: { percent: number; bytesPerSecond: number }) => void): Promise<void>;
  /** Start the downloaded installer silently; `runAfter` relaunches Pevqori when it finishes. */
  quitAndInstall(runAfter: boolean): void;
}

/** The updater's own session (index.ts adapts Electron's Session). */
export interface UpdaterSessionPort {
  /** Every request: return true to let it through, false to cancel it. */
  onBeforeRequest(allow: (url: string) => boolean): void;
  /** Every request: the headers actually sent are `edit(headers)`. */
  onBeforeSendHeaders(edit: (headers: Record<string, string>) => Record<string, string>): void;
  onBeforeRedirect(listener: (from: string, to: string) => void): void;
  denyPermissions(): void;
}

export interface StoredUpdatePrefs {
  mode: 'manual' | 'weekly';
  lastCheck: string | null;
}

export interface UpdateServiceDeps {
  currentVersion: string;
  /** The effective policy for a stored user mode (environment, policy file and packaging are fixed at start-up). */
  policyFor(userMode: unknown): UpdatePolicy;
  prefs: { get(): StoredUpdatePrefs | undefined; set(next: StoredUpdatePrefs): void };
  /** Load electron-updater (out/main/updater.cjs). The ONLY way to the network; called lazily. */
  loadUpdater(): UpdaterPort;
  session(): UpdaterSessionPort;
  emit(status: UpdateStatus): void;
  log(level: LogLevel, message: string, meta?: unknown): void;
  now(): Date;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** True when an app window reports unsaved work. */
  hasUnsavedWork(): boolean;
  /** Ask "discard unsaved changes and restart?"; resolves true to go ahead. */
  confirmDiscard(): Promise<boolean>;
  /** Quit the app (skipPrompt: the unsaved-work question was already answered). */
  requestQuit(options: { skipPrompt: boolean }): void;
}

export interface UpdateService {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  install(when: 'now' | 'on-quit'): Promise<UpdateStatus>;
  setMode(mode: 'manual' | 'weekly'): UpdateStatus;
  /** Start the weekly schedule (if the mode is weekly). Never touches the network itself. */
  start(): void;
  stop(): void;
  /** The quit started by "Restart to update" was cancelled (a window refused to close): disarm. */
  quitCancelled(): void;
  /**
   * Quit-controller before-exit hook: start the installer if one is armed (at most once). Resolves after
   * INSTALL_GRACE_MS when it started one (immediately otherwise).
   */
  beforeExit(): Promise<void>;
  /** For tests and diagnostics. */
  readonly loaded: boolean;
}

/** Map an electron-updater / network error to a plain-language message. */
export function describeUpdateError(err: unknown): { message: string; retryable: boolean } {
  const e = (err ?? {}) as { code?: unknown; statusCode?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : String(err);
  const status = typeof e.statusCode === 'number' ? e.statusCode : 0;
  if (code === 'ERR_CHECKSUM_MISMATCH' || code === 'ERR_UPDATER_INVALID_SIGNATURE' || /checksum mismatch|not signed by the application owner|sha512/i.test(message)) {
    return { message: MESSAGES.notVerified, retryable: true };
  }
  if (/ERR_BLOCKED_BY_CLIENT/.test(message)) return { message: MESSAGES.blocked, retryable: false };
  if (code === 'ENOSPC' || /ENOSPC/.test(message)) return { message: MESSAGES.diskFull, retryable: true };
  if (
    code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
    code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
    code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
    code === 'ERR_UPDATER_INVALID_RELEASE_FEED' ||
    code === 'HTTP_ERROR_404' ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status >= 500 ||
    /net::ERR_|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)
  ) {
    return { message: MESSAGES.unreachable, retryable: true };
  }
  return { message: MESSAGES.generic, retryable: true };
}

/** Text of the native box shown after Help › Check for Updates… */
export function menuCheckMessage(status: UpdateStatus): { message: string; detail: string } {
  switch (status.state) {
    case 'unavailable':
      return { message: 'Updates are turned off.', detail: status.reason };
    case 'up-to-date':
      return { message: `Pevqori ${status.current} is up to date.`, detail: 'There is no newer version.' };
    case 'available':
      return { message: `Pevqori ${status.version} is available.`, detail: 'Open Utilities › About Pevqori to see what is new and download it.' };
    case 'ready':
      return { message: `Pevqori ${status.version} is ready to install.`, detail: 'Open Utilities › About Pevqori and choose Restart to update.' };
    case 'downloading':
      return { message: `Pevqori ${status.version} is downloading.`, detail: 'See Utilities › About Pevqori for progress.' };
    case 'error':
      return { message: 'Could not check for updates.', detail: status.message };
    default:
      return { message: 'Checking for updates…', detail: '' };
  }
}

function storedPrefs(raw: StoredUpdatePrefs | undefined): StoredUpdatePrefs {
  return { mode: raw?.mode === 'weekly' ? 'weekly' : 'manual', lastCheck: typeof raw?.lastCheck === 'string' ? raw.lastCheck : null };
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const current = deps.currentVersion;
  let prefs = storedPrefs(deps.prefs.get());
  let policy = deps.policyFor(prefs.mode);
  let updater: UpdaterPort | null = null;
  let offer: { version: string; releaseDate: string; notes: string; sizeBytes: number } | null = null;
  let downloaded = false;
  let pending: { runAfter: boolean } | null = null;
  let timer: unknown = null;
  let inFlight: Promise<UpdateStatus> | null = null;
  let status: UpdateStatus = initial();

  function initial(): UpdateStatus {
    if (policy.mode === 'off') return { state: 'unavailable', reason: policy.reason ?? 'Updates are turned off.', policy, current };
    return { state: 'idle', current, lastCheck: prefs.lastCheck, policy };
  }

  function set(next: UpdateStatus): UpdateStatus {
    status = next;
    try {
      deps.emit(next);
    } catch (err) {
      deps.log('warn', 'Updates: could not send the status to the window', { error: err });
    }
    return next;
  }

  function savePrefs(next: StoredUpdatePrefs): void {
    prefs = next;
    try {
      deps.prefs.set(next);
    } catch (err) {
      deps.log('warn', 'Updates: could not save the update preferences', { error: err });
    }
  }

  function ensureUpdater(): UpdaterPort {
    if (policy.mode === 'off') throw new AppError('FORBIDDEN', policy.reason ?? 'Updates are turned off.');
    if (updater) return updater;
    // Harden the session BEFORE the library exists, so not even its first request escapes the allowlist.
    const ses = deps.session();
    ses.denyPermissions();
    ses.onBeforeRequest((url) => {
      const ok = isAllowedUpdateUrl(url);
      if (!ok) deps.log('warn', 'Updates: blocked a request outside the update allowlist', { target: safeOrigin(url) });
      return ok;
    });
    // No per-install identifier leaves this computer (docs/SECURITY.md "What is sent").
    ses.onBeforeSendHeaders(withoutIdentifyingHeaders);
    ses.onBeforeRedirect((from, to) => deps.log('info', 'Updates: redirect', { from: safeOrigin(from), to: safeOrigin(to) }));
    const loaded = deps.loadUpdater();
    loaded.configure(
      { autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false, disableWebInstaller: true },
      {
        info: (m) => deps.log('info', `Updater: ${String(m)}`),
        warn: (m) => deps.log('warn', `Updater: ${String(m)}`),
        error: (m) => deps.log('error', `Updater: ${String(m)}`),
        debug: () => undefined,
      },
    );
    updater = loaded;
    deps.log('info', 'Updates: updater loaded', { mode: policy.mode, source: policy.source });
    return loaded;
  }

  function fail(err: unknown, what: string): UpdateStatus {
    const { message, retryable } = describeUpdateError(err);
    deps.log('warn', `Updates: ${what} failed`, { error: err instanceof Error ? { name: err.name, message: err.message } : String(err) });
    return set({ state: 'error', current, message, retryable, policy });
  }

  async function runCheck(): Promise<UpdateStatus> {
    set({ state: 'checking', current, policy });
    try {
      const u = ensureUpdater();
      const result = await u.check();
      if (!result) return set({ state: 'error', current, message: MESSAGES.noAnswer, retryable: true, policy });
      const checkedAt = deps.now().toISOString();
      savePrefs({ ...prefs, lastCheck: checkedAt });
      const version = cleanVersion(result.offer.version);
      if (!result.available || !version || !isNewerVersion(version, current)) {
        offer = null;
        downloaded = false;
        return set({ state: 'up-to-date', current, checkedAt, policy });
      }
      const sizeBytes = Number.isFinite(result.offer.sizeBytes) && result.offer.sizeBytes > 0 ? Math.round(result.offer.sizeBytes) : 0;
      const releaseDate = typeof result.offer.releaseDate === 'string' && Number.isFinite(Date.parse(result.offer.releaseDate)) ? result.offer.releaseDate : '';
      if (!offer || offer.version !== version) downloaded = false;
      offer = { version, releaseDate, notes: releaseNotesText(result.offer.releaseNotes), sizeBytes };
      if (downloaded) return set({ state: 'ready', current, version, notes: offer.notes, installOnQuit: pending !== null, policy });
      return set({ state: 'available', current, version, releaseDate, notes: offer.notes, sizeBytes, policy });
    } catch (err) {
      return fail(err, 'check');
    }
  }

  function check(): Promise<UpdateStatus> {
    if (policy.mode === 'off') return Promise.resolve(set(initial()));
    if (inFlight) return inFlight;
    if (status.state === 'ready' || status.state === 'downloading') return Promise.resolve(status);
    inFlight = runCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function runDownload(o: NonNullable<typeof offer>): Promise<UpdateStatus> {
    set({ state: 'downloading', current, version: o.version, percent: 0, bytesPerSecond: 0, policy });
    let lastPercent = 0;
    try {
      const u = ensureUpdater();
      await u.download((p) => {
        const percent = Number.isFinite(p.percent) ? Math.max(0, Math.min(100, p.percent)) : 0;
        if (Math.floor(percent) === Math.floor(lastPercent) && percent < 100) return; // at most ~100 events
        lastPercent = percent;
        set({ state: 'downloading', current, version: o.version, percent, bytesPerSecond: Number.isFinite(p.bytesPerSecond) ? Math.max(0, p.bytesPerSecond) : 0, policy });
      });
      downloaded = true;
      deps.log('info', 'Updates: download verified and ready', { version: o.version });
      return set({ state: 'ready', current, version: o.version, notes: o.notes, installOnQuit: false, policy });
    } catch (err) {
      downloaded = false;
      return fail(err, 'download');
    }
  }

  function download(): Promise<UpdateStatus> {
    if (policy.mode === 'off') return Promise.resolve(set(initial()));
    if (inFlight) return inFlight;
    if (status.state === 'ready') return Promise.resolve(status);
    const o = offer;
    if (!o || (status.state !== 'available' && status.state !== 'error')) {
      return Promise.reject(new AppError('BUSINESS_RULE', 'There is no update to download. Check for updates first.'));
    }
    inFlight = runDownload(o).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function readyStatus(installOnQuit: boolean): UpdateStatus {
    const o = offer;
    if (!o || status.state !== 'ready') return status;
    return { state: 'ready', current, version: o.version, notes: o.notes, installOnQuit, policy };
  }

  async function install(when: 'now' | 'on-quit'): Promise<UpdateStatus> {
    if (status.state !== 'ready' || !updater || !downloaded) {
      throw new AppError('BUSINESS_RULE', 'There is no downloaded update to install.');
    }
    if (when === 'on-quit') {
      pending = { runAfter: false };
      deps.log('info', 'Updates: will install when Pevqori quits');
      return set(readyStatus(true));
    }
    let skipPrompt = false;
    if (deps.hasUnsavedWork()) {
      const go = await deps.confirmDiscard();
      if (!go) {
        pending = null;
        deps.log('info', 'Updates: restart cancelled (unsaved work kept)');
        return set(readyStatus(false));
      }
      skipPrompt = true;
    }
    pending = { runAfter: true };
    deps.log('info', 'Updates: restarting to install');
    deps.requestQuit({ skipPrompt });
    return set(readyStatus(true));
  }

  function setMode(mode: 'manual' | 'weekly'): UpdateStatus {
    if (mode !== 'manual' && mode !== 'weekly') throw new AppError('VALIDATION', 'Invalid update mode.');
    if (policy.locked) throw new AppError('FORBIDDEN', policy.reason ?? 'Updates are managed by your administrator.');
    savePrefs({ ...prefs, mode });
    policy = deps.policyFor(mode);
    schedule();
    deps.log('info', 'Updates: mode changed', { mode: policy.mode });
    switch (status.state) {
      case 'unavailable':
      case 'idle':
        return set(initial());
      default:
        return set({ ...status, policy } as UpdateStatus);
    }
  }

  function clearTimer(): void {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
  }

  function schedule(delay = FIRST_CHECK_DELAY_MS): void {
    clearTimer();
    if (policy.mode !== 'weekly') return;
    timer = deps.setTimeout(() => {
      timer = null;
      if (policy.mode !== 'weekly') return;
      if (isDue(prefs.lastCheck, deps.now(), policy.mode as UpdateMode) && status.state !== 'ready' && status.state !== 'downloading') {
        deps.log('info', 'Updates: weekly check');
        void check();
      }
      schedule(RECHECK_INTERVAL_MS);
    }, delay);
  }

  return {
    status: () => status,
    check,
    download,
    install,
    setMode,
    start: () => schedule(),
    stop: clearTimer,
    quitCancelled() {
      if (!pending || !pending.runAfter) return;
      pending = null;
      deps.log('info', 'Updates: restart cancelled (a window stayed open)');
      set(readyStatus(false));
    },
    beforeExit() {
      clearTimer();
      const p = pending;
      pending = null;
      if (!p || !updater || !downloaded) return Promise.resolve();
      deps.log('info', `Updates: starting the installer${p.runAfter ? ' (Pevqori restarts afterwards)' : ''}`);
      updater.quitAndInstall(p.runAfter);
      return new Promise<void>((resolve) => {
        deps.setTimeout(resolve, INSTALL_GRACE_MS);
      });
    },
    get loaded() {
      return updater !== null;
    },
  };
}

function safeOrigin(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'invalid-url';
  }
}
