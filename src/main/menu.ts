/**
 * Minimal native application menu. The window hides it (autoHideMenuBar) — Pevqori is keyboard-first
 * and the renderer owns almost all shortcuts (F-keys, Alt+…, Ctrl+A/S/G/K). Therefore:
 *  - top-level labels have no '&' mnemonics, so Alt+letter chords always reach the renderer;
 *  - Edit items show their usual shortcuts but do not register them (Chromium handles editing keys
 *    natively on Windows, and Ctrl+A means "accept" in Pevqori forms);
 *  - full screen has no accelerator because F11 is the Features hotkey.
 */
import { app, BrowserWindow, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { APP_NAME } from '../shared/constants.ts';

export interface MenuActions {
  isPackaged: boolean;
  /** Send a BridgeEvents 'command' to the focused app window. */
  command(id: string): void;
  zoom(direction: 'in' | 'out' | 'reset'): void;
  toggleFullScreen(): void;
  showAbout(): void;
  openLogsFolder(): void;
  /** Help › Check for Updates… (the only menu item that may reach the network; the policy can turn it off). */
  checkForUpdates(): void;
}

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

export function buildApplicationMenu(actions: MenuActions): Menu {
  const view: MenuItemConstructorOptions[] = [
    { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => actions.zoom('in') },
    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => actions.zoom('out') },
    { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => actions.zoom('reset') },
    { type: 'separator' },
    { label: 'Full Screen', click: () => actions.toggleFullScreen() },
  ];
  if (!actions.isPackaged) {
    view.push(
      { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => focusedWindow()?.webContents.reload() },
      { label: 'Toggle Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => focusedWindow()?.webContents.toggleDevTools() },
    );
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Go To…', accelerator: 'CmdOrCtrl+G', registerAccelerator: false, click: () => actions.command('goto') },
        { label: 'Close Company', click: () => actions.command('company.close') },
        { type: 'separator' },
        { label: `Quit ${APP_NAME}`, click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', registerAccelerator: false },
        { role: 'redo', registerAccelerator: false },
        { type: 'separator' },
        { role: 'cut', registerAccelerator: false },
        { role: 'copy', registerAccelerator: false },
        { role: 'paste', registerAccelerator: false },
      ],
    },
    { label: 'View', submenu: view },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: () => actions.command('help.shortcuts') },
        { type: 'separator' },
        { label: 'Open Logs Folder', click: () => actions.openLogsFolder() },
        { label: 'Check for Updates…', click: () => actions.checkForUpdates() },
        { type: 'separator' },
        { label: `About ${APP_NAME}`, click: () => actions.showAbout() },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
