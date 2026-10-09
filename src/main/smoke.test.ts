import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateSmoke } from './smoke.ts';

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
});
