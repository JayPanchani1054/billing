import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { mimeTypeFor, resolveAppPath } from './protocol.ts';

const root = path.resolve('/srv/bahi/out/renderer');

describe('resolveAppPath', () => {
  it('maps app URLs into the renderer folder', () => {
    assert.equal(resolveAppPath(root, 'app://bahi/'), path.join(root, 'index.html'));
    assert.equal(resolveAppPath(root, 'app://bahi/index.html'), path.join(root, 'index.html'));
    assert.equal(resolveAppPath(root, 'app://bahi/assets/index-abc123.js'), path.join(root, 'assets', 'index-abc123.js'));
    assert.equal(resolveAppPath(root, 'app://bahi/assets/Noto%20Sans.woff2'), path.join(root, 'assets', 'Noto Sans.woff2'));
    assert.equal(resolveAppPath(root, 'app://bahi/index.html?x=1#y'), path.join(root, 'index.html'));
  });

  it('never escapes the renderer folder', () => {
    for (const url of [
      'app://bahi/../../etc/passwd',
      'app://bahi/%2e%2e/%2e%2e/secret.txt',
      'app://bahi/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
      'app://bahi/..%5c..%5cWindows%5cwin.ini',
      'app://bahi/C:/Windows/win.ini',
      'app://bahi/index.html:$DATA',
      'app://bahi/a%00.js',
      'app://bahi/%E0%A4%A',
    ]) {
      const resolved = resolveAppPath(root, url);
      assert.ok(resolved === null || resolved.startsWith(root + path.sep), `${url} → ${resolved}`);
    }
    assert.equal(resolveAppPath(root, 'app://bahi/a%00.js'), null);
    assert.equal(resolveAppPath(root, 'app://bahi/..%5c..%5cwin.ini'), null);
  });

  it('rejects other hosts and schemes', () => {
    assert.equal(resolveAppPath(root, 'app://evil/index.html'), null);
    assert.equal(resolveAppPath(root, 'file:///srv/bahi/out/renderer/index.html'), null);
    assert.equal(resolveAppPath(root, 'not a url'), null);
  });
});

describe('mimeTypeFor', () => {
  it('serves module scripts and styles with correct types', () => {
    assert.equal(mimeTypeFor('index.html'), 'text/html; charset=utf-8');
    assert.equal(mimeTypeFor('a/b/index-1.js'), 'text/javascript; charset=utf-8');
    assert.equal(mimeTypeFor('x.CSS'), 'text/css; charset=utf-8');
    assert.equal(mimeTypeFor('font.woff2'), 'font/woff2');
    assert.equal(mimeTypeFor('logo.svg'), 'image/svg+xml');
    assert.equal(mimeTypeFor('unknown.bin'), 'application/octet-stream');
  });
});
