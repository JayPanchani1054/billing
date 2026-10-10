/**
 * Implementation of every NativeActions entry (src/shared/bridge.ts). Each payload is untrusted and is
 * validated here, again, regardless of what the renderer's types promise. Handlers never throw across
 * IPC: failures become ApiResult errors with accountant-readable messages (no stacks, no paths that
 * the user did not choose).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, nativeTheme, shell } from 'electron';
import type {
  BrowserWindow,
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
  WebContents,
} from 'electron';
import type { ApiResult } from '../shared/api.ts';
import type { FileFilter, NativeAction, NativeActions } from '../shared/bridge.ts';
import { AppError, toErrorPayload } from '../core/lib/errors.ts';
import { LEGACY_BACKUP_EXTENSION } from '../core/lib/legacyNames.ts';
import { BACKUP_EXTENSION } from '../shared/types/data.ts';
import type { Runtime } from '../core/app/runtime.ts';
import { checkOpenCopy, writeOpenCopy } from './attachments.ts';
import { openExternalUrl, parseExternalUrl } from './external.ts';
import { isPathInside, PathSet, sanitizeFileName, writeFileAtomic } from './files.ts';
import { rememberChosenFile, rememberChosenFolder } from './user-choices.ts';
import { describeError, log } from './log.ts';
import { isThemeMode } from './prefs.ts';
import type { PdfMargins, PrintService } from './print.ts';
import { NATIVE_PAGE_SIZES, resolvePageSpec, validPrinterName, type PageSpec } from './printPage.ts';
import { buildDraftEml, ensureSharedExportsDir, freeFileName, indianMobileForWhatsapp, mailtoUrl, MAX_SHARE_URL, parseRecipients, SharedFolderError, whatsappUrl } from './share.ts';
import type { WindowManager } from './window.ts';

export const MAX_OPEN_BYTES = 100 * 1024 * 1024;
const MAX_SAVE_BYTES = 512 * 1024 * 1024;
/** Print HTML is self-contained (inline CSS, data: images); 64 MB of text is far beyond any real report. */
const MAX_HTML_CHARS = 64 * 1024 * 1024;

export interface NativeCallContext {
  sender: WebContents;
  window: BrowserWindow | null;
}

export interface NativeDeps {
  /** Core runtime: data dir (can change while the app runs), log, persisted theme. */
  runtime: Runtime;
  windows: WindowManager;
  print: PrintService;
  appVersion: string;
  paths: { userData: string; logs: string; documents: string };
  /** Quit (optionally relaunch) without the unsaved-work prompt — the renderer asked for it. */
  requestQuit(options: { relaunch: boolean }): void;
}

export type NativeHandler = (ctx: NativeCallContext, action: unknown, payload: unknown) => Promise<ApiResult<unknown>>;

type Handler<A extends NativeAction> = (payload: unknown, ctx: NativeCallContext) => Promise<NativeActions[A]['out']>;
type HandlerMap = { [A in NativeAction]: Handler<A> };

// ───────────────────────────── payload validation ─────────────────────────────

function invalid(message: string): AppError {
  return new AppError('VALIDATION', message);
}

function record(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('Invalid request.');
  return payload as Record<string, unknown>;
}

function text(o: Record<string, unknown>, key: string, max: number): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw invalid(`Invalid ${key}.`);
  return v;
}

function optText(o: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) throw invalid(`Invalid ${key}.`);
  return v;
}

function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw invalid(`Invalid ${key}.`);
  return v;
}

function optEnum<T extends string>(o: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw invalid(`Invalid ${key}.`);
  return v as T;
}

function html(o: Record<string, unknown>): string {
  const v = o.html;
  if (typeof v !== 'string' || v.length === 0) throw invalid('Nothing to print.');
  if (v.length > MAX_HTML_CHARS) throw new AppError('BUSINESS_RULE', 'This document is too large to print. Narrow the period or filters and try again.');
  return v;
}

