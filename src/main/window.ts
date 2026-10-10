/**
 * Main window lifecycle: hardened creation, persisted bounds, theme-matched background, unsaved-work
 * close confirmation, zoom, crash/hang recovery and main → renderer events.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme, screen } from 'electron';
import type { MenuItemConstructorOptions, Rectangle, WebContents } from 'electron';
import { IPC } from '../shared/api.ts';
import type { BridgeEvents } from '../shared/bridge.ts';
import { APP_NAME } from '../shared/constants.ts';
import { bundlePaths, WINDOW_BACKGROUND, WINDOW_DEFAULTS, ZOOM_STEP } from './config.ts';
import { readJsonFile, writeFileAtomicSync } from './files.ts';
import { describeError, log } from './log.ts';
import { clampZoom } from './prefs.ts';
import type { PrefsStore } from './prefs.ts';

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface WindowManagerOptions {
  userDataDir: string;
  startUrl: string;
  prefs: PrefsStore;
  isPackaged: boolean;
  /** Automated tests: never block on modal dialogs. */
  isE2E: boolean;
}

export interface WindowManager {
  createMainWindow(): BrowserWindow;
  getMainWindow(): BrowserWindow | null;
  focusMainWindow(): void;
  /** True for the WebContents of a window created by this manager (the only legitimate IPC callers). */
  isAppWebContents(contents: WebContents): boolean;
  setDirty(contents: WebContents, dirty: boolean): void;
  /** Subsequent window closes skip the unsaved-work prompt (renderer-initiated quit/relaunch). */
  allowCloseWithoutPrompt(): void;
  send<E extends keyof BridgeEvents>(contents: WebContents, event: E, payload: BridgeEvents[E]): void;
  broadcast<E extends keyof BridgeEvents>(event: E, payload: BridgeEvents[E]): void;
  /** Clamp to 0.7–1.5, apply and persist. Returns the factor applied. */
  setZoom(contents: WebContents, factor: number): number;
  stepZoom(contents: WebContents, direction: 'in' | 'out' | 'reset'): void;
  /** Re-apply the theme-matched background colour after nativeTheme changes. */
  syncBackground(): void;
}

export function themeBackground(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

function finiteInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
}

function intersects(a: Rectangle, b: Rectangle, minX: number, minY: number): boolean {
  const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return ix >= minX && iy >= minY;
}

function loadWindowState(file: string): WindowState {
  const state: WindowState = { width: WINDOW_DEFAULTS.width, height: WINDOW_DEFAULTS.height, maximized: false };
  const raw = readJsonFile(file);
  if (raw === null || typeof raw !== 'object') return state;
  const r = raw as Record<string, unknown>;
  const displays = screen.getAllDisplays();
  const maxW = Math.max(...displays.map((d) => d.workArea.width), WINDOW_DEFAULTS.minWidth);
  const maxH = Math.max(...displays.map((d) => d.workArea.height), WINDOW_DEFAULTS.minHeight);
  state.width = Math.min(maxW, Math.max(WINDOW_DEFAULTS.minWidth, finiteInt(r.width) ?? WINDOW_DEFAULTS.width));
  state.height = Math.min(maxH, Math.max(WINDOW_DEFAULTS.minHeight, finiteInt(r.height) ?? WINDOW_DEFAULTS.height));
  state.maximized = r.maximized === true;
  const x = finiteInt(r.x);
  const y = finiteInt(r.y);
  if (x !== undefined && y !== undefined) {
    const bounds = { x, y, width: state.width, height: state.height };
    // Only restore the position if the title bar area is still on a connected display.
    if (displays.some((d) => intersects(d.workArea, bounds, 120, 40))) {
      state.x = x;
      state.y = y;
    }
  }
  return state;
}

function saveWindowState(file: string, win: BrowserWindow): void {
  try {
    const b = win.getNormalBounds();
    const state: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
    writeFileAtomicSync(file, JSON.stringify(state));
  } catch (err) {
    log('warn', 'Could not save window state', describeError(err));
  }
}

