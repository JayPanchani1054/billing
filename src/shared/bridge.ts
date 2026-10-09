/**
 * The preload bridge exposed to the renderer as `window.bahi`. This is the ONLY way the renderer
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
    in: { html: string; pageSize?: 'A4' | 'A5' | 'Letter' | 'Legal'; landscape?: boolean; margins?: 'default' | 'none' | 'minimum' };
    out: { bytes: Uint8Array };
  };
  /** Render HTML to PDF and save via a dialog. */
  'print.savePdf': {
    in: { html: string; defaultName: string; pageSize?: 'A4' | 'A5' | 'Letter' | 'Legal'; landscape?: boolean };
    out: { path: string } | null;
  };
  /** Send HTML to a printer (shows the OS print dialog unless silent). */
  'print.print': { in: { html: string; silent?: boolean; landscape?: boolean; copies?: number }; out: { printed: boolean } };
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
}

export type NativeAction = keyof NativeActions;

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
}

export interface BahiBridge {
  api(route: string, input: unknown): Promise<ApiResult<unknown>>;
  native<A extends NativeAction>(action: A, payload: NativeActions[A]['in']): Promise<ApiResult<NativeActions[A]['out']>>;
  on<E extends keyof BridgeEvents>(event: E, listener: (payload: BridgeEvents[E]) => void): () => void;
  /** Tell main whether the renderer has unsaved work (controls the close confirmation). */
  setDirty(dirty: boolean): void;
  readonly platform: string;
}