function fileFilters(v: unknown): FileFilter[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 20) throw invalid('Invalid file filters.');
  return v.map((item: unknown) => {
    const o = record(item);
    const name = text(o, 'name', 100);
    const ext = o.extensions;
    if (!Array.isArray(ext) || ext.length === 0 || ext.length > 50) throw invalid('Invalid file filters.');
    const extensions = ext.map((e: unknown) => {
      if (typeof e !== 'string' || !/^(\*|[A-Za-z0-9_-]{1,16})$/.test(e)) throw invalid('Invalid file filters.');
      return e;
    });
    // Backups made before the rename carry the legacy extension: offer them wherever backups are picked.
    if (extensions.includes(BACKUP_EXT) && !extensions.includes(LEGACY_BACKUP_EXT)) extensions.push(LEGACY_BACKUP_EXT);
    return { name, extensions };
  });
}

const BACKUP_EXT = BACKUP_EXTENSION.slice(1);
const LEGACY_BACKUP_EXT = LEGACY_BACKUP_EXTENSION.slice(1);

function optAbsolutePath(o: Record<string, unknown>, key: string): string | undefined {
  const v = optText(o, key, 1024);
  if (v === undefined || v.includes('\0') || !path.isAbsolute(v)) return undefined; // dialog hint only
  return path.resolve(v);
}

/** Paper requested by the renderer: named sheet (+ orientation) or a receipt roll of a measured length. */
function pageSpec(o: Record<string, unknown>): PageSpec {
  const size = optEnum(o, 'pageSize', NATIVE_PAGE_SIZES);
  const h = o.rollHeightMm;
  if (h !== undefined && h !== null && (typeof h !== 'number' || !Number.isFinite(h))) throw invalid('Invalid receipt length.');
  try {
    const custom = o.customPageMm;
    const customMm = custom !== null && typeof custom === 'object' && !Array.isArray(custom) ? (custom as { width: unknown; height: unknown }) : undefined;
    return resolvePageSpec(size, optBool(o, 'landscape'), (h ?? undefined) as number | undefined, customMm);
  } catch (err) {
    throw invalid(err instanceof Error ? err.message : 'Invalid paper size.');
  }
}

/** Share texts: bounded, no NUL. Line breaks are allowed in bodies, never in subjects (header). */
function shareText(o: Record<string, unknown>, key: string, max: number, singleLine: boolean): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length > max || v.includes('\0')) throw invalid(`Invalid ${key}.`);
  // eslint-disable-next-line no-control-regex
  if (singleLine && /[\u0000-\u001f\u007f]/.test(v)) throw invalid(`The ${key} must be a single line.`);
  return v;
}
const PDF_MARGINS: readonly PdfMargins[] = ['default', 'none', 'minimum'];
const THEMES = ['system', 'light', 'dark'] as const;

/** Copy into a standalone buffer: IPC structured clone sends a view's ENTIRE backing ArrayBuffer. */
function standaloneBytes(buf: Uint8Array): Uint8Array {
  return buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
    ? new Uint8Array(buf.buffer, 0, buf.byteLength)
    : new Uint8Array(buf);
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Turn file-system errors into messages an accountant can act on. */
function fileError(err: unknown, action: 'open' | 'save'): AppError {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return new AppError(
      'BUSINESS_RULE',
      action === 'save'
        ? 'Could not save the file. It may be open in another program (close it and try again), or the folder may be read-only.'
        : 'Could not open the file. It may be in use by another program, or you may not have permission to read it.',
    );
  }
  if (code === 'ENOSPC') return new AppError('BUSINESS_RULE', 'Could not save the file: the disk is full.');
  if (code === 'ENOENT') return new AppError('NOT_FOUND', 'The file or folder no longer exists.');
  log('error', `File ${action} failed`, describeError(err));
  return new AppError('INTERNAL', `Could not ${action} the file. Details have been written to the application log.`);
}

