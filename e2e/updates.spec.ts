// In-app updates under test (src/main/updates/, SPEC §9.3): every e2e launch sets PEVQORI_E2E=1, which turns
// updates off before anything else — so this spec checks the offline-first promise end to end:
//
//   - the bridge answers every updates.* action with "unavailable" (no check, no download, mode locked) and
//     validates its payloads;
//   - About Pevqori shows the Updates panel with "Updates are turned off for this test run." and nothing
//     to click; Home shows no update notice;
//   - the updater bundle (out/main/updater.cjs, electron-updater) is never loaded and no request leaves
//     the app (the log says so, and the renderer's own fetch is still blocked — smoke.spec.ts pattern).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ApiResult } from '../src/shared/api.ts';
import type { UpdateStatus } from '../src/shared/bridge.ts';
import { firstLaunchCreateCompany, openGotoItem, screen, toGateway } from './flows.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

const TEST_RUN = 'Updates are turned off for this test run.';

let launched: LaunchedApp | undefined;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp('pevqori-e2e-updates-');
  page = launched.page;
  await firstLaunchCreateCompany(page, launched.dataDir, { name: 'Updates Check Traders', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' });
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

async function nativeCall(action: string, payload: unknown): Promise<ApiResult<UpdateStatus>> {
  const result = await page.evaluate(
    ([a, p]) => (globalThis as unknown as { pevqori: { native(a: string, p: unknown): Promise<unknown> } }).pevqori.native(a, p),
    [action, payload] as const,
  );
  return result as ApiResult<UpdateStatus>;
}

function logLines(): string[] {
  if (!launched) return [];
  try {
    return readFileSync(path.join(launched.userDataDir, 'logs', 'pevqori.log'), 'utf8').split('\n');
  } catch {
    return [];
  }
}

test('the bridge reports updates as turned off for a test run, and never checks', async () => {
  for (const action of ['updates.status', 'updates.check', 'updates.download']) {
    const r = await nativeCall(action, undefined);
    expect(r.ok, action).toBe(true);
    if (!r.ok) continue;
    expect(r.data.state).toBe('unavailable');
    expect(r.data.state === 'unavailable' ? r.data.reason : '').toBe(TEST_RUN);
    expect(r.data.policy).toEqual({ mode: 'off', locked: true, source: 'env', reason: TEST_RUN });
  }
  const mode = await nativeCall('updates.setMode', { mode: 'weekly' });
  expect(mode.ok).toBe(false);
  expect(mode.ok ? '' : mode.error.code).toBe('FORBIDDEN');
  const install = await nativeCall('updates.install', { when: 'now' });
  expect(install.ok).toBe(false);
  // Malformed payloads are refused, never thrown across the bridge.
  for (const [action, payload] of [
    ['updates.install', { when: 'later' }],
    ['updates.install', null],
    ['updates.setMode', { mode: 'off' }],
    ['updates.setMode', 'weekly'],
  ] as const) {
    const r = await nativeCall(action, payload);
    expect(r.ok, `${action} ${JSON.stringify(payload)}`).toBe(false);
  }
});

test('About Pevqori shows the Updates panel with the test-run reason and nothing to click', async () => {
  await openGotoItem(page, { id: 'menu:company:company.about:About Pevqori', label: 'About Pevqori' });
  const about = screen(page, 'company.about');
  await expect(about.getByRole('heading', { name: 'About Pevqori', level: 1 })).toBeVisible();
  await expect(about.getByRole('heading', { name: 'Updates', level: 2 })).toBeVisible();
  await expect(about.getByText(TEST_RUN)).toBeVisible();
  await expect(about.getByRole('button', { name: 'Check for updates' })).toHaveCount(0);
  await expect(about.getByRole('switch', { name: /Check automatically once a week/ })).toHaveCount(0);
  await expect(about.getByText('Check for updates automatically once a week?')).toHaveCount(0);
});

test('Home shows no update notice', async () => {
  await toGateway(page);
  const home = screen(page, 'app.gateway');
  await expect(home).toBeVisible();
  await expect(home.getByText(/Pevqori \d+\.\d+\.\d+ is (ready|available)/)).toHaveCount(0);
  await expect(home.getByRole('button', { name: 'Restart to update' })).toHaveCount(0);
});

test('no request leaves the app: the updater is never loaded and the renderer stays offline', async () => {
  // The start-up log records the effective policy; electron-updater is loaded only by a real check.
  await expect.poll(() => logLines().some((l) => l.includes('"msg":"Updates"') && l.includes('"mode":"off"')), { timeout: 15_000 }).toBe(true);
  const lines = logLines();
  expect(lines.filter((l) => l.includes('updater loaded') || l.includes('Updater:'))).toEqual([]);
  expect(lines.filter((l) => l.includes('outside the update allowlist'))).toEqual([]);

  const outcome = await page.evaluate(async () => {
    try {
      await fetch('https://github.com/', { mode: 'no-cors' });
      return 'reached';
    } catch {
      return 'blocked';
    }
  });
  expect(outcome).toBe('blocked');
});
