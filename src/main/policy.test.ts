import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { absoluteEnvPath, resolveDevServer } from './config.ts';
import { contentSecurityPolicy, isAllowedAppRequest, isAppUrl, isTrustedFrame, isValidRouteName, parseExternalUrl } from './policy.ts';

const DEV = resolveDevServer('http://127.0.0.1:5173/', false);

describe('resolveDevServer', () => {
  it('accepts loopback http URLs in unpackaged runs', () => {
    assert.deepEqual(DEV, { url: 'http://127.0.0.1:5173/', origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' });
    assert.equal(resolveDevServer('http://localhost:5173', false)?.host, 'localhost:5173');
  });

  it('is ignored in packaged builds and for remote or non-http URLs', () => {
    assert.equal(resolveDevServer('http://127.0.0.1:5173/', true), null);
    assert.equal(resolveDevServer('http://evil.example:5173/', false), null);
    assert.equal(resolveDevServer('https://127.0.0.1:5173/', false), null);
    assert.equal(resolveDevServer('http://user:pw@127.0.0.1:5173/', false), null);
    assert.equal(resolveDevServer('not a url', false), null);
    assert.equal(resolveDevServer(undefined, false), null);
  });
});

describe('absoluteEnvPath', () => {
  it('accepts only absolute paths', () => {
    assert.equal(absoluteEnvPath(undefined), null);
    assert.equal(absoluteEnvPath('relative/dir'), null);
    assert.equal(absoluteEnvPath('/tmp/a\0b'), null);
    assert.ok(absoluteEnvPath(process.platform === 'win32' ? 'C:\\data' : '/tmp/data'));
  });
});

describe('isAppUrl', () => {
  it('recognises the app origin only', () => {
    assert.equal(isAppUrl('app://bahi/index.html', null), true);
    assert.equal(isAppUrl('app://bahi/assets/x.js', null), true);
    assert.equal(isAppUrl('app://other/index.html', null), false);
    assert.equal(isAppUrl('file:///C:/index.html', null), false);
    assert.equal(isAppUrl('https://bahi/index.html', null), false);
    assert.equal(isAppUrl('garbage', null), false);
  });

  it('accepts the dev server only when one is configured', () => {
    assert.equal(isAppUrl('http://127.0.0.1:5173/', null), false);
    assert.equal(isAppUrl('http://127.0.0.1:5173/', DEV), true);
    assert.equal(isAppUrl('http://127.0.0.1:5174/', DEV), false);
    assert.equal(isAppUrl('https://127.0.0.1:5173/', DEV), false);
  });
});

describe('isTrustedFrame', () => {
  it('requires a top-level frame on the app origin', () => {
    assert.equal(isTrustedFrame({ url: 'app://bahi/index.html', parent: null }, null), true);
    assert.equal(isTrustedFrame({ url: 'app://bahi/index.html', parent: {} }, null), false, 'sub-frames are refused');
    assert.equal(isTrustedFrame({ url: 'https://example.com/', parent: null }, null), false);
    assert.equal(isTrustedFrame(null, null), false);
  });
});

describe('contentSecurityPolicy', () => {
  it('is strict in production', () => {
    const csp = contentSecurityPolicy(null);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /connect-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  });

  it('only opens the dev server in development', () => {
    const csp = contentSecurityPolicy(DEV);
    assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:5173 ws:\/\/127\.0\.0\.1:5173/);
  });
});

describe('isAllowedAppRequest', () => {
  it('blocks the network and file system, allows local schemes', () => {
    assert.equal(isAllowedAppRequest('app://bahi/assets/index.js', null), true);
    assert.equal(isAllowedAppRequest('data:image/png;base64,AAAA', null), true);
    assert.equal(isAllowedAppRequest('blob:app://bahi/123', null), true);
    assert.equal(isAllowedAppRequest('https://example.com/', null), false);
    assert.equal(isAllowedAppRequest('http://127.0.0.1:5173/', null), false);
    assert.equal(isAllowedAppRequest('file:///etc/passwd', null), false);
    assert.equal(isAllowedAppRequest('app://other/x', null), false);
  });

  it('allows only the dev server (http + HMR websocket) in development', () => {
    assert.equal(isAllowedAppRequest('http://127.0.0.1:5173/src/main.tsx', DEV), true);
    assert.equal(isAllowedAppRequest('ws://127.0.0.1:5173/?token=x', DEV), true);
    assert.equal(isAllowedAppRequest('http://127.0.0.1:8080/', DEV), false);
  });
});

describe('parseExternalUrl', () => {
  it('allows https and mailto only', () => {
    assert.equal(parseExternalUrl('https://www.gst.gov.in/')?.hostname, 'www.gst.gov.in');
    assert.equal(parseExternalUrl('mailto:accounts@example.com')?.protocol, 'mailto:');
    for (const bad of [
      'http://example.com/',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'smb://server/share',
      'ms-settings:privacy',
      'https://user:pass@example.com/',
      'https://exa\nmple.com/',
      `https://example.com/${'a'.repeat(3000)}`,
      42,
      '',
    ]) {
      assert.equal(parseExternalUrl(bad), null, String(bad).slice(0, 40));
    }
  });
});

describe('isValidRouteName', () => {
  it('accepts dotted route names', () => {
    for (const ok of ['app.state', 'accounts.ledger.save', 'gst.gstr1.export', 'app.auth.changePassword']) {
      assert.equal(isValidRouteName(ok), true, ok);
    }
  });

  it('rejects malformed, prototype-aliasing and oversized names', () => {
    for (const bad of ['constructor', '__proto__', 'toString', '', '.state', 'app.', 'app..state', 'app.state;drop', 'a'.repeat(64) + '.' + 'b'.repeat(64), 42, null]) {
      assert.equal(isValidRouteName(bad), false, String(bad).slice(0, 40));
    }
  });
});
