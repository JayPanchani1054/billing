/**
 * The preload bridge exposed to the renderer as `window.pevqori`. This is the ONLY way the renderer
 * talks to the main process. Implemented in src/preload/index.ts and src/main/native.ts.
 */
import type { ApiResult } from './api.ts';

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Native (Electron-only) actions with their payload and result types. */
export interface NativeActions {
  'app.info': {
    in: void;
    out: { version: string; platform: string; arch: string; electron: string; chrome: string; node: string; isPackaged: boolean; userDataDir: string; logDir: string };
  };
  /** Folder picker. */
  'dialog.chooseFolder': { in: { title: string; defaultPath?: string }; out: { path: string } | null };
  /** Open a file chosen by the user and return its bytes (max 100 MB). `withPath` also returns the path. */
  'dialog.openFile': {
    in: { title: string; filters?: FileFilter[]; withPath?: boolean };
    out: { name: string; size: number; bytes: Uint8Array; path?: string } | null;
  };
  /** Save data to a user-chosen file. Strings are written as UTF-8. */
  'dialog.saveFile': {
    in: { title: string; defaultName: string; filters?: FileFilter[]; data: Uint8Array | string };
    out: { path: string } | null;
  };
  /** Message box for destructive confirmations that must be native (e.g. quit with unsaved work). */
  'dialog.confirm': { in: { title: string; message: string; detail?: string; okLabel?: string; danger?: boolean }; out: { confirmed: boolean } };
  /** Render self-contained HTML (inline CSS, data: images) to PDF bytes. */
  'print.toPdf': {
    in: { html: string; pageSize?: NativePageSize; landscape?: boolean; margins?: 'default' | 'none' | 'minimum'; rollHeightMm?: number; customPageMm?: CustomPageMm };
    out: { bytes: Uint8Array };
  };
  /** Render HTML to PDF and save via a dialog. */
  'print.savePdf': {
    in: { html: string; defaultName: string; pageSize?: NativePageSize; landscape?: boolean; rollHeightMm?: number; customPageMm?: CustomPageMm };
    out: { path: string } | null;
  };
  /**
   * Send HTML to a printer (shows the OS print dialog unless silent). `deviceName` (from 'print.printers')
   * prints to that printer; rolls ('80mm' / '58mm') print edge to edge at `rollHeightMm` (print group).
   */
  'print.print': {
    in: {
      html: string;
      silent?: boolean;
      landscape?: boolean;
      copies?: number;
      pageSize?: NativePageSize;
      rollHeightMm?: number;
      /** pageSize 'custom' (a cheque leaf): width × height in mm, 50–400 each. */
      customPageMm?: CustomPageMm;
      /** Sheets: 'none' prints edge to edge (documents positioned to the millimetre). */
      margins?: 'default' | 'none';
      deviceName?: string;
    };
    out: { printed: boolean };
  };
  /** (print group) Printers installed on this computer, for direct printing to a receipt printer. */
  'print.printers': { in: void; out: Array<{ name: string; displayName: string; description: string }> };
  /**
   * (print group) Share a document by e-mail: main renders the PDF into the open company's exports folder
   * (<company>/exports/shared — the path is chosen by main, never the renderer), writes a draft .eml
   * (MIME, PDF attached, X-Unsent: 1) next to it and opens it with the default mail program; when no
   * program opens .eml files it falls back to a mailto: link and shows the PDF in its folder.
   */
  'share.email': { in: ShareDocumentIn & { to?: string; subject: string; body: string }; out: ShareEmailResult };
  /**
   * (print group) Share on WhatsApp: main saves the PDF into the exports folder, opens
   * https://wa.me/<91 + mobile>?text=… (number and text validated by main) and shows the PDF in its
   * folder so it can be attached in WhatsApp.
   */
  'share.whatsapp': { in: ShareDocumentIn & { mobile?: string; text: string }; out: ShareWhatsappResult };
  /**
   * (dataplus) Open a copy of an attached file with the program Windows uses for its kind. The
   * renderer passes the bytes it read through 'attachments.read', never a path: main re-checks the
   * kind against the attachment allowlist (src/shared/attachments.ts), writes the copy into a fresh
   * folder under the system temp folder and opens it (edits there never touch the stored original).
   */
  'attachment.openCopy': { in: { fileName: string; bytes: Uint8Array }; out: { opened: boolean } };
  /** Open an https:// URL or mailto: in the OS (main validates the scheme). */
  'shell.openExternal': { in: { url: string }; out: void };
  /** Reveal a file/folder in Explorer. Only paths inside the data dir or previously chosen by a dialog. */
  'shell.showItem': { in: { path: string }; out: void };
  /** 'system' follows Windows; persists in app config. */
  'theme.set': { in: { mode: 'system' | 'light' | 'dark' }; out: void };
  'window.toggleFullscreen': { in: void; out: void };
  'window.zoom': { in: { factor: number }; out: void };
  'app.relaunch': { in: void; out: void };
  'app.quit': { in: void; out: void };
  /**
   * (2.0 updates, src/main/updates/) In-app updates from the project's GitHub Releases. The renderer can
   * never pass a URL, path or version: main decides everything from its own configuration and policy.
   * No action contacts the network except 'updates.check' and 'updates.download'.
   */
  'updates.status': { in: void; out: UpdateStatus };
  'updates.check': { in: void; out: UpdateStatus };
  'updates.download': { in: void; out: UpdateStatus };
  /** 'now' quits through the normal close sequence (unsaved-work prompt can cancel) and installs; 'on-quit' installs at the next quit. */
  'updates.install': { in: { when: 'now' | 'on-quit' }; out: UpdateStatus };
  /** Refused (FORBIDDEN) when the policy is locked (administrator, environment, test run, unpackaged app). */
  'updates.setMode': { in: { mode: 'manual' | 'weekly' }; out: UpdateStatus };
}

