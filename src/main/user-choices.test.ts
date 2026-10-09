import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PathSet } from './files.ts';
import { isUserChosenPath } from './user-choices.ts';

describe('isUserChosenPath (main’s AppRuntime.authorizePath)', () => {
  it('allows opened files for reading and anything inside chosen folders; nothing else', () => {
    const files = new PathSet();
    const folders = new PathSet();
    const sets = { files, folders };
    const file = path.resolve('/home/u/Downloads/a.bahibak');
    const folder = path.resolve('/media/usb/Backups');
    files.add(file);
    folders.add(folder);
    assert.equal(isUserChosenPath(file, 'read-file', sets), true);
    assert.equal(isUserChosenPath(file, 'write-dir', sets), false, 'an opened file does not authorise writing');
    assert.equal(isUserChosenPath(path.dirname(file), 'read-dir', sets), false, 'nor its folder');
    assert.equal(isUserChosenPath(folder, 'write-dir', sets), true);
    assert.equal(isUserChosenPath(path.join(folder, 'x.bahibak'), 'read-file', sets), true);
    assert.equal(isUserChosenPath(path.resolve('/media/usb/Backups-other/x.bahibak'), 'read-file', sets), false);
    assert.equal(isUserChosenPath(path.resolve('/etc/passwd'), 'read-file', sets), false);
  });
});