// ───────────────────────────── dialog helpers ─────────────────────────────

function showOpen(ctx: NativeCallContext, options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  return ctx.window && !ctx.window.isDestroyed() ? dialog.showOpenDialog(ctx.window, options) : dialog.showOpenDialog(options);
}

function showSave(ctx: NativeCallContext, options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  return ctx.window && !ctx.window.isDestroyed() ? dialog.showSaveDialog(ctx.window, options) : dialog.showSaveDialog(options);
}

function showBox(ctx: NativeCallContext, options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  return ctx.window && !ctx.window.isDestroyed() ? dialog.showMessageBox(ctx.window, options) : dialog.showMessageBox(options);
}

// ───────────────────────────── handlers ─────────────────────────────

export function createNativeHandler(deps: NativeDeps): NativeHandler {
  /** Paths the user picked in a dialog during this session (shell.showItem allowlist). */
  const chosen = new PathSet();
  let lastDir = deps.paths.documents;

  function remember(p: string, isDirectory: boolean): void {
    chosen.add(p);
    lastDir = isDirectory ? p : path.dirname(p);
  }

  async function askSavePath(ctx: NativeCallContext, title: string, defaultName: string, filters: FileFilter[] | undefined): Promise<string | null> {
    const res = await showSave(ctx, {
      title,
      defaultPath: path.join(lastDir, defaultName),
      filters,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (res.canceled || !res.filePath) return null;
    return path.resolve(res.filePath);
  }

  async function saveTo(target: string, data: Uint8Array | string): Promise<void> {
    try {
      await writeFileAtomic(target, data);
    } catch (err) {
      throw fileError(err, 'save');
    }
    remember(target, false);
  }

  /**
   * <data>/companies/<open company>/exports/shared, created on demand. Chosen here from the core's own
   * state — the renderer never names the folder (§8).
   */
  async function sharedFolder(): Promise<string> {
    const res = await deps.runtime.dispatch('app.state', {});
    const state = res.ok ? (res.data as { company?: { id?: unknown } | null } | null) : null;
    const id = state?.company && typeof state.company.id === 'string' ? state.company.id : null;
    if (!id) throw new AppError('NO_COMPANY', 'Open a company before sharing documents.');
    // The company folder must exist; 'exports' and 'shared' below it are created here, never followed
    // through a link or junction (share.ts ensureSharedExportsDir).
    const companyDir = path.join(deps.runtime.app.dataDir, 'companies', id);
    let dir: string | null;
    try {
      if (!(await fsp.stat(companyDir)).isDirectory()) throw new Error('not a folder');
      dir = await ensureSharedExportsDir(deps.runtime.app.dataDir, id);
    } catch (err) {
      if (err instanceof SharedFolderError) {
        log('warn', 'Refused a shared-documents folder that is not a plain folder of the company');
        throw new AppError('FORBIDDEN', `The folder for shared documents is not safe to use: ${err.message}`);
      }
      throw fileError(err, 'save');
    }
    if (!dir) throw new AppError('INTERNAL', 'The company folder could not be found. Details have been written to the application log.');
    return dir;
  }

  const handlers: HandlerMap = {
    async 'app.info'() {
      return {
        version: deps.appVersion,
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node,
        isPackaged: app.isPackaged,
        userDataDir: deps.paths.userData,
        logDir: deps.paths.logs,
      };
    },

    async 'dialog.chooseFolder'(payload, ctx) {
      const o = record(payload);
      const res = await showOpen(ctx, {
        title: text(o, 'title', 200),
        defaultPath: optAbsolutePath(o, 'defaultPath'),
        properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      const folder = path.resolve(res.filePaths[0]);
      remember(folder, true);
      rememberChosenFolder(folder); // also authorises it inside the core worker (see user-choices.ts)
      return { path: folder };
    },

    async 'dialog.openFile'(payload, ctx) {
      const o = record(payload);
      const title = text(o, 'title', 200);
      const filters = fileFilters(o.filters);
      const withPath = optBool(o, 'withPath') ?? false;
      const res = await showOpen(ctx, { title, filters, defaultPath: lastDir, properties: ['openFile', 'dontAddToRecent'] });
      if (res.canceled || res.filePaths.length === 0) return null;
      const file = path.resolve(res.filePaths[0]);
      let bytes: Uint8Array;
      try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) throw invalid('Please choose a file, not a folder.');
        if (stat.size > MAX_OPEN_BYTES) {
          throw new AppError('BUSINESS_RULE', `The selected file is ${formatMb(stat.size)}. Files larger than 100 MB cannot be opened.`);
        }
        bytes = await fsp.readFile(file);
      } catch (err) {
        throw err instanceof AppError ? err : fileError(err, 'open');
      }
      if (bytes.byteLength > MAX_OPEN_BYTES) throw new AppError('BUSINESS_RULE', 'Files larger than 100 MB cannot be opened.');
      remember(file, false);
      rememberChosenFile(file); // e.g. a backup file the renderer then asks the core to check or restore
      const result = { name: path.basename(file), size: bytes.byteLength, bytes: standaloneBytes(bytes) };
      return withPath ? { ...result, path: file } : result;
    },

    async 'dialog.saveFile'(payload, ctx) {
      const o = record(payload);
      const title = text(o, 'title', 200);
      const defaultName = sanitizeFileName(text(o, 'defaultName', 255));
      const filters = fileFilters(o.filters);
      const data = o.data;
      if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw invalid('Invalid file contents.');
      const size = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
      if (size > MAX_SAVE_BYTES) throw new AppError('BUSINESS_RULE', 'The file is too large to save.');
      const target = await askSavePath(ctx, title, defaultName, filters);
      if (!target) return null;
      await saveTo(target, data);
      return { path: target };
    },

    async 'dialog.confirm'(payload, ctx) {
      const o = record(payload);
      const danger = optBool(o, 'danger') ?? false;
      const { response } = await showBox(ctx, {
        type: danger ? 'warning' : 'question',
        title: text(o, 'title', 200),
        message: text(o, 'message', 2000),
        detail: optText(o, 'detail', 4000),
        buttons: [optText(o, 'okLabel', 60) || 'OK', 'Cancel'],
        // Destructive confirmations default to Cancel so a stray Enter cannot delete anything.
        defaultId: danger ? 1 : 0,
        cancelId: 1,
        noLink: true,
      });
      return { confirmed: response === 0 };
    },

    async 'print.toPdf'(payload) {
      const o = record(payload);
      const bytes = await deps.print.toPdf(html(o), {
        page: pageSpec(o),
        margins: optEnum(o, 'margins', PDF_MARGINS) ?? 'default',
      });
      return { bytes: standaloneBytes(bytes) };
    },

    async 'print.savePdf'(payload, ctx) {
      const o = record(payload);
      const source = html(o);
      const page = pageSpec(o);
      let name = sanitizeFileName(text(o, 'defaultName', 255), 'document');
      if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
      const target = await askSavePath(ctx, 'Save as PDF', name, [{ name: 'PDF document', extensions: ['pdf'] }]);
      if (!target) return null;
      const bytes = await deps.print.toPdf(source, { page, margins: 'default' });
      await saveTo(target, bytes);
      return { path: target };
    },

    async 'print.print'(payload, ctx) {
      const o = record(payload);
      const copiesRaw = o.copies;
      if (copiesRaw !== undefined && (typeof copiesRaw !== 'number' || !Number.isInteger(copiesRaw) || copiesRaw < 1 || copiesRaw > 99)) {
        throw invalid('Copies must be between 1 and 99.');
      }
      const source = html(o);
      const page = pageSpec(o);
      const deviceName = optText(o, 'deviceName', 256);
      if (deviceName !== undefined) {
        // Only a printer the OS lists right now (the renderer got the name from 'print.printers').
        if (!validPrinterName(deviceName)) throw invalid('Invalid printer.');
        const known = await deps.print.printers(ctx.window);
        if (!known.some((p) => p.name === deviceName)) {
          throw new AppError('NOT_FOUND', `The printer “${deviceName}” is not installed on this computer any more. Choose another printer.`);
        }
      }
      const printed = await deps.print.print(
        source,
        {
          silent: optBool(o, 'silent') ?? false,
          copies: (copiesRaw as number | undefined) ?? 1,
          page,
          margins: optEnum(o, 'margins', ['default', 'none'] as const) ?? 'default',
          ...(deviceName ? { deviceName } : {}),
        },
        ctx.window,
      );
      return { printed };
    },

    async 'print.printers'(_payload, ctx) {
      return deps.print.printers(ctx.window);
    },

    async 'share.email'(payload, ctx) {
      const o = record(payload);
      const source = html(o);
      const page = pageSpec(o);
      const to = parseRecipients(optText(o, 'to', 2000));
      if (!to) throw invalid('Check the e-mail address: enter one address (or several separated by commas), e.g. accounts@example.com.');
      const subject = shareText(o, 'subject', 300, true);
      const body = shareText(o, 'body', 20_000, false);
      const wanted = text(o, 'fileName', 255);
      const shared = await sharedFolder();
      const bytes = await deps.print.toPdf(source, { page, margins: 'default' });
      const pdfName = await freeFileName(shared, wanted, '.pdf');
      const pdfPath = path.join(shared, pdfName);
      const emlPath = path.join(shared, await freeFileName(shared, pdfName.slice(0, -4), '.eml'));
      if (!isPathInside(shared, pdfPath) || !isPathInside(shared, emlPath)) throw invalid('Invalid file name.');
      await saveTo(pdfPath, bytes);
      await saveTo(emlPath, buildDraftEml({ to, subject, body, attachment: { fileName: pdfName, contentType: 'application/pdf', bytes }, date: new Date() }));
      let opened: 'draft' | 'mailto' | 'none' = 'none';
      // The .eml was written by main into the company's exports folder (checked above): safe to hand to the OS.
      const failure = await shell.openPath(emlPath);
      if (failure === '') opened = 'draft';
      else {
        log('warn', 'No program opened the e-mail draft; falling back to mailto:', { reason: failure });
        const url = parseExternalUrl(mailtoUrl(to, subject, body));
        if (url && (await openExternalUrl(url, ctx.window, { confirm: false }))) opened = 'mailto';
        shell.showItemInFolder(pdfPath);
      }
      return { pdfPath, emlPath, opened };
    },

    async 'share.whatsapp'(payload, ctx) {
      const o = record(payload);
      const source = html(o);
      const page = pageSpec(o);
      const rawMobile = (optText(o, 'mobile', 32) ?? '').trim();
      const mobile = rawMobile ? indianMobileForWhatsapp(rawMobile) : null;
      if (rawMobile && !mobile) {
        throw invalid('Enter a 10-digit Indian mobile number (starting with 6, 7, 8 or 9) for WhatsApp, or leave it blank to choose the contact in WhatsApp.');
      }
      const message = shareText(o, 'text', 2000, false);
      const url = parseExternalUrl(whatsappUrl(mobile, message));
      if (!url || url.href.length > MAX_SHARE_URL) throw invalid('The WhatsApp message is too long. Shorten it (a few lines are enough — the PDF carries the details).');
      const wanted = text(o, 'fileName', 255);
      const shared = await sharedFolder();
      const bytes = await deps.print.toPdf(source, { page, margins: 'default' });
      const pdfPath = path.join(shared, await freeFileName(shared, wanted, '.pdf'));
      if (!isPathInside(shared, pdfPath)) throw invalid('Invalid file name.');
      await saveTo(pdfPath, bytes);
      // https links are confirmed by the user (external.ts) — the host shown is wa.me.
      const opened = await openExternalUrl(url, ctx.window, { confirm: true });
      shell.showItemInFolder(pdfPath);
      return { pdfPath, opened };
    },

    async 'attachment.openCopy'(payload) {
      // (dataplus) Bytes from 'attachments.read', re-checked here; the copy goes to a fresh temp folder.
      const { fileName, bytes } = checkOpenCopy(payload);
      let file: string;
      try {
        file = writeOpenCopy(app.getPath('temp'), fileName, bytes);
      } catch (err) {
        throw fileError(err, 'save');
      }
      const problem = await shell.openPath(file);
      if (problem) {
        log('warn', 'An attached file could not be opened', { reason: problem });
        throw new AppError('BUSINESS_RULE', `Windows has no program to open “${fileName}”. Use “Save a copy” and open it from there.`);
      }
      return { opened: true };
    },

    async 'shell.openExternal'(payload, ctx) {
      const o = record(payload);
      const url = parseExternalUrl(o.url);
      if (!url) throw invalid('Only https:// web links and mailto: e-mail links can be opened.');
      await openExternalUrl(url, ctx.window, { confirm: true });
    },

    async 'shell.showItem'(payload) {
      const o = record(payload);
      const raw = text(o, 'path', 1024);
      if (raw.includes('\0') || !path.isAbsolute(raw)) throw invalid('Invalid path.');
      const target = path.resolve(raw);
      const dataDir = deps.runtime.app.dataDir;
      // An empty data folder (core not started) must not resolve to the working directory.
      if (!(dataDir !== '' && isPathInside(dataDir, target)) && !chosen.covers(target)) {
        log('warn', 'Refused to reveal a path outside the data folder');
        throw new AppError('FORBIDDEN', 'Only files in the Pevqori data folder, or files you chose in this session, can be shown.');
      }
      try {
        await fsp.access(target);
      } catch {
        throw new AppError('NOT_FOUND', 'The file or folder no longer exists.');
      }
      shell.showItemInFolder(target);
    },

    async 'theme.set'(payload) {
      const o = record(payload);
      const mode = optEnum(o, 'mode', THEMES);
      if (!mode || !isThemeMode(mode)) throw invalid('Invalid theme.');
      nativeTheme.themeSource = mode;
      try {
        deps.runtime.setTheme(mode); // persisted in the core app config (config.json)
      } catch (err) {
        log('warn', 'Could not persist the theme preference', describeError(err));
      }
      deps.windows.syncBackground();
      deps.windows.broadcast('theme-changed', { dark: nativeTheme.shouldUseDarkColors });
    },

    async 'window.toggleFullscreen'(_payload, ctx) {
      const win = ctx.window;
      if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
    },

    async 'window.zoom'(payload, ctx) {
      const o = record(payload);
      const factor = o.factor;
      if (typeof factor !== 'number' || !Number.isFinite(factor)) throw invalid('Invalid zoom factor.');
      deps.windows.setZoom(ctx.sender, factor);
    },

    async 'app.relaunch'() {
      // Defer so the IPC reply reaches the renderer before windows start closing.
      setImmediate(() => deps.requestQuit({ relaunch: true }));
    },

    async 'app.quit'() {
      setImmediate(() => deps.requestQuit({ relaunch: false }));
    },
  };

  return async (ctx, action, payload) => {
    if (typeof action !== 'string' || !Object.hasOwn(handlers, action)) {
      return { ok: false, error: { code: 'UNKNOWN_ROUTE', message: 'Unknown native action.' } };
    }
    const name = action as NativeAction;
    try {
      const data: unknown = await handlers[name](payload, ctx);
      return { ok: true, data };
    } catch (err) {
      if (!(err instanceof AppError)) log('error', `Native action failed: ${name}`, describeError(err));
      return { ok: false, error: toErrorPayload(err) };
    }
  };
}
