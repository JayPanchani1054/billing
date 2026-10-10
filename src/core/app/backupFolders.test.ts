import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BACKUP_FOLDERS_FILE, FileBackupFolderApprovals, MemoryBackupFolderApprovals } from './backupFolders.ts';

describe('backup folders approved on this installation', () => {
  let dir: string;
  const logs: string[] = [];
  const log = (_l: string, m: string) => {
    logs.push(m);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pevqori-bkf-'));
    logs.length = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('approvals are per company GUID and folder, and survive a restart', () => {
    const folder = path.join(dir, 'usb');
    const a = new FileBackupFolderApprovals({ dir, log });
    assert.equal(a.isApproved('guid-1', folder), false);
    a.approve('guid-1', folder, new Date('2026-10-05T00:00:00Z'));
    assert.equal(a.isApproved('guid-1', folder), true);
    assert.equal(a.isApproved('guid-1', `${folder}${path.sep}`), true, 'trailing separator');
    assert.equal(a.isApproved('guid-2', folder), false, 'another company (e.g. a crafted file) is not covered');
    assert.equal(a.isApproved('guid-1', path.join(folder, 'sub')), false, 'a subfolder is a different folder');
    assert.equal(a.isApproved('guid-1', 'relative'), false);
    const b = new FileBackupFolderApprovals({ dir, log });
    assert.equal(b.isApproved('guid-1', folder), true);
  });

  it('a corrupt file is kept aside and nothing counts as approved (folders are confirmed again)', () => {
    fs.writeFileSync(path.join(dir, BACKUP_FOLDERS_FILE), '{not json');
    const a = new FileBackupFolderApprovals({ dir, log });
    assert.equal(a.isApproved('guid-1', path.join(dir, 'x')), false);
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith(`${BACKUP_FOLDERS_FILE}.corrupt-`)));
    // Malformed rows are ignored.
    fs.writeFileSync(path.join(dir, BACKUP_FOLDERS_FILE), JSON.stringify({ v: 1, approved: [{ companyGuid: 'g', folder: 'relative', at: 'x' }, { companyGuid: 'g', folder: path.join(dir, 'ok'), at: 'x' }, 7] }));
    const b = new FileBackupFolderApprovals({ dir, log });
    assert.equal(b.isApproved('g', path.join(dir, 'ok')), true);
    assert.equal(b.isApproved('g', path.resolve('relative')), false);
  });

  it('memory store', () => {
    const m = new MemoryBackupFolderApprovals();
    m.approve('g', path.join(dir, 'f'));
    assert.equal(m.isApproved('g', path.join(dir, 'f')), true);
    assert.equal(m.isApproved('h', path.join(dir, 'f')), false);
  });
});