/** How the app looks for updates: never, only when the user asks, or once a week. */
export type UpdateMode = 'off' | 'manual' | 'weekly';

/** The effective update policy (src/main/updates/policy.ts resolveUpdatePolicy). */
export interface UpdatePolicy {
  mode: UpdateMode;
  /** True when the user cannot change the mode (administrator policy, environment, test run, unpackaged app). */
  locked: boolean;
  source: 'policy' | 'env' | 'user' | 'build';
  /** Plain-language reason shown when locked or off; null for the user's own choice. */
  reason: string | null;
}

/** The update state machine as the renderer sees it ('update-status' event and every updates.* action). */
export type UpdateStatus =
  | { state: 'unavailable'; reason: string; policy: UpdatePolicy; current: string }
  | { state: 'idle'; current: string; lastCheck: string | null; policy: UpdatePolicy }
  | { state: 'checking'; current: string; policy: UpdatePolicy }
  | { state: 'up-to-date'; current: string; checkedAt: string; policy: UpdatePolicy }
  | { state: 'available'; current: string; version: string; releaseDate: string; notes: string; sizeBytes: number; policy: UpdatePolicy }
  | { state: 'downloading'; current: string; version: string; percent: number; bytesPerSecond: number; policy: UpdatePolicy }
  | { state: 'ready'; current: string; version: string; notes: string; installOnQuit: boolean; policy: UpdatePolicy }
  | { state: 'error'; current: string; message: string; retryable: boolean; policy: UpdatePolicy };

export type NativeAction = keyof NativeActions;

/**
 * Paper sizes main understands (A5 landscape = 'A5' + landscape; rolls are continuous receipt paper;
 * 'custom' = `customPageMm`, e.g. a 202 × 92 mm cheque leaf).
 */
export type NativePageSize = 'A4' | 'A5' | 'Letter' | 'Legal' | '80mm' | '58mm' | 'custom';

export interface CustomPageMm {
  width: number;
  height: number;
}

/** The document part of a share request (print group). */
export interface ShareDocumentIn {
  /** Self-contained printable HTML (same rules as print.toPdf). */
  html: string;
  /** Suggested PDF file name (sanitised by main; '.pdf' added). */
  fileName: string;
  pageSize?: NativePageSize;
  landscape?: boolean;
  rollHeightMm?: number;
}

export interface ShareEmailResult {
  pdfPath: string;
  emlPath: string;
  /** 'draft': the .eml opened in the mail program; 'mailto': fallback (attach the PDF by hand). */
  opened: 'draft' | 'mailto' | 'none';
}

export interface ShareWhatsappResult {
  pdfPath: string;
  /** WhatsApp (web or app) was opened. */
  opened: boolean;
}

/**
 * `command` id sent when the accounting engine (the core worker thread) stopped unexpectedly and was
 * restarted: no company is open any more, so the window refreshes its app state and says what happened.
 */
export const CORE_RESTARTED_COMMAND = 'core.restarted';

/** Events pushed from main to renderer. */
export interface BridgeEvents {
  /** Application menu / accelerator command, e.g. 'goto', 'company.close', 'print', 'export'. */
  command: { id: string };
  /** Main is about to close the window; renderer may veto when there is unsaved work. */
  'before-close': void;
  'theme-changed': { dark: boolean };
  /** (2.0 updates) The update state changed (check, download progress, ready, error, mode). */
  'update-status': UpdateStatus;
}

export interface PevqoriBridge {
  api(route: string, input: unknown): Promise<ApiResult<unknown>>;
  native<A extends NativeAction>(action: A, payload: NativeActions[A]['in']): Promise<ApiResult<NativeActions[A]['out']>>;
  on<E extends keyof BridgeEvents>(event: E, listener: (payload: BridgeEvents[E]) => void): () => void;
  /** Tell main whether the renderer has unsaved work (controls the close confirmation). */
  setDirty(dirty: boolean): void;
  readonly platform: string;
}
