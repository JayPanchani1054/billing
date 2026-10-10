/**
 * Packaged-app smoke test (PEVQORI_SMOKE_TEST=1). The installed Pevqori.exe has the
 * EnableNodeCliInspectArguments fuse off, so Playwright cannot attach to it; instead CI starts it with
 * this variable and the app checks itself, end to end through the real layers:
 *
 *   main window loads app://pevqori → renderer calls window.pevqori.api('app.state') → preload → IPC →
 *   core proxy → worker thread → node:sqlite runtime → back
 *
 * The verdict is written to the log file ("Smoke test passed" / "Smoke test failed") and becomes the
 * process exit code (0 / 1), then the app quits through the normal quit sequence. The mode only reads
 * state and quits; it is honoured in packaged builds on purpose (scripts/smoke-installed.ps1).
 */

/** Evaluated in the window's main world, where the preload exposed `window.pevqori`. */
export const SMOKE_SCRIPT = "window.pevqori.api('app.state', {})";

/** Longest the smoke test waits for the window and the core before failing. */
export const SMOKE_TIMEOUT_MS = 90_000;

export interface SmokeVerdict {
  ok: boolean;
  detail: string;
}

/** Judge the app.state answer obtained through the bridge. Pure. */
export function evaluateSmoke(result: unknown, expectedVersion: string): SmokeVerdict {
  if (result === null || typeof result !== 'object') return { ok: false, detail: 'the bridge returned no result' };
  const r = result as { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
  if (r.ok !== true) {
    const code = typeof r.error?.code === 'string' ? r.error.code : 'unknown';
    const message = typeof r.error?.message === 'string' ? r.error.message : '';
    return { ok: false, detail: `app.state failed (${code}) ${message}`.trim() };
  }
  const data = r.data as { appVersion?: unknown; dataDir?: unknown } | null;
  if (!data || typeof data !== 'object') return { ok: false, detail: 'app.state returned no state' };
  if (data.appVersion !== expectedVersion) return { ok: false, detail: `app.state reported version ${String(data.appVersion)}, expected ${expectedVersion}` };
  if (typeof data.dataDir !== 'string' || data.dataDir.length === 0) return { ok: false, detail: 'app.state reported no data folder' };
  return { ok: true, detail: `app.state ok (version ${expectedVersion})` };
}
