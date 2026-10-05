// Smoke tests for the packaged-equivalent build (out/). Each run uses a throw-away profile and data
// folder via BAHI_USER_DATA / BAHI_DATA_DIR so it never touches a developer's real data.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ApiResult } from '../src/shared/api.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let app: ElectronApplication;
let page: Page;
let tmp: string;

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'BAHI_DEV_SERVER_URL') env[key] = value;
  }
  return { ...env, ...extra };
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'bahi-e2e-'));
  app = await electron.launch({
    args: ['out/main/index.cjs'],
    cwd: repoRoot,
    env: childEnv({
      BAHI_USER_DATA: path.join(tmp, 'user-data'),
      BAHI_DATA_DIR: path.join(tmp, 'data'),
      BAHI_E2E: '1',
    }),
  });
  app.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[electron] ${d.toString()}`));
  app.process().stderr?.on('data', (d: Buffer) => process.stderr.write(`[electron] ${d.toString()}`));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

test('main window opens with the product title', async () => {
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? ''))
    .toContain('Bahi ERP');
  const url = page.url();
  expect(url.startsWith('app://bahi/')).toBe(true);
});

test('window.bahi exposes exactly the documented bridge', async () => {
  const shape = await page.evaluate(() => {
    const bahi = (globalThis as unknown as { bahi?: Record<string, unknown> }).bahi;
    return bahi ? Object.keys(bahi).sort() : null;
  });
  expect(shape).toEqual(['api', 'native', 'on', 'platform', 'setDirty']);
});

test('app.state resolves through the IPC bridge', async () => {
  const result = await page.evaluate(() => {
    const bahi = (globalThis as unknown as { bahi: { api(route: string, input: unknown): Promise<unknown> } }).bahi;
    return bahi.api('app.state', {});
  });
  expect((result as ApiResult<unknown>).ok).toBe(true);
});

test('renderer has no Node.js access', async () => {
  const leaks = await page.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    return { require: typeof g.require, process: typeof g.process, module: typeof g.module, Buffer: typeof g.Buffer };
  });
  expect(leaks).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined', Buffer: 'undefined' });
});

test('malformed IPC requests are rejected, not thrown', async () => {
  const results = await page.evaluate(async () => {
    const bahi = (globalThis as unknown as { bahi: { api(route: unknown, input: unknown): Promise<unknown>; native(a: unknown, p: unknown): Promise<unknown> } }).bahi;
    return Promise.all([bahi.api(42, {}), bahi.api('constructor', {}), bahi.api('x'.repeat(500), {}), bahi.native('no.such.action', {})]);
  });
  for (const r of results as Array<ApiResult<unknown>>) expect(r.ok).toBe(false);
});

test('the renderer cannot reach the network', async () => {
  const outcome = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/', { mode: 'no-cors' });
      return 'reached';
    } catch {
      return 'blocked';
    }
  });
  expect(outcome).toBe('blocked');
});
