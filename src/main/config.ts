/**
 * Static configuration of the Electron shell: custom schemes, origins, file locations and
 * environment overrides. Everything here is computed once at startup and never changes.
 */
import path from 'node:path';

/** Privileged custom scheme that serves the built renderer (no file:// loading). */
export const APP_SCHEME = 'app';
export const APP_HOST = 'pevqori';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_START_URL = `${APP_ORIGIN}/index.html`;

/** Scheme + in-memory session used by hidden, script-less print/PDF windows. */
export const PRINT_SCHEME = 'pevqori-print';
/** No `persist:` prefix → the partition lives in memory only and is discarded on quit. */
export const PRINT_PARTITION = 'pevqori-print';

/** Window background = renderer `--surface-0` (styles/tokens.css) per theme, to avoid a white flash. */
export const WINDOW_BACKGROUND = { dark: '#101318', light: '#f6f7f9' } as const;

export const WINDOW_DEFAULTS = { width: 1360, height: 860, minWidth: 1024, minHeight: 680 } as const;

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.5;
export const ZOOM_STEP = 0.1;

/** Maximum route name length accepted over IPC. */
export const MAX_ROUTE_LENGTH = 128;

declare const __PEVQORI_VERSION__: string | undefined;

/**
 * App version baked in at build time by scripts/build.mjs (so `electron out/main/index.cjs`, used by
 * the E2E suite, reports the product version rather than Electron's). Falls back to Electron's value.
 */
export function bakedVersion(): string | null {
  return typeof __PEVQORI_VERSION__ === 'string' && __PEVQORI_VERSION__.length > 0 ? __PEVQORI_VERSION__ : null;
}

export interface BundlePaths {
  preload: string;
  renderer: string;
  /** Only present in a source checkout (dev/E2E); packaged builds use the exe's embedded icon. */
  devIcon: string;
}

/**
 * Bundled layout: out/main/index.cjs, out/preload/index.cjs, out/renderer/index.html. A function (not a
 * constant) so this module stays importable from plain-Node unit tests, where __dirname is undefined.
 */
export function bundlePaths(mainDir: string = __dirname): BundlePaths {
  return {
    preload: path.join(mainDir, '..', 'preload', 'index.cjs'),
    renderer: path.join(mainDir, '..', 'renderer'),
    devIcon: path.join(mainDir, '..', '..', 'build', 'icon.png'),
  };
}

export interface DevServer {
  /** e.g. http://127.0.0.1:5173/ */
  url: string;
  /** e.g. http://127.0.0.1:5173 */
  origin: string;
  /** host:port, used for the CSP connect-src and the network allowlist. */
  host: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Resolve PEVQORI_DEV_SERVER_URL. Only honoured for unpackaged runs and only for a loopback http URL,
 * so an environment variable can never point a shipped build at remote content.
 */
export function resolveDevServer(raw: string | undefined, isPackaged: boolean): DevServer | null {
  if (isPackaged || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) return null;
  return { url: url.href, origin: url.origin, host: url.host };
}

/** Absolute-path environment override (PEVQORI_USER_DATA, PEVQORI_DATA_DIR); relative values are ignored. */
export function absoluteEnvPath(raw: string | undefined): string | null {
  if (!raw || raw.length > 1024 || raw.includes('\0')) return null;
  return path.isAbsolute(raw) ? path.resolve(raw) : null;
}
