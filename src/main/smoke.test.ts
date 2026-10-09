import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { CORE_DEFAULTS } from './core-proxy.ts';
import { QUIT_DEADLINE_MS } from './quit.ts';
import { evaluateSmoke, SMOKE_TIMEOUT_MS } from './smoke.ts';

describe('packaged smoke test verdict', () => {
  it('passes only for a successful app.state of the expected version with a data folder', () => {
    assert.deepEqual(evaluateSmoke({ ok: true, data: { appVersion: '1.2.3', dataDir: 'C:\\Data' } }, '1.2.3'), {
      ok: true,
      detail: 'app.state ok (version 1.2.3)',
    });
  });

  it('fails with a useful detail otherwise', () => {
    assert.match(evaluateSmoke({ ok: false, error: { code: 'INTERNAL', message: 'engine down' } }, '1').detail, /INTERNAL.*engine down/);
    assert.equal(evaluateSmoke(undefined, '1').ok, false);
    assert.equal(evaluateSmoke({ ok: true, data: null }, '1').ok, false);
    assert.match(evaluateSmoke({ ok: true, data: { appVersion: '0.9', dataDir: '/d' } }, '1.0').detail, /expected 1.0/);
    assert.equal(evaluateSmoke({ ok: true, data: { appVersion: '1', dataDir: '' } }, '1').ok, false);
  });

  it('the CI driver waits longer than the app needs to give its verdict and quit', () => {
    // scripts/smoke-installed.ps1 kills the app after -TimeoutSeconds; it must never pre-empt the app's
    // own verdict: core start-up (bounded by the proxy; the smoke timer starts only after it), the
    // smoke check itself (SMOKE_TIMEOUT_MS) and the bounded quit (QUIT_DEADLINE_MS).
    const ps1 = fs.readFileSync(new URL('../../scripts/smoke-installed.ps1', import.meta.url), 'utf8');
    const m = /\[int\]\$TimeoutSeconds = (\d+)/.exec(ps1);
    assert.ok(m, 'TimeoutSeconds default found');
    const worstCase = CORE_DEFAULTS.startupTimeoutMs + SMOKE_TIMEOUT_MS + QUIT_DEADLINE_MS;
    assert.ok(Number(m[1]) * 1000 > worstCase, `${m[1]} s is too short (the app may take ${worstCase / 1000} s)`);
  });
});
