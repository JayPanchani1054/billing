/**
 * OFFLINE TYPE SHIM — a faithful subset of electron-updater 6.x's type definitions (AppUpdater, main.d.ts)
 * and the builder-util-runtime types it re-exports, used ONLY by tsconfig.node.offline.json where npm is
 * unavailable. Real builds use the package's own types. If code needs an API missing here, add it with
 * the exact upstream signature.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Logger {
  info(message?: any): void;
  warn(message?: any): void;
  error(message?: any): void;
  debug?(message: string): void;
}

export interface ReleaseNoteInfo {
  readonly version: string;
  readonly note: string | null;
}

export interface BlockMapDataHolder {
  size?: number;
  blockMapSize?: number;
  readonly sha512: string;
  readonly isAdminRightsRequired?: boolean;
}

export interface UpdateFileInfo extends BlockMapDataHolder {
  url: string;
}

export interface UpdateInfo {
  readonly version: string;
  readonly files: Array<UpdateFileInfo>;
  readonly path: string;
  readonly sha512: string;
  releaseName?: string | null;
  releaseNotes?: string | Array<ReleaseNoteInfo> | null;
  releaseDate: string;
  readonly stagingPercentage?: number;
  readonly minimumSystemVersion?: string;
}

export interface ProgressInfo {
  total: number;
  delta: number;
  transferred: number;
  percent: number;
  bytesPerSecond: number;
}

export interface UpdateDownloadedEvent extends UpdateInfo {
  downloadedFile: string;
}

export declare class CancellationToken {
  get cancelled(): boolean;
  cancel(): void;
  dispose(): void;
}

export interface UpdateCheckResult {
  readonly updateInfo: UpdateInfo;
  readonly downloadPromise?: Promise<Array<string>> | null;
  readonly cancellationToken?: CancellationToken;
  readonly versionInfo: UpdateInfo;
}

export type AppUpdaterEvents = {
  error: (error: Error, message?: string) => void;
  'checking-for-update': () => void;
  'update-not-available': (info: UpdateInfo) => void;
  'update-available': (info: UpdateInfo) => void;
  'update-downloaded': (event: UpdateDownloadedEvent) => void;
  'download-progress': (info: ProgressInfo) => void;
  'update-cancelled': (info: UpdateInfo) => void;
  'appimage-filename-updated': (path: string) => void;
};

/** tiny-typed-emitter's TypedEmitter, as AppUpdater extends it. */
declare class TypedEmitter<L extends { [E in keyof L]: (...args: any[]) => any }> {
  addListener<U extends keyof L>(event: U, listener: L[U]): this;
  prependListener<U extends keyof L>(event: U, listener: L[U]): this;
  prependOnceListener<U extends keyof L>(event: U, listener: L[U]): this;
  removeListener<U extends keyof L>(event: U, listener: L[U]): this;
  removeAllListeners(event?: keyof L): this;
  once<U extends keyof L>(event: U, listener: L[U]): this;
  on<U extends keyof L>(event: U, listener: L[U]): this;
  off<U extends keyof L>(event: U, listener: L[U]): this;
  emit<U extends keyof L>(event: U, ...args: Parameters<L[U]>): boolean;
}

export declare abstract class AppUpdater extends TypedEmitter<AppUpdaterEvents> {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  fullChangelog: boolean;
  allowDowngrade: boolean;
  disableWebInstaller: boolean;
  disableDifferentialDownload: boolean;
  forceDevUpdateConfig: boolean;
  get channel(): string | null;
  set channel(value: string | null);
  get logger(): Logger | null;
  set logger(value: Logger | null);
  readonly currentVersion: unknown;
  isUpdaterActive(): boolean;
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(cancellationToken?: CancellationToken): Promise<Array<string>>;
  abstract quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export declare const autoUpdater: AppUpdater;
