import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { autoBackupNotice, withTimeout } from './autoBackup.ts';

describe('autoBackupNotice', () => {
  test('a written backup is announced with its file name', () => {
    const n = autoBackupNotice({ ran: true, reason: 'created', lastBackupAt: '2026-10-09T05:00:00Z', backup: { fileName: 'Sharma Traders_20261009-103000.bahibak' } });
    assert.deepEqual(n, { tone: 'success', title: 'Backed up automatically', message: 'Saved Sharma Traders_20261009-103000.bahibak.' });
  });

  test('a failure warns with the reason and offers the Backup screen', () => {
    const n = autoBackupNotice({ ran: false, reason: 'failed', lastBackupAt: null, error: 'Bahi ERP cannot write to the backup folder E:\\Backups (drive not found).' });
    assert.equal(n?.tone, 'warning');
    assert.match(n?.message ?? '', /drive not found/);
    assert.equal(n?.openBackup, true);
    assert.match(autoBackupNotice({ reason: 'failed' })?.message ?? '', /could not be written/);
  });

  test('nothing to say when off, recent, a new company or malformed', () => {
    for (const reason of ['disabled', 'recent', 'new']) assert.equal(autoBackupNotice({ ran: false, reason, lastBackupAt: null }), null);
    assert.equal(autoBackupNotice(null), null);
    assert.equal(autoBackupNotice('created'), null);
  });
});

describe('withTimeout', () => {
  test('resolves with the value when in time, else "timeout" (bounded close)', async () => {
    assert.equal(await withTimeout(Promise.resolve(42), 1_000), 42);
    const never = new Promise<number>(() => undefined);
    assert.equal(await withTimeout(never, 10), 'timeout');
  });
});
