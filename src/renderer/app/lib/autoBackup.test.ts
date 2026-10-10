import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { autoBackupNotice, sameFolder, unapprovedFolderText, withTimeout } from './autoBackup.ts';

describe('autoBackupNotice', () => {
  test('a written backup is announced with its file name', () => {
    const n = autoBackupNotice({ ran: true, reason: 'created', lastBackupAt: '2026-10-09T05:00:00Z', backup: { fileName: 'Sharma Traders_20261009-103000.pvqbak' } });
    assert.deepEqual(n, { tone: 'success', title: 'Backed up automatically', message: 'Saved Sharma Traders_20261009-103000.pvqbak.' });
  });

  test('a failure warns with the reason and offers the Backup screen', () => {
    const n = autoBackupNotice({ ran: false, reason: 'failed', lastBackupAt: null, error: 'Pevqori cannot write to the backup folder E:\\Backups (drive not found).' });
    assert.equal(n?.tone, 'warning');
    assert.match(n?.message ?? '', /drive not found/);
    assert.equal(n?.openBackup, true);
    assert.match(autoBackupNotice({ reason: 'failed' })?.message ?? '', /could not be written/);
  });

  test('a folder not approved on this computer: warns (even after a backup to the default folder) and offers the Backup screen', () => {
    const n = autoBackupNotice({ ran: true, reason: 'created', lastBackupAt: '2026-10-09T05:00:00Z', backup: { fileName: 'x.pvqbak' }, folderNotApproved: '\\\\nas\\books' });
    assert.equal(n?.tone, 'warning');
    assert.equal(n?.title, 'Confirm the backup folder');
    assert.match(n?.message ?? '', /^Backed up to the default folder instead\. The backup folder \\\\nas\\books was set on another computer/);
    assert.match(n?.message ?? '', /Confirm folder/);
    assert.equal(n?.openBackup, true);
    assert.match(autoBackupNotice({ ran: false, reason: 'failed', folderNotApproved: 'E:\\B' })?.message ?? '', /^The automatic backup failed\./);
    assert.match(unapprovedFolderText('D:\\Backups'), /does not write to it until you confirm it/);
  });

  test('sameFolder ignores trailing separators, and case only for Windows paths', () => {
    assert.equal(sameFolder('D:\\Backups\\', 'd:\\backups'), true);
    assert.equal(sameFolder('D:/Backups', 'D:\\Backups'), true);
    assert.equal(sameFolder('/home/a/B', '/home/a/B/'), true);
    assert.equal(sameFolder('/home/a/B', '/home/a/b'), false);
    assert.equal(sameFolder('D:\\Backups', 'D:\\Backups2'), false);
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
