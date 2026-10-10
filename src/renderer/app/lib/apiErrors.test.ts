import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError, confirmationOf, errorDetailsText, fieldErrorsOf, isBusyConflict, nestedFieldErrors, retryWhileBusy, userMessage } from './apiErrors.ts';

describe('ApiError helpers', () => {
  test('from payload', () => {
    const e = ApiError.from({ code: 'CONFLICT', message: 'Duplicate name' }, 'accounts.ledger.save');
    assert.equal(e.code, 'CONFLICT');
    assert.equal(e.route, 'accounts.ledger.save');
    assert.ok(e instanceof Error);
  });

  test('fieldErrorsOf maps VALIDATION issues (first per path)', () => {
    const e = new ApiError('VALIDATION', '2 fields are invalid', [
      { path: 'gstin', message: 'GSTIN must be exactly 15 characters' },
      { path: 'gstin', message: 'second' },
      { path: 'owner.password', message: 'Password must contain at least one digit' },
      { nonsense: true },
    ]);
    assert.deepEqual(fieldErrorsOf(e), {
      gstin: 'GSTIN must be exactly 15 characters',
      'owner.password': 'Password must contain at least one digit',
    });
    assert.deepEqual(nestedFieldErrors(fieldErrorsOf(e), 'owner'), { password: 'Password must contain at least one digit' });
    assert.deepEqual(fieldErrorsOf(new ApiError('CONFLICT', 'x', [{ path: 'a', message: 'b' }])), {});
    assert.deepEqual(fieldErrorsOf(new Error('x')), {});
  });

  test('confirmationOf recognises the needsConfirmation protocol only', () => {
    const e = new ApiError('BUSINESS_RULE', 'Please confirm', { needsConfirmation: true, warnings: ['Stock of Widget goes negative (-2 Nos)', 42, ''] });
    assert.deepEqual(confirmationOf(e), { message: 'Please confirm', warnings: ['Stock of Widget goes negative (-2 Nos)'] });
    assert.equal(confirmationOf(new ApiError('BUSINESS_RULE', 'Voucher is not balanced')), null);
    assert.equal(confirmationOf(new ApiError('VALIDATION', 'x', { needsConfirmation: true })), null);
    assert.deepEqual(confirmationOf(new ApiError('BUSINESS_RULE', 'm', { needsConfirmation: true })), { message: 'm', warnings: [] });
  });

  test('userMessage never leaks raw JS errors', () => {
    assert.equal(userMessage(new ApiError('LOCKED', 'Books are locked up to 31-Mar-2026.')), 'Books are locked up to 31-Mar-2026.');
    assert.equal(userMessage(new ApiError('VALIDATION', '2 fields', [{ path: 'a', message: 'A is required' }])), 'A is required');
    assert.equal(userMessage(new ApiError('VALIDATION', '2 fields', [{ path: 'a', message: 'x' }, { path: 'b', message: 'y' }])), 'Please correct 2 fields and try again.');
    assert.equal(userMessage(new TypeError('cannot read properties of undefined')), 'Something went wrong. Please try again.');
    assert.match(userMessage(new ApiError('BRIDGE_UNAVAILABLE', '')), /desktop app/);
  });

  test('errorDetailsText', () => {
    const t = errorDetailsText(new ApiError('INTERNAL', 'Oops', undefined, 'reports.tb'), { Screen: 'Trial Balance' });
    assert.match(t, /Screen: Trial Balance/);
    assert.match(t, /Code: INTERNAL/);
    assert.match(t, /Action: reports\.tb/);
  });
});

describe('busy conflicts: wait and retry (an import while the automatic backup runs)', () => {
  const busy = () => new ApiError('CONFLICT', 'Another task is still running in this company…', { reason: 'busy', retryable: true }, 'data.import.preview');

  test('isBusyConflict: only CONFLICT with reason "busy"', () => {
    assert.equal(isBusyConflict(busy()), true);
    assert.equal(isBusyConflict(new ApiError('CONFLICT', 'Taken', { field: 'name' })), false);
    assert.equal(isBusyConflict(new ApiError('BUSINESS_RULE', 'x', { reason: 'busy' })), false);
    assert.equal(isBusyConflict(new Error('x')), false);
  });

  test('retries while busy, then returns the result', async () => {
    let calls = 0;
    const waits: number[] = [];
    const slept: number[] = [];
    const out = await retryWhileBusy(
      async () => {
        calls++;
        if (calls < 3) throw busy();
        return 'imported';
      },
      { intervalMs: 500, sleep: async (ms) => void slept.push(ms), onWait: (n) => waits.push(n), now: () => 0 },
    );
    assert.equal(out, 'imported');
    assert.equal(calls, 3);
    assert.deepEqual(slept, [500, 500]);
    assert.deepEqual(waits, [2, 3]);
  });

  test('other errors are not retried; a busy conflict past the time limit or after cancel is rethrown', async () => {
    let calls = 0;
    await assert.rejects(
      retryWhileBusy(async () => {
        calls++;
        throw new ApiError('VALIDATION', 'bad', []);
      }, { sleep: async () => undefined }),
      (e: unknown) => e instanceof ApiError && e.code === 'VALIDATION',
    );
    assert.equal(calls, 1);
    let t = 0;
    await assert.rejects(
      retryWhileBusy(async () => {
        throw busy();
      }, { intervalMs: 1_000, timeoutMs: 3_000, sleep: async (ms) => void (t += ms), now: () => t }),
      (e: unknown) => isBusyConflict(e),
    );
    assert.ok(t <= 3_000);
    let n = 0;
    await assert.rejects(retryWhileBusy(async () => { n++; throw busy(); }, { cancelled: () => true, sleep: async () => undefined }), (e: unknown) => isBusyConflict(e));
    assert.equal(n, 1);
  });
});
