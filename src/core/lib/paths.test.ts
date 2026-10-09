import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { PathUse } from '../api/context.ts';
import { AppError } from './errors.ts';
import { authorizeUserPath, isUncOrDevicePath, isWithin } from './paths.ts';

const root = path.resolve('/srv/bahi-data');
const logs: string[] = [];
const app = (authorize?: (p: string, use: PathUse) => boolean) => ({
  dataDir: root,
  log: (_l: string, m: string) => void logs.push(m),
  ...(authorize ? { authorizePath: authorize } : {}),
});
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof AppError ? e.code : 'THROWN';
  }
};
const opts = { field: 'path', what: 'backup file' };

describe('renderer path authorisation', () => {
  it('recognises UNC and device paths in either slash style', () => {
    for (const p of ['\\\\host\\share\\x.bahibak', '//host/share/x', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', ' \\\\host\\s']) assert.equal(isUncOrDevicePath(p), true, p);
    for (const p of ['C:\\Backups', '/home/u/b', 'D:/x', '\\x']) assert.equal(isUncOrDevicePath(p), false, p);
  });

  it('isWithin: equal or below, never a sibling with a common prefix or a parent', () => {
    assert.equal(isWithin(root, root), true);
    assert.equal(isWithin(root, path.join(root, 'backups', 'a.bahibak')), true);
    assert.equal(isWithin(root, `${root}-evil/a.bahibak`), false);
    assert.equal(isWithin(root, path.join(root, '..', 'x')), false);
  });

  it('the data folder and trusted roots need no dialog; anything else needs main’s approval', () => {
    const chosen = path.resolve('/home/u/picked.bahibak');
    const a = app((p, use) => use === 'read-file' && p === chosen);
    assert.equal(authorizeUserPath(a, path.join(root, 'backups', 'c1', 'x.bahibak'), 'read-file', opts), path.join(root, 'backups', 'c1', 'x.bahibak'));
    assert.equal(authorizeUserPath(a, chosen, 'read-file', opts), chosen);
    assert.equal(code(() => authorizeUserPath(a, chosen, 'write-dir', opts)), 'FORBIDDEN', 'approval is per use');
    assert.equal(code(() => authorizeUserPath(a, '/etc/passwd', 'read-file', opts)), 'FORBIDDEN');
    // Traversal out of the data folder is resolved before the check.
    assert.equal(code(() => authorizeUserPath(a, `${root}/../elsewhere/x.bahibak`, 'read-file', opts)), 'FORBIDDEN');
    const trusted = path.resolve('/mnt/nas/backups');
    assert.equal(authorizeUserPath(a, `${trusted}/x.bahibak`, 'read-file', { ...opts, trusted: [null, trusted] }), path.join(trusted, 'x.bahibak'));
  });

  it('UNC/device paths are refused unless main approves them (no authorizer = refuse)', () => {
    if (path.isAbsolute('//host/share/x.bahibak')) {
      assert.equal(code(() => authorizeUserPath(app(), '//host/share/x.bahibak', 'read-file', opts)), 'FORBIDDEN');
      assert.equal(authorizeUserPath(app(() => true), '//host/share/x.bahibak', 'read-file', opts), path.resolve('//host/share/x.bahibak'));
    }
    // Ordinary local paths pass without an authorizer (tests, headless use).
    assert.equal(authorizeUserPath(app(), '/tmp/x.bahibak', 'read-file', opts), path.resolve('/tmp/x.bahibak'));
  });

  it('malformed paths are a validation error', () => {
    for (const p of ['', 'relative/x', '/tmp/a\0b']) assert.equal(code(() => authorizeUserPath(app(), p, 'read-file', opts)), 'VALIDATION', JSON.stringify(p));
  });
});
