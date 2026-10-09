/**
 * OFFLINE TYPE SHIM — a faithful subset of Electron's type definitions, used ONLY by
 * tsconfig.node.offline.json where npm is unavailable. Real builds use electron's bundled types.
 * If code needs an API missing here, add it with the exact signature from electron.d.ts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'node:events';

export interface Event {
  preventDefault(): void;
  readonly defaultPrevented: boolean;
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ───────────── app ─────────────
type AppPathName =
  | 'home' | 'appData' | 'userData' | 'sessionData' | 'temp' | 'exe' | 'module' | 'desktop' | 'documents'
  | 'downloads' | 'music' | 'pictures' | 'videos' | 'recent' | 'logs' | 'crashDumps';

export interface App extends EventEmitter {
  on(event: 'ready', listener: () => void): this;
  on(event: 'window-all-closed', listener: () => void): this;
  on(event: 'before-quit', listener: (event: Event) => void): this;
  on(event: 'will-quit', listener: (event: Event) => void): this;
  on(event: 'activate', listener: (event: Event, hasVisibleWindows: boolean) => void): this;
  on(event: 'second-instance', listener: (event: Event, argv: string[], workingDirectory: string) => void): this;
  on(event: 'web-contents-created', listener: (event: Event, webContents: WebContents) => void): this;
  on(event: 'render-process-gone', listener: (event: Event, webContents: WebContents, details: { reason: string; exitCode: number }) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  whenReady(): Promise<void>;
  isReady(): boolean;
  quit(): void;
  exit(exitCode?: number): void;
  relaunch(options?: { args?: string[]; execPath?: string }): void;
  getPath(name: AppPathName): string;
  setPath(name: AppPathName, path: string): void;
  getVersion(): string;
  getName(): string;
  setName(name: string): void;
  getLocale(): string;
  getAppPath(): string;
  readonly isPackaged: boolean;
  requestSingleInstanceLock(additionalData?: Record<any, any>): boolean;
  setAppUserModelId(id: string): void;
  setAppLogsPath(path?: string): void;
  enableSandbox(): void;
  focus(options?: { steal: boolean }): void;
  disableHardwareAcceleration(): void;
  setAboutPanelOptions(options: Record<string, unknown>): void;
  commandLine: { appendSwitch(the_switch: string, value?: string): void; hasSwitch(the_switch: string): boolean };
}
export const app: App;

// ───────────── BrowserWindow ─────────────
export interface WebPreferences {
  preload?: string;
  sandbox?: boolean;
  contextIsolation?: boolean;
  nodeIntegration?: boolean;
  nodeIntegrationInWorker?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  webviewTag?: boolean;
  spellcheck?: boolean;
  devTools?: boolean;
  javascript?: boolean;
  backgroundThrottling?: boolean;
  safeDialogs?: boolean;
  navigateOnDragDrop?: boolean;
  enableWebSQL?: boolean;
  additionalArguments?: string[];
  partition?: string;
  zoomFactor?: number;
  offscreen?: boolean;
}

export interface BrowserWindowConstructorOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  useContentSize?: boolean;
  center?: boolean;
  resizable?: boolean;
  movable?: boolean;
  minimizable?: boolean;
  maximizable?: boolean;
  closable?: boolean;
  focusable?: boolean;
  alwaysOnTop?: boolean;
  fullscreen?: boolean;
  fullscreenable?: boolean;
  skipTaskbar?: boolean;
  title?: string;
  icon?: string;
  show?: boolean;
  frame?: boolean;
  parent?: BrowserWindow;
  modal?: boolean;
  autoHideMenuBar?: boolean;
  backgroundColor?: string;
  hasShadow?: boolean;
  darkTheme?: boolean;
  transparent?: boolean;
  titleBarStyle?: 'default' | 'hidden' | 'hiddenInset' | 'customButtonsOnHover';
  titleBarOverlay?: boolean | { color?: string; symbolColor?: string; height?: number };
  backgroundMaterial?: 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed';
  webPreferences?: WebPreferences;
}

export class BrowserWindow extends EventEmitter {
  constructor(options?: BrowserWindowConstructorOptions);
  static getAllWindows(): BrowserWindow[];
  static getFocusedWindow(): BrowserWindow | null;
  static fromWebContents(webContents: WebContents): BrowserWindow | null;
  readonly id: number;
  readonly webContents: WebContents;
  on(event: 'ready-to-show', listener: () => void): this;
  on(event: 'close', listener: (event: Event) => void): this;
  on(event: 'closed', listener: () => void): this;
  on(event: 'focus' | 'blur' | 'maximize' | 'unmaximize' | 'minimize' | 'restore' | 'enter-full-screen' | 'leave-full-screen' | 'resize' | 'move', listener: () => void): this;
  on(event: 'page-title-updated', listener: (event: Event, title: string, explicitSet: boolean) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: 'ready-to-show', listener: () => void): this;
  once(event: 'closed', listener: () => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  loadURL(url: string, options?: Record<string, unknown>): Promise<void>;
  loadFile(filePath: string, options?: { query?: Record<string, string>; search?: string; hash?: string }): Promise<void>;
  show(): void;
  showInactive(): void;
  hide(): void;
  close(): void;
  destroy(): void;
  focus(): void;
  blur(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  maximize(): void;
  unmaximize(): void;
  minimize(): void;
  restore(): void;
  getBounds(): Rectangle;
  setBounds(bounds: Partial<Rectangle>, animate?: boolean): void;
  getNormalBounds(): Rectangle;
  setTitle(title: string): void;
  getTitle(): string;
  setMenu(menu: Menu | null): void;
  removeMenu(): void;
  setMenuBarVisibility(visible: boolean): void;
  setAutoHideMenuBar(hide: boolean): void;
  setProgressBar(progress: number): void;
  flashFrame(flag: boolean): void;
  setBackgroundColor(backgroundColor: string): void;
  setTitleBarOverlay(options: { color?: string; symbolColor?: string; height?: number }): void;
}

// ───────────── WebContents ─────────────
export interface PrintToPDFOptions {
  landscape?: boolean;
  displayHeaderFooter?: boolean;
  printBackground?: boolean;
  scale?: number;
  pageSize?: string | { width: number; height: number };
  margins?: { top?: number; bottom?: number; left?: number; right?: number; marginType?: 'default' | 'none' | 'printableArea' | 'custom' };
  pageRanges?: string;
  headerTemplate?: string;
  footerTemplate?: string;
  preferCSSPageSize?: boolean;
  generateTaggedPDF?: boolean;
  generateDocumentOutline?: boolean;
}

export interface WebContentsPrintOptions {
  silent?: boolean;
  printBackground?: boolean;
  deviceName?: string;
  color?: boolean;
  margins?: { marginType?: 'default' | 'none' | 'printableArea' | 'custom'; top?: number; bottom?: number; left?: number; right?: number };
  landscape?: boolean;
  scaleFactor?: number;
  pagesPerSheet?: number;
  collate?: boolean;
  copies?: number;
  pageSize?: string | { width: number; height: number };
}

export interface HandlerDetails {
  url: string;
  frameName: string;
  features: string;
  disposition: 'default' | 'foreground-tab' | 'background-tab' | 'new-window' | 'other';
}

export type WindowOpenHandlerResponse = { action: 'deny' } | { action: 'allow'; overrideBrowserWindowOptions?: BrowserWindowConstructorOptions };

export interface WebFrameMain {
  readonly url: string;
  readonly origin: string;
  readonly top: WebFrameMain | null;
  readonly parent: WebFrameMain | null;
  readonly processId: number;
  readonly routingId: number;
}

export interface EditFlags {
  canUndo: boolean;
  canRedo: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canDelete: boolean;
  canSelectAll: boolean;
  canEditRichly: boolean;
}

export interface ContextMenuParams {
  x: number;
  y: number;
  linkURL: string;
  selectionText: string;
  isEditable: boolean;
  editFlags: EditFlags;
}

export interface WebContents extends EventEmitter {
  readonly id: number;
  readonly session: Session;
  readonly mainFrame: WebFrameMain;
  on(event: 'will-navigate', listener: (event: Event, url: string) => void): this;
  on(event: 'will-redirect', listener: (event: Event, url: string) => void): this;
  on(event: 'will-attach-webview', listener: (event: Event, webPreferences: WebPreferences, params: Record<string, string>) => void): this;
  on(event: 'did-finish-load', listener: () => void): this;
  on(event: 'did-fail-load', listener: (event: Event, errorCode: number, errorDescription: string, validatedURL: string) => void): this;
  on(event: 'render-process-gone', listener: (event: Event, details: { reason: string; exitCode: number }) => void): this;
  on(event: 'before-input-event', listener: (event: Event, input: { type: string; key: string; code: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }) => void): this;
  on(event: 'console-message', listener: (...args: any[]) => void): this;
  on(event: 'zoom-changed', listener: (event: Event, zoomDirection: ('in' | 'out')) => void): this;
  on(event: 'context-menu', listener: (event: Event, params: ContextMenuParams) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: 'did-finish-load', listener: () => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  send(channel: string, ...args: any[]): void;
  setWindowOpenHandler(handler: (details: HandlerDetails) => WindowOpenHandlerResponse): void;
  loadURL(url: string, options?: Record<string, unknown>): Promise<void>;
  getURL(): string;
  isDestroyed(): boolean;
  isLoading(): boolean;
  printToPDF(options: PrintToPDFOptions): Promise<Buffer>;
  print(options?: WebContentsPrintOptions, callback?: (success: boolean, failureReason: string) => void): void;
  openDevTools(options?: { mode: 'left' | 'right' | 'bottom' | 'undocked' | 'detach'; activate?: boolean }): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  toggleDevTools(): void;
  setZoomFactor(factor: number): void;
  getZoomFactor(): number;
  executeJavaScript(code: string, userGesture?: boolean): Promise<any>;
  reload(): void;
  focus(): void;
  setVisualZoomLevelLimits(minimumLevel: number, maximumLevel: number): Promise<void>;
}

// ───────────── Session ─────────────
export interface OnHeadersReceivedListenerDetails {
  id: number;
  url: string;
  method: string;
  resourceType: string;
  responseHeaders?: Record<string, string[]>;
  statusCode: number;
}
export interface HeadersReceivedResponse {
  cancel?: boolean;
  responseHeaders?: Record<string, string | string[]>;
  statusLine?: string;
}
export interface OnBeforeRequestListenerDetails {
  id: number;
  url: string;
  method: string;
  resourceType: string;
}
export interface WebRequest {
  onHeadersReceived(listener: ((details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void) => void) | null): void;
  onBeforeRequest(listener: ((details: OnBeforeRequestListenerDetails, callback: (response: { cancel?: boolean; redirectURL?: string }) => void) => void) | null): void;
}
export interface Session {
  readonly webRequest: WebRequest;
  readonly protocol: Protocol;
  setPermissionRequestHandler(handler: ((webContents: WebContents, permission: string, callback: (permissionGranted: boolean) => void, details: Record<string, unknown>) => void) | null): void;
  setPermissionCheckHandler(handler: ((webContents: WebContents | null, permission: string, requestingOrigin: string, details: Record<string, unknown>) => boolean) | null): void;
  setDevicePermissionHandler?(handler: ((details: Record<string, unknown>) => boolean) | null): void;
  setSpellCheckerEnabled(enable: boolean): void;
  clearCache(): Promise<void>;
  clearStorageData(options?: Record<string, unknown>): Promise<void>;
}
export const session: { defaultSession: Session; fromPartition(partition: string): Session };

// ───────────── Protocol / net ─────────────
export interface CustomScheme {
  scheme: string;
  privileges?: {
    standard?: boolean;
    secure?: boolean;
    bypassCSP?: boolean;
    allowServiceWorkers?: boolean;
    supportFetchAPI?: boolean;
    corsEnabled?: boolean;
    stream?: boolean;
    codeCache?: boolean;
  };
}
export interface Protocol {
  registerSchemesAsPrivileged(customSchemes: CustomScheme[]): void;
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void;
  unhandle(scheme: string): void;
  isProtocolHandled(scheme: string): boolean;
}
export const protocol: Protocol;
export const net: { fetch(input: string | Request, init?: RequestInit & { bypassCustomProtocolHandlers?: boolean }): Promise<Response>; isOnline(): boolean };

// ───────────── IPC ─────────────
export interface IpcMainInvokeEvent extends Event {
  readonly processId: number;
  readonly frameId: number;
  readonly sender: WebContents;
  readonly senderFrame: WebFrameMain | null;
}
export interface IpcMainEvent extends Event {
  readonly processId: number;
  readonly frameId: number;
  readonly sender: WebContents;
  readonly senderFrame: WebFrameMain | null;
  returnValue: any;
  reply(channel: string, ...args: any[]): void;
}
export interface IpcMain extends EventEmitter {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any): void;
  handleOnce(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): this;
  once(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): this;
  removeAllListeners(channel?: string): this;
}
export const ipcMain: IpcMain;

export interface IpcRendererEvent extends Event {
  sender: IpcRenderer;
}
export interface IpcRenderer extends EventEmitter {
  invoke(channel: string, ...args: any[]): Promise<any>;
  send(channel: string, ...args: any[]): void;
  sendSync(channel: string, ...args: any[]): any;
  on(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): this;
  once(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): this;
  removeListener(channel: string, listener: (...args: any[]) => void): this;
  removeAllListeners(channel?: string): this;
}
export const ipcRenderer: IpcRenderer;

export interface ContextBridge {
  exposeInMainWorld(apiKey: string, api: any): void;
}
export const contextBridge: ContextBridge;

// ───────────── Dialogs ─────────────
export interface FileFilter {
  name: string;
  extensions: string[];
}
export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: FileFilter[];
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory' | 'promptToCreate' | 'noResolveAliases' | 'treatPackageAsDirectory' | 'dontAddToRecent'>;
  message?: string;
}
export interface OpenDialogReturnValue {
  canceled: boolean;
  filePaths: string[];
}
export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: FileFilter[];
  message?: string;
  properties?: Array<'showHiddenFiles' | 'createDirectory' | 'treatPackageAsDirectory' | 'showOverwriteConfirmation' | 'dontAddToRecent'>;
}
export interface SaveDialogReturnValue {
  canceled: boolean;
  filePath: string;
}
export interface MessageBoxOptions {
  message: string;
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  buttons?: string[];
  defaultId?: number;
  title?: string;
  detail?: string;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
  cancelId?: number;
  noLink?: boolean;
}
export interface MessageBoxReturnValue {
  response: number;
  checkboxChecked: boolean;
}
export interface Dialog {
  showOpenDialog(window: BrowserWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
  showSaveDialog(window: BrowserWindow, options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
  showMessageBox(window: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  showMessageBoxSync(window: BrowserWindow, options: MessageBoxOptions): number;
  showMessageBoxSync(options: MessageBoxOptions): number;
  showErrorBox(title: string, content: string): void;
}
export const dialog: Dialog;

// ───────────── Shell ─────────────
export interface Shell {
  openExternal(url: string, options?: { activate?: boolean }): Promise<void>;
  openPath(path: string): Promise<string>;
  showItemInFolder(fullPath: string): void;
  beep(): void;
}
export const shell: Shell;

// ───────────── Menu ─────────────
export interface MenuItemConstructorOptions {
  click?: (menuItem: MenuItem, window: BrowserWindow | undefined, event: KeyboardEvent) => void;
  role?:
    | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'delete' | 'selectAll' | 'reload'
    | 'forceReload' | 'toggleDevTools' | 'resetZoom' | 'zoomIn' | 'zoomOut' | 'togglefullscreen' | 'window'
    | 'minimize' | 'close' | 'help' | 'about' | 'services' | 'hide' | 'hideOthers' | 'unhide' | 'quit'
    | 'editMenu' | 'viewMenu' | 'windowMenu' | 'fileMenu' | 'appMenu';
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio';
  label?: string;
  sublabel?: string;
  toolTip?: string;
  accelerator?: string;
  icon?: string;
  enabled?: boolean;
  acceleratorWorksWhenHidden?: boolean;
  visible?: boolean;
  checked?: boolean;
  registerAccelerator?: boolean;
  submenu?: MenuItemConstructorOptions[] | Menu;
  id?: string;
}
export interface MenuItem {
  id: string;
  label: string;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
  click: (event?: KeyboardEvent, focusedWindow?: BrowserWindow) => void;
}
export interface KeyboardEvent {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  triggeredByAccelerator?: boolean;
}
export class Menu {
  static buildFromTemplate(template: Array<MenuItemConstructorOptions | MenuItem>): Menu;
  static setApplicationMenu(menu: Menu | null): void;
  static getApplicationMenu(): Menu | null;
  popup(options?: { window?: BrowserWindow; x?: number; y?: number }): void;
  getMenuItemById(id: string): MenuItem | null;
  items: MenuItem[];
}

// ───────────── nativeTheme ─────────────
export interface NativeTheme extends EventEmitter {
  on(event: 'updated', listener: () => void): this;
  readonly shouldUseDarkColors: boolean;
  readonly shouldUseHighContrastColors: boolean;
  themeSource: 'system' | 'light' | 'dark';
}
export const nativeTheme: NativeTheme;

// ───────────── safeStorage ─────────────
export interface SafeStorage {
  decryptString(encrypted: Buffer): string;
  encryptString(plainText: string): Buffer;
  getSelectedStorageBackend(): 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown';
  isEncryptionAvailable(): boolean;
}
export const safeStorage: SafeStorage;

// ───────────── Misc ─────────────
export interface Screen {
  getPrimaryDisplay(): { workAreaSize: { width: number; height: number }; scaleFactor: number; bounds: Rectangle; workArea: Rectangle };
  getAllDisplays(): Array<{ workArea: Rectangle; bounds: Rectangle }>;
}
export const screen: Screen;

export interface NativeImage {
  isEmpty(): boolean;
  toPNG(): Buffer;
  toDataURL(): string;
}
export const nativeImage: { createFromPath(path: string): NativeImage; createFromBuffer(buffer: Buffer): NativeImage; createEmpty(): NativeImage };

export const crashReporter: { start(options: { submitURL?: string; uploadToServer?: boolean; compress?: boolean }): void };

export interface PowerSaveBlocker {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): boolean;
}
export const powerSaveBlocker: PowerSaveBlocker;
