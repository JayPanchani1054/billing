import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { UpdatePolicy, UpdateStatus } from '../../../../shared/bridge.ts';
import { checkedText, dismissKey, formatSize, noticeFor, shouldAskAutomatic, updateView } from './updateView.ts';

const USER: UpdatePolicy = { mode: 'manual', locked: false, source: 'user', reason: null };
const WEEKLY: UpdatePolicy = { mode: 'weekly', locked: false, source: 'user', reason: null };
const ADMIN: UpdatePolicy = { mode: 'weekly', locked: true, source: 'policy', reason: 'Managed by your administrator.' };
const now = new Date(2026, 9, 10, 15, 0, 0);

describe('updates view-model', () => {
  test('loading: nothing to click yet', () => {
    const v = updateView(null, now);
    assert.equal(v.busy, true);
    assert.deepEqual(v.actions, []);
    assert.equal(v.modeSwitch.visible, false);
  });

  test('e2e / unpackaged / policy off: the reason, no buttons, no switch', () => {
    const v = updateView({ state: 'unavailable', reason: 'Updates are turned off for this test run.', current: '2.0.0', policy: { mode: 'off', locked: true, source: 'env', reason: 'Updates are turned off for this test run.' } }, now);
    assert.equal(v.headline, 'Updates are turned off for this test run.');
    assert.deepEqual(v.actions, []);
    assert.equal(v.modeSwitch.visible, false);
  });

  test('idle: version, how checks happen, last checked, one primary Check button', () => {
    const v = updateView({ state: 'idle', current: '2.0.0', lastCheck: new Date(2026, 9, 10, 9, 5).toISOString(), policy: USER }, now);
    assert.equal(v.headline, 'You are using Pevqori 2.0.0.');
    assert.equal(v.detail, 'Pevqori looks for a new version only when you ask.');
    assert.equal(v.lastChecked, 'today at 9:05 am');
    assert.deepEqual(v.actions, [{ id: 'check', label: 'Check for updates', primary: true }]);
    assert.deepEqual(v.modeSwitch, { visible: true, checked: false, disabled: false, hint: null });
    assert.equal(updateView({ state: 'idle', current: '2.0.0', lastCheck: null, policy: WEEKLY }, now).detail, 'Pevqori checks for a new version once a week.');
  });

  test('locked policy: switch disabled with the administrator reason', () => {
    const v = updateView({ state: 'idle', current: '2.0.0', lastCheck: null, policy: ADMIN }, now);
    assert.deepEqual(v.modeSwitch, { visible: true, checked: true, disabled: true, hint: 'Managed by your administrator.' });
  });

  test('checking / up to date / error', () => {
    assert.equal(updateView({ state: 'checking', current: '2.0.0', policy: USER }, now).busy, true);
    const up = updateView({ state: 'up-to-date', current: '2.0.0', checkedAt: new Date(2026, 9, 9, 18, 30).toISOString(), policy: USER }, now);
    assert.equal(up.headline, 'Pevqori 2.0.0 is up to date.');
    assert.equal(up.lastChecked, 'yesterday at 6:30 pm');
    assert.equal(up.tone, 'success');
    const err = updateView({ state: 'error', current: '2.0.0', message: 'Update server not reachable.', retryable: true, policy: USER }, now);
    assert.equal(err.tone, 'danger');
    assert.deepEqual(err.actions, [{ id: 'check', label: 'Try again', primary: true }]);
  });

  test('available: version, date and size, notes as text, Download', () => {
    const v = updateView({ state: 'available', current: '2.0.0', version: '2.1.0', releaseDate: '2026-10-08T10:00:00.000Z', notes: 'Faster <b>GSTR-1</b>', sizeBytes: 98_765_432, policy: USER }, now);
    assert.equal(v.headline, 'Pevqori 2.1.0 is available.');
    assert.equal(v.detail, 'Released 8 Oct 2026 · Download 94.2 MB');
    assert.deepEqual(v.notes, { title: "What's new in 2.1.0", text: 'Faster <b>GSTR-1</b>' });
    assert.deepEqual(v.actions, [{ id: 'download', label: 'Download update', primary: true }]);
  });

  test('downloading: progress bar text with speed, nothing to click', () => {
    const v = updateView({ state: 'downloading', current: '2.0.0', version: '2.1.0', percent: 41.6, bytesPerSecond: 2_400_000, policy: USER }, now);
    assert.deepEqual(v.progress, { percent: 42, text: '42% · 2.3 MB/s' });
    assert.deepEqual(v.actions, []);
    assert.equal(v.busy, true);
  });

  test('ready: Restart to update (primary) and Install when I quit; once armed only Restart remains', () => {
    const r = updateView({ state: 'ready', current: '2.0.0', version: '2.1.0', notes: '', installOnQuit: false, policy: USER }, now);
    assert.equal(r.headline, 'Pevqori 2.1.0 is ready to install.');
    assert.deepEqual(
      r.actions.map((a) => [a.id, a.label, a.primary]),
      [
        ['restart', 'Restart to update', true],
        ['on-quit', 'Install when I quit', false],
      ],
    );
    assert.equal(r.notes, null);
    const q = updateView({ state: 'ready', current: '2.0.0', version: '2.1.0', notes: 'x', installOnQuit: true, policy: USER }, now);
    assert.equal(q.headline, 'Pevqori 2.1.0 will be installed when you quit.');
    assert.deepEqual(q.actions.map((a) => a.id), ['restart']);
  });

  test('the one-time "check automatically?" card: only for an editable manual policy, until answered', () => {
    const idle: UpdateStatus = { state: 'idle', current: '2.0.0', lastCheck: null, policy: USER };
    assert.equal(shouldAskAutomatic(idle, false), true);
    assert.equal(shouldAskAutomatic(idle, true), false);
    assert.equal(shouldAskAutomatic({ ...idle, policy: WEEKLY }, false), false);
    assert.equal(shouldAskAutomatic({ ...idle, policy: ADMIN }, false), false);
    assert.equal(shouldAskAutomatic({ state: 'unavailable', reason: 'x', current: '2.0.0', policy: { mode: 'off', locked: true, source: 'build', reason: 'x' } }, false), false);
    assert.equal(shouldAskAutomatic(null, false), false);
  });

  test('Home notice: ready / available, dismissible per version and stage', () => {
    const ready: UpdateStatus = { state: 'ready', current: '2.0.0', version: '2.1.0', notes: '', installOnQuit: false, policy: USER };
    const n = noticeFor(ready, null);
    assert.deepEqual(n, { version: '2.1.0', title: 'Pevqori 2.1.0 is ready — Restart to update', ready: true });
    assert.equal(noticeFor(ready, dismissKey(n!)), null);
    assert.ok(noticeFor({ ...ready, version: '2.2.0' }, dismissKey(n!)), 'a newer version shows again');
    const available: UpdateStatus = { state: 'available', current: '2.0.0', version: '2.1.0', releaseDate: '', notes: '', sizeBytes: 0, policy: USER };
    const a = noticeFor(available, null);
    assert.equal(a?.title, 'Pevqori 2.1.0 is available');
    assert.equal(noticeFor(available, dismissKey(a!)), null);
    assert.ok(noticeFor(ready, dismissKey(a!)), 'dismissing "available" does not hide "ready"');
    assert.equal(noticeFor({ state: 'idle', current: '2.0.0', lastCheck: null, policy: USER }, null), null);
    assert.equal(noticeFor(null, null), null);
  });

  test('formatting helpers', () => {
    assert.equal(formatSize(0), '');
    assert.equal(formatSize(500), '1 KB');
    assert.equal(formatSize(150 * 1024 * 1024), '150 MB');
    assert.equal(formatSize(2.5 * 1024 * 1024 * 1024), '2.5 GB');
    assert.equal(checkedText(null, now), null);
    assert.equal(checkedText('garbage', now), null);
    assert.equal(checkedText(new Date(2026, 8, 1, 10, 0).toISOString(), now), '1-Sep-26');
  });
});