export function createWindowManager(options: WindowManagerOptions): WindowManager {
  const stateFile = path.join(options.userDataDir, 'window-state.json');
  const dirty = new Map<number, boolean>();
  const appContents = new Set<number>();
  let mainWindow: BrowserWindow | null = null;
  let closeWithoutPrompt = false;

  function send<E extends keyof BridgeEvents>(contents: WebContents, event: E, payload: BridgeEvents[E]): void {
    if (!contents.isDestroyed()) contents.send(IPC.event, event, payload);
  }

  function setZoom(contents: WebContents, factor: number): number {
    const next = clampZoom(factor);
    if (!contents.isDestroyed()) contents.setZoomFactor(next);
    options.prefs.update({ zoom: next });
    return next;
  }

  function stepZoom(contents: WebContents, direction: 'in' | 'out' | 'reset'): void {
    if (contents.isDestroyed()) return;
    const current = contents.getZoomFactor();
    setZoom(contents, direction === 'reset' ? 1 : direction === 'in' ? current + ZOOM_STEP : current - ZOOM_STEP);
  }

  function attachContextMenu(win: BrowserWindow): void {
    // Minimal native edit menu for text fields (renderer can still provide its own by preventDefault()).
    win.webContents.on('context-menu', (_event, params) => {
      const f = params.editFlags;
      const items: MenuItemConstructorOptions[] = [];
      if (params.isEditable) {
        items.push(
          { role: 'undo', enabled: f.canUndo },
          { role: 'redo', enabled: f.canRedo },
          { type: 'separator' },
          { role: 'cut', enabled: f.canCut },
          { role: 'copy', enabled: f.canCopy },
          { role: 'paste', enabled: f.canPaste },
          { type: 'separator' },
          { role: 'selectAll', enabled: f.canSelectAll },
        );
      } else if (params.selectionText.trim().length > 0) {
        items.push({ role: 'copy', enabled: f.canCopy });
      }
      if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win });
    });
  }

  function attachRecovery(win: BrowserWindow, contentsId: number): void {
    win.webContents.on('render-process-gone', (_event, details) => {
      dirty.set(contentsId, false);
      if (details.reason === 'clean-exit') return;
      log('error', 'Renderer process gone', { reason: details.reason, exitCode: details.exitCode });
      if (options.isE2E || win.isDestroyed()) return;
      void dialog
        .showMessageBox(win, {
          type: 'error',
          title: APP_NAME,
          message: 'The Pevqori window stopped unexpectedly.',
          detail: 'Saved data is safe. Changes on the screen that was open may not have been saved. Reload the window to continue.',
          buttons: ['Reload', 'Quit'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
        .then(({ response }) => {
          if (win.isDestroyed()) return;
          if (response === 0) void win.loadURL(options.startUrl).catch((err: unknown) => log('error', 'Reload failed', describeError(err)));
          else app.quit();
        });
    });

    let hangPromptOpen = false;
    win.on('unresponsive', () => {
      log('warn', 'Window became unresponsive');
      if (options.isE2E || hangPromptOpen || win.isDestroyed()) return;
      hangPromptOpen = true;
      void dialog
        .showMessageBox(win, {
          type: 'warning',
          title: APP_NAME,
          message: 'Pevqori is not responding.',
          detail: 'You can keep waiting for it to finish, or reload the window (unsaved changes on the open screen will be lost).',
          buttons: ['Keep waiting', 'Reload window'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        .then(({ response }) => {
          hangPromptOpen = false;
          if (response === 1 && !win.isDestroyed()) win.webContents.reload();
        });
    });
  }

  function attachCloseGuard(win: BrowserWindow, contentsId: number): void {
    let promptOpen = false;
    win.on('close', (event) => {
      saveWindowState(stateFile, win);
      // Automated tests never block on a modal prompt: a dirty window simply closes.
      if (closeWithoutPrompt || options.isE2E || dirty.get(contentsId) !== true) return;
      event.preventDefault();
      send(win.webContents, 'before-close', undefined);
      if (promptOpen) return;
      promptOpen = true;
      void dialog
        .showMessageBox(win, {
          type: 'warning',
          title: APP_NAME,
          message: 'You have unsaved changes.',
          detail: 'If you close Pevqori now, the changes on the open screen will be lost.',
          buttons: ['Discard changes and close', 'Keep working'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        .then(
          ({ response }) => {
            promptOpen = false;
            if (response !== 0 || win.isDestroyed()) return;
            dirty.set(contentsId, false);
            win.close();
          },
          (err: unknown) => {
            promptOpen = false;
            log('error', 'Close confirmation failed', describeError(err));
          },
        );
    });
  }

  function createMainWindow(): BrowserWindow {
    const state = loadWindowState(stateFile);
    const paths = bundlePaths();
    const icon = !options.isPackaged && fs.existsSync(paths.devIcon) ? paths.devIcon : undefined;
    const win = new BrowserWindow({
      title: APP_NAME,
      width: state.width,
      height: state.height,
      x: state.x,
      y: state.y,
      minWidth: WINDOW_DEFAULTS.minWidth,
      minHeight: WINDOW_DEFAULTS.minHeight,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: themeBackground(),
      icon,
      webPreferences: {
        preload: paths.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
        navigateOnDragDrop: false,
        devTools: !options.isPackaged,
      },
    });
    const contents = win.webContents;
    const contentsId = contents.id;
    appContents.add(contentsId);
    dirty.set(contentsId, false);
    mainWindow = win;

    // Keep the product name in the title bar/taskbar whatever the renderer sets.
    win.on('page-title-updated', (event, title, explicitSet) => {
      const clean = title.trim();
      if (explicitSet && clean.includes(APP_NAME)) return;
      event.preventDefault();
      win.setTitle(explicitSet && clean ? `${clean} — ${APP_NAME}` : APP_NAME);
    });

    let shown = false;
    const showOnce = (): void => {
      if (shown || win.isDestroyed()) return;
      shown = true;
      if (state.maximized) win.maximize();
      win.show();
      win.focus();
    };
    win.once('ready-to-show', showOnce);
    // Never leave the user with an invisible app if the first paint never comes.
    const showFallback = setTimeout(showOnce, 10_000);

    contents.on('did-finish-load', () => {
      contents.setZoomFactor(options.prefs.get().zoom);
      void contents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
    });
    // A reload or navigation replaces the document: its unsaved-work flag goes with it (a stale `true`
    // would otherwise make the close button prompt about work that no longer exists).
    contents.on('did-navigate', () => dirty.set(contentsId, false));
    contents.on('zoom-changed', (_event, direction) => stepZoom(contents, direction));
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      log('error', 'Window failed to load', { errorCode, errorDescription, url: validatedURL });
    });

    attachContextMenu(win);
    attachRecovery(win, contentsId);
    attachCloseGuard(win, contentsId);

    win.on('closed', () => {
      clearTimeout(showFallback);
      dirty.delete(contentsId);
      appContents.delete(contentsId);
      if (mainWindow === win) mainWindow = null;
    });

    win.loadURL(options.startUrl).catch((err: unknown) => {
      log('error', 'Could not load the app UI', { url: options.startUrl, ...describeError(err) });
    });
    return win;
  }

  return {
    createMainWindow,
    getMainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    focusMainWindow() {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    },
    isAppWebContents: (contents) => appContents.has(contents.id),
    setDirty(contents, value) {
      if (appContents.has(contents.id)) dirty.set(contents.id, value);
    },
    allowCloseWithoutPrompt() {
      closeWithoutPrompt = true;
    },
    send,
    broadcast(event, payload) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && appContents.has(win.webContents.id)) send(win.webContents, event, payload);
      }
    },
    setZoom,
    stepZoom,
    syncBackground() {
      const colour = themeBackground();
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && appContents.has(win.webContents.id)) win.setBackgroundColor(colour);
      }
    },
  };
}
