import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
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

/**
 * The finding this guards: 'data.backup.auto' had no caller at all, so "Back up automatically" did
 * nothing. The shell (React, read from source) must call it after opening and before F3 / Ctrl+Q.
 */
describe('shell wiring of the automatic backup', () => {
  const shellSrc = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shell.tsx'), 'utf8');
  const body = (name: string): string => {
    const start = shellSrc.indexOf(`const ${name} = useCallback(`);
    assert.ok(start >= 0, `${name} not found in shell.tsx`);
    return shellSrc.slice(start, shellSrc.indexOf('\n  );\n', start));
  };

  test("runs with trigger 'open' after the workspace mounts and 'close' before closing", () => {
    assert.match(shellSrc, /api\('data\.backup\.auto', \{ trigger: 'open' \}\)/);
    assert.match(body('backupBeforeClose'), /api\('data\.backup\.auto', \{ trigger: 'close' \}\)/);
    assert.match(body('backupBeforeClose'), /withTimeout\(work, AUTO_BACKUP_CLOSE_WAIT_MS\)/);
  });

  test('F3 (close company) and Ctrl+Q (quit) back up first', () => {
    const close = body('closeCompany');
    assert.ok(close.indexOf('backupBeforeClose()') >= 0 && close.indexOf('backupBeforeClose()') < close.indexOf("api('app.company.close')"));
    const quit = body('quit');
    assert.ok(quit.indexOf('backupBeforeClose()') >= 0 && quit.indexOf('backupBeforeClose()') < quit.indexOf("native('app.quit'"));
  });
});
