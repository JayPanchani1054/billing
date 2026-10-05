/**
 * Electron hardening that is not tied to a particular window: origin checks, Content-Security-Policy,
 * session permission/network policy and per-WebContents navigation guards.
 *
 * Threat model (docs/SECURITY.md): the renderer is untrusted. Even if script injection happened in the
 * renderer it must not be able to reach the network, open other windows, navigate elsewhere, embed
 * webviews, use device permissions, or call IPC from a foreign origin or sub-frame.
 */
import { BrowserWindow } from 'electron';
import type { Session, WebContents } from 'electron';
import type { DevServer } from './config.ts';
import { handleExternalNavigation } from './external.ts';
import { log } from './log.ts';
import { ALLOWED_PERMISSIONS, contentSecurityPolicy, isAllowedAppRequest, isAppUrl } from './policy.ts';

export { contentSecurityPolicy, isAppUrl, isTrustedFrame } from './policy.ts';

const reportedBlocks = new Set<string>();

function reportBlocked(raw: string): void {
  let key: string;
  try {
    const url = new URL(raw);
    key = `${url.protocol}//${url.host}`;
  } catch {
    key = 'invalid-url';
  }
  if (reportedBlocks.has(key) || reportedBlocks.size > 200) return;
  reportedBlocks.add(key);
  log('warn', 'Blocked outbound request (the app is offline-only)', { target: key });
}

/**
 * Lock down the app session: deny permissions, enforce CSP on app documents, and cancel every
 * request that is not served locally. Bahi ERP is offline-first — it never needs the network.
 */
export function hardenAppSession(ses: Session, dev: DevServer | null): void {
  const csp = contentSecurityPolicy(dev);

  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    const granted = ALLOWED_PERMISSIONS.has(permission);
    if (!granted) log('warn', 'Denied permission request', { permission });
    callback(granted);
  });
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
  ses.setDevicePermissionHandler?.(() => false);
  ses.setSpellCheckerEnabled(false);

  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedAppRequest(details.url, dev);
    if (!allowed) reportBlocked(details.url);
    callback({ cancel: !allowed });
  });

  ses.webRequest.onHeadersReceived((details, callback) => {
    if (!isAppUrl(details.url, dev)) {
      callback({});
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
      if (key.toLowerCase() !== 'content-security-policy') headers[key] = value;
    }
    headers['Content-Security-Policy'] = [csp];
    callback({ responseHeaders: headers });
  });
}

/**
 * Guards applied to EVERY WebContents the app creates (main window, print windows, devtools):
 * no webviews, no new windows, no navigation away from the app origin.
 */
export function hardenWebContents(contents: WebContents, dev: DevServer | null): void {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log('warn', 'Blocked <webview> attachment');
  });

  contents.setWindowOpenHandler(({ url }) => {
    handleExternalNavigation(url, BrowserWindow.fromWebContents(contents));
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, dev)) return;
    event.preventDefault();
    handleExternalNavigation(url, BrowserWindow.fromWebContents(contents));
  });

  contents.on('will-redirect', (event, url) => {
    if (isAppUrl(url, dev)) return;
    event.preventDefault();
    log('warn', 'Blocked redirect away from the app origin');
  });
}
