// Smoke tests for the packaged-equivalent build (out/). Each run uses a throw-away profile and data
// folder via PEVQORI_USER_DATA / PEVQORI_DATA_DIR so it never touches a developer's real data.
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ApiResult } from '../src/shared/api.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

let launched: LaunchedApp | undefined;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-');
  ({ app, page } = launched);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

test('main window opens with the product title', async () => {
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? ''))
    .toContain('Pevqori');
  const url = page.url();
  expect(url.startsWith('app://pevqori/')).toBe(true);
});

test('window.pevqori exposes exactly the documented bridge', async () => {
  const shape = await page.evaluate(() => {
    const pevqori = (globalThis as unknown as { pevqori?: Record<string, unknown> }).pevqori;
    return pevqori ? Object.keys(pevqori).sort() : null;
  });
  expect(shape).toEqual(['api', 'native', 'on', 'platform', 'setDirty']);
});

test('app.state resolves through the IPC bridge', async () => {
  const result = await page.evaluate(() => {
    const pevqori = (globalThis as unknown as { pevqori: { api(route: string, input: unknown): Promise<unknown> } }).pevqori;
    return pevqori.api('app.state', {});
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
    const pevqori = (globalThis as unknown as { pevqori: { api(route: unknown, input: unknown): Promise<unknown>; native(a: unknown, p: unknown): Promise<unknown> } }).pevqori;
    return Promise.all([pevqori.api(42, {}), pevqori.api('constructor', {}), pevqori.api('x'.repeat(500), {}), pevqori.native('no.such.action', {})]);
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
