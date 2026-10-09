/**
 * End-to-end harness: drives the REAL runtime exactly as Electron main does (createRuntime +
 * runtime.dispatch(route, input)), against temporary userData / data folders.
 *
 * Only `dispatch` is used to change or read company data — no service imports, no SQL — so every
 * figure a test asserts is a figure a user would see on screen.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApiResult } from '../../../shared/api.ts';
import { fixedClock, type FixedClock } from '../../app/clock.ts';
import { createRuntime, type Runtime } from '../../app/runtime.ts';

export interface E2E {
  rt: Runtime;
  clock: FixedClock;
  root: string;
  /** Dispatch a route and require success; returns the data. */
  call<T = any>(route: string, input?: unknown): Promise<T>;
  /** Dispatch a route and return the raw ApiResult (for expected failures). */
  raw(route: string, input?: unknown): Promise<ApiResult<unknown>>;
  /** Dispatch a route that must fail with `code`. */
  fails(route: string, input: unknown, code: string, re?: RegExp): Promise<void>;
  close(): Promise<void>;
}

export function startRuntime(today: string): E2E {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-e2e-'));
  const userDataDir = fs.mkdtempSync(path.join(root, 'userData-'));
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'));
  const clock = fixedClock(today);
  const rt = createRuntime({ userDataDir, defaultDataDir: dataDir, appVersion: '1.0.0-e2e', clock, consoleLog: false });
  const raw = (route: string, input: unknown = {}): Promise<ApiResult<unknown>> => rt.dispatch(route, input);
  return {
    rt,
    clock,
    root,
    raw,
    async call<T>(route: string, input: unknown = {}): Promise<T> {
      const r = await raw(route, input);
      if (!r.ok) {
        assert.fail(`${route} failed: ${r.error.code} ${r.error.message}\n  details: ${JSON.stringify(r.error.details ?? null)}`);
      }
      return r.data as T;
    },
    async fails(route: string, input: unknown, code: string, re?: RegExp): Promise<void> {
      const r = await raw(route, input);
      assert.equal(r.ok, false, `${route} should fail with ${code}`);
      if (!r.ok) {
        assert.equal(r.error.code, code, `${route}: ${r.error.message}`);
        if (re) assert.match(r.error.message, re);
      }
    },
    async close(): Promise<void> {
      await rt.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Rupees → paise (exact for the 2-decimal literals used in the scenario). */
export const P = (rupees: number): number => Math.round(rupees * 100);

/** Σ of a numeric field. */
export const sum = <T>(rows: readonly T[], f: (r: T) => number): number => rows.reduce((a, r) => a + f(r), 0);

/** Last day of the month of an ISO date. */
export function monthEnd(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

/** The 12 months of FY 2026-27 as [YYYY-MM, monthIndex 0..11]. */
export const FY_MONTHS: ReadonlyArray<string> = [
  '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
  '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
];

/** 'MMYYYY' GST return period key of an ISO month 'YYYY-MM'. */
export const periodKey = (ym: string): string => `${ym.slice(5, 7)}${ym.slice(0, 4)}`;
