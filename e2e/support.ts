// Shared launch/teardown for the Electron specs: an isolated profile and data folder per run, a
// Playwright trace (DOM snapshots + screenshots) kept only when a test fails, a screenshot attached
// to every failing test, and a bounded, measured quit.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, test } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Longest app.close() may take. The app's own quit deadline is 40 s (src/main/quit.ts). */
const CLOSE_TIMEOUT_MS = 45_000;
/** Time allowed for writing the trace (trace.zip with DOM snapshots) before quitting. */
const TRACE_STOP_BUDGET_MS = 30_000;

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  tmp: string;
  dataDir: string;
  userDataDir: string;
  /** Set by captureFailures() when a test of this spec failed: keep the trace. */
  failed: boolean;
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'BAHI_DEV_SERVER_URL') env[key] = value;
  }
  return { ...env, ...extra };
}

/** Launch the built app (out/main/index.cjs — run `npm run build` first) with a throw-away profile. */
export async function launchApp(prefix: string): Promise<LaunchedApp> {
  const tmp = await mkdtemp(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const userDataDir = path.join(tmp, 'user-data');
  const app = await electron.launch({
    args: ['out/main/index.cjs'],
    cwd: repoRoot,
    env: childEnv({ BAHI_USER_DATA: userDataDir, BAHI_DATA_DIR: dataDir, BAHI_E2E: '1' }),
  });
  app.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[electron] ${d.toString()}`));
  app.process().stderr?.on('data', (d: Buffer) => process.stderr.write(`[electron] ${d.toString()}`));
  await app.context().tracing.start({ screenshots: true, snapshots: true });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, tmp, dataDir, userDataDir, failed: false };
}

/**
 * Register the failure hooks for a spec: a screenshot of the window is attached to each failing test
 * (the specs drive Electron directly, so Playwright's own `screenshot: 'only-on-failure'` never applies).
 */
export function captureFailures(getLaunched: () => LaunchedApp | undefined): void {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    const launched = getLaunched();
    if (!launched) return;
    launched.failed = true;
    const page = launched.page;
    if (page.isClosed()) return;
    try {
      await testInfo.attach('window', { body: await page.screenshot(), contentType: 'image/png' });
    } catch {
      /* the window may already be gone */
    }
    // The CI log is often all there is to read: print what the user would see — alerts, toasts and the
    // top screen's text — so a failure explains itself without downloading the trace.
    try {
      const messages = await page.locator('[role=alert], [role=status], [role=alertdialog]').allInnerTexts();
      const top = page.locator('[data-screen]').last();
      const screenId = (await top.count()) > 0 ? await top.getAttribute('data-screen') : null;
      const text = (await top.count()) > 0 ? await top.innerText() : await page.locator('body').innerText();
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} ${el.getAttribute('aria-label') ?? ''}`.trim() : 'none';
      });
      console.log(
        [
          `[e2e] FAILED: ${testInfo.title}`,
          `[e2e] top screen: ${screenId ?? '(none)'} · focus: ${focused}`,
          ...messages.filter((m) => m.trim() !== '').map((m) => `[e2e] message: ${m.replace(/\s+/g, ' ').slice(0, 400)}`),
          `[e2e] screen text: ${text.replace(/\s+/g, ' ').slice(0, 1500)}`,
        ].join('\n'),
      );
    } catch {
      /* best effort */
    }
  });
}

/**
 * Stop tracing (kept as trace.zip in the test output folder only if a test failed), quit the app and
 * fail loudly if quitting hangs, then delete the throw-away folders.
 */
export async function closeApp(launched: LaunchedApp | undefined, testInfo: TestInfo): Promise<void> {
  if (!launched) return;
  const { app, tmp } = launched;
  // The afterAll hook gets the test timeout (60 s) by default; writing a long trace plus a quit that
  // legitimately takes up to the app's 40 s deadline must not be cut off by it, so the hook gets the
  // whole close bound on top of time for the trace. A real hang still fails, at CLOSE_TIMEOUT_MS below.
  testInfo.setTimeout(TRACE_STOP_BUDGET_MS + CLOSE_TIMEOUT_MS + 15_000);
  try {
    if (launched.failed) await app.context().tracing.stop({ path: testInfo.outputPath('trace.zip') });
    else await app.context().tracing.stop();
  } catch {
    /* tracing is best effort */
  }
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'hung'>((resolve) => {
    timer = setTimeout(() => resolve('hung'), CLOSE_TIMEOUT_MS);
  });
  const outcome = await Promise.race([app.close().then(() => 'closed' as const), hung]);
  clearTimeout(timer);
  if (outcome === 'hung') {
    app.process().kill('SIGKILL');
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`The app did not quit within ${CLOSE_TIMEOUT_MS / 1000} s of app.close() (see [electron] "Quit:" log lines)`);
  }
  console.log(`[e2e] app closed in ${Date.now() - started} ms`);
  await rm(tmp, { recursive: true, force: true });
}
