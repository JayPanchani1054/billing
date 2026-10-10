/**
 * HTML → PDF / printer, rendered in a hidden, sandboxed, JavaScript-disabled window that lives in an
 * in-memory session with no network access.
 *
 * The HTML is served from memory over `pevqori-print://<job-id>/document.html` (one random origin per job)
 * instead of a data: URL, so large multi-page reports are not limited by Chromium's 2 MB URL cap.
 * The document gets a CSP that forbids scripts and every non-inline resource except data:/blob: images
 * and fonts, and the session cancels any request that is not part of the job.
 */
import { randomUUID } from 'node:crypto';
import { BrowserWindow, session } from 'electron';
import type { Session } from 'electron';
import { PRINT_PARTITION, PRINT_SCHEME } from './config.ts';
import { log } from './log.ts';
import { marginsFor, pdfPageOptions, printPageOptions, type PageSpec } from './printPage.ts';

export type PageSize = 'A4' | 'A5' | 'Letter' | 'Legal';
export type PdfMargins = 'default' | 'none' | 'minimum';

export interface PdfOptions {
  /** Named sheet (with orientation) or a continuous receipt roll (printPage.ts). */
  page: PageSpec;
  margins: PdfMargins;
}

export interface PrintOptions {
  silent: boolean;
  copies: number;
  page: PageSpec;
  /** Sheets only: 'none' for documents positioned to the millimetre (cheques on A4). Default 'default'. */
  margins?: 'default' | 'none';
  /** OS printer name (from printers()); omitted: the system default / the dialog's choice. */
  deviceName?: string;
}

export interface PrinterSummary {
  name: string;
  displayName: string;
  description: string;
}

export interface PrintService {
  toPdf(html: string, options: PdfOptions): Promise<Uint8Array>;
  print(html: string, options: PrintOptions, parent: BrowserWindow | null): Promise<boolean>;
  /** Printers installed on this computer (for direct printing to a receipt printer). */
  printers(parent: BrowserWindow | null): Promise<PrinterSummary[]>;
}

const PRINT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

/** printToPDF margins are in inches. 'default' ≈ 1 cm (Chromium's default), 'minimum' ≈ 5 mm. */
const PDF_MARGINS: Record<PdfMargins, { top: number; bottom: number; left: number; right: number }> = {
  default: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
  minimum: { top: 0.2, bottom: 0.2, left: 0.2, right: 0.2 },
  none: { top: 0, bottom: 0, left: 0, right: 0 },
};

const MAX_CONCURRENT_JOBS = 2;
const LOAD_TIMEOUT_MS = 30_000;
const PDF_TIMEOUT_MS = 120_000;
/** The OS print dialog is interactive — give the user plenty of time. */
const PRINT_TIMEOUT_MS = 15 * 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function createPrintService(): PrintService {
  const documents = new Map<string, string>();
  let printSession: Session | null = null;
  let active = 0;
  const waiting: Array<() => void> = [];

  function getSession(): Session {
    if (printSession) return printSession;
    const ses = session.fromPartition(PRINT_PARTITION);
    if (ses.protocol.isProtocolHandled(PRINT_SCHEME)) ses.protocol.unhandle(PRINT_SCHEME); // retry after a partial setup
    ses.protocol.handle(PRINT_SCHEME, (request) => {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return new Response('Bad request', { status: 400 });
      }
      const html = url.pathname === '/document.html' ? documents.get(url.host) : undefined;
      if (html === undefined || request.method !== 'GET') return new Response('Not found', { status: 404 });
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': PRINT_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(details.url)?.[1]?.toLowerCase() ?? '';
      const allowed = scheme === PRINT_SCHEME || scheme === 'data' || scheme === 'blob' || scheme === 'about';
      if (!allowed) log('warn', 'Blocked request from a print document', { scheme });
      callback({ cancel: !allowed });
    });
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler?.(() => false);
    ses.setSpellCheckerEnabled(false);
    printSession = ses;
    return ses;
  }

  /** Simple semaphore: at most MAX_CONCURRENT_JOBS hidden windows; a released slot passes straight to the next waiter. */
  async function acquire(): Promise<void> {
    if (active < MAX_CONCURRENT_JOBS) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  async function withDocument<T>(html: string, parent: BrowserWindow | null, timeoutMs: number, run: (win: BrowserWindow) => Promise<T>): Promise<T> {
    await acquire();
    const jobId = randomUUID();
    documents.set(jobId, html);
    let win: BrowserWindow | null = null;
    try {
      getSession();
      win = new BrowserWindow({
        show: false,
        width: 900,
        height: 1200,
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        skipTaskbar: true,
        webPreferences: {
          partition: PRINT_PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          javascript: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          spellcheck: false,
          navigateOnDragDrop: false,
          devTools: false,
          backgroundThrottling: false,
        },
      });
      await withTimeout(win.loadURL(`${PRINT_SCHEME}://${jobId}/document.html`), LOAD_TIMEOUT_MS, 'Loading the print document');
      return await withTimeout(run(win), timeoutMs, 'Printing');
    } finally {
      documents.delete(jobId);
      if (win && !win.isDestroyed()) win.destroy();
      release();
    }
  }

  return {
    toPdf(html, options) {
      return withDocument(html, null, PDF_TIMEOUT_MS, async (win) => {
        const page = pdfPageOptions(options.page);
        const pdf = await win.webContents.printToPDF({
          pageSize: page.pageSize,
          landscape: page.landscape,
          printBackground: true,
          margins: PDF_MARGINS[marginsFor(options.page, options.margins)],
        });
        return new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength);
      });
    },

    print(html, options, parent) {
      const page = printPageOptions(options.page);
      const edgeToEdge = marginsFor(options.page, options.margins ?? 'default') === 'none';
      return withDocument(html, parent, PRINT_TIMEOUT_MS, (win) =>
        new Promise<boolean>((resolve, reject) => {
          win.webContents.print(
            {
              silent: options.silent,
              printBackground: true,
              landscape: page.landscape,
              copies: options.copies,
              pageSize: page.pageSize,
              margins: { marginType: edgeToEdge ? 'none' : 'default' },
              ...(options.deviceName ? { deviceName: options.deviceName } : {}),
            },
            (success, failureReason) => {
              if (success) resolve(true);
              else if (!failureReason || /cancel/i.test(failureReason)) resolve(false);
              else reject(new Error(`Printing failed: ${failureReason}`));
            },
          );
        }),
      );
    },

    async printers(parent) {
      // Any live webContents can list printers; the app window is always there when the renderer asks.
      const contents = parent && !parent.isDestroyed() ? parent.webContents : null;
      if (!contents) return [];
      const list = await contents.getPrintersAsync();
      return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, description: p.description ?? '' }));
    },
  };
}
