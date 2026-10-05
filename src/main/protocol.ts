/**
 * Serves the built renderer from out/renderer over the privileged `app://bahi/` scheme.
 *
 * Why not file://? file: pages get broad local read access and share one opaque origin; a custom
 * standard + secure scheme gives the renderer a real origin (`app://bahi`), CSP/same-origin rules,
 * and lets us control every response header. Requests are confined to the renderer folder.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CustomScheme, Protocol } from 'electron';
import { APP_HOST, APP_SCHEME, PRINT_SCHEME } from './config.ts';
import { describeError, log } from './log.ts';

/** Must be passed to protocol.registerSchemesAsPrivileged BEFORE app 'ready'. */
export const PRIVILEGED_SCHEMES: CustomScheme[] = [
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true },
  },
  {
    // Print documents: standard + secure so each job has a proper (isolated) origin. No fetch/CORS.
    scheme: PRINT_SCHEME,
    privileges: { standard: true, secure: true },
  },
];

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

export function mimeTypeFor(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

/**
 * Map a request URL to a file inside `root`, or null when it is outside, malformed or suspicious.
 * Exported for unit tests.
 */
export function resolveAppPath(root: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // No NULs, no backslashes (Windows separators), no drive letters / NTFS alternate data streams.
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.includes(':')) return null;
  if (pathname === '' || pathname === '/') pathname = '/index.html';
  const normalized = path.posix.normalize(pathname);
  if (!normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, `.${normalized}`);
  const rel = path.relative(base, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return resolved;
}

/** Register the app:// handler on the given (default) session protocol. Call after 'ready'. */
export function registerAppProtocol(protocol: Protocol, rendererRoot: string, csp: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'Method not allowed');
    const file = resolveAppPath(rendererRoot, request.url);
    if (!file) return textResponse(404, 'Not found');
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) return textResponse(404, 'Not found');
      const headers: Record<string, string> = {
        'Content-Type': mimeTypeFor(file),
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'same-origin',
      };
      if (file.endsWith('.html')) headers['Content-Security-Policy'] = csp;
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
      // Copy into an ArrayBuffer-backed Uint8Array: a valid BodyInit across @types/node versions.
      const body = new Uint8Array(await fsp.readFile(file));
      return new Response(body, { status: 200, headers });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return textResponse(404, 'Not found');
      log('error', 'app:// protocol read failed', describeError(err));
      return textResponse(500, 'Internal error');
    }
  });
}
