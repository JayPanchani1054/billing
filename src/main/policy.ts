/**
 * Pure security decisions for the main process — no Electron imports, so every rule here is unit-tested
 * under plain Node (policy.test.ts). security.ts, external.ts and ipc.ts apply these decisions.
 */
import { APP_HOST, APP_SCHEME, MAX_ROUTE_LENGTH } from './config.ts';
import type { DevServer } from './config.ts';

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** True when `raw` is a URL of the app itself (app://pevqori/… or, in development, the Vite server). */
export function isAppUrl(raw: string, dev: DevServer | null): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  if (url.protocol === `${APP_SCHEME}:`) return url.host === APP_HOST;
  return dev !== null && url.protocol === 'http:' && url.host === dev.host;
}

/** Minimal shape of Electron's WebFrameMain needed for the IPC origin check. */
export interface FrameLike {
  readonly url: string;
  readonly parent: unknown;
}

/** IPC may only come from the top-level frame of an app document. */
export function isTrustedFrame(frame: FrameLike | null | undefined, dev: DevServer | null): boolean {
  if (!frame) return false;
  if (frame.parent !== null) return false;
  return isAppUrl(frame.url, dev);
}

/** Content-Security-Policy sent with every app document (a header, so it covers every response). */
export function contentSecurityPolicy(dev: DevServer | null): string {
  const script = ["'self'"];
  const connect = ["'self'"];
  if (dev) {
    // Vite's React Fast Refresh preamble is an inline module script — development only.
    script.push("'unsafe-inline'");
    connect.push(`http://${dev.host}`, `ws://${dev.host}`);
  }
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** The only permission the app uses: writing sanitised text to the clipboard (copy buttons). */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

/** Schemes the app session may load besides app://pevqori. Everything else (http, https, file, …) is cancelled. */
const LOCAL_SCHEMES: ReadonlySet<string> = new Set(['data:', 'blob:', 'about:', 'devtools:']);

/** Network policy for the app session: Pevqori is offline-first and never needs the internet. */
export function isAllowedAppRequest(raw: string, dev: DevServer | null): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  if (url.protocol === `${APP_SCHEME}:`) return url.host === APP_HOST;
  if (LOCAL_SCHEMES.has(url.protocol)) return true;
  return dev !== null && (url.protocol === 'http:' || url.protocol === 'ws:') && url.host === dev.host;
}

const MAX_EXTERNAL_URL_LENGTH = 2048;

/**
 * Validate a URL that is about to be handed to the OS. Only https: (no embedded credentials) and
 * mailto: are allowed — never file:, javascript:, smb:, ms-* or other custom protocol handlers.
 */
export function parseExternalUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_EXTERNAL_URL_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const url = parseUrl(raw);
  if (!url) return null;
  if (url.protocol === 'https:') return url.username || url.password || !url.hostname ? null : url;
  if (url.protocol === 'mailto:') return url;
  return null;
}

/**
 * '<module>.<entity>.<action>' — letters, digits and underscores with at least one dot. Requiring a dot
 * also guarantees a name can never alias an Object.prototype member ('constructor', '__proto__').
 */
const ROUTE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

export function isValidRouteName(route: unknown): route is string {
  return typeof route === 'string' && route.length > 0 && route.length < MAX_ROUTE_LENGTH && ROUTE_PATTERN.test(route);
}
