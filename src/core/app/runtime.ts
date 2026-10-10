/**
 * The core runtime used by Electron main. Main creates exactly one runtime at startup and forwards
 * every `pevqori:api` IPC call to runtime.dispatch(route, input).
 *
 *   const runtime = createRuntime({ userDataDir: app.getPath('userData'),
 *                                   defaultDataDir: path.join(app.getPath('documents'), 'Pevqori'),
 *                                   appVersion: app.getVersion(), logDir: app.getPath('logs') });
 *   ipcMain.handle(IPC.api, (_e, route, input) => runtime.dispatch(route, input));
 *   app.on('will-quit', () => runtime.shutdown());   // F12 automatic backup (bounded), then close the company
 */
import path from 'node:path';
import type { ApiResult } from '../../shared/api.ts';
import type { AppRuntime, Clock, PathUse } from '../api/context.ts';
import type { RouteMap } from '../api/route.ts';
import { routes as allRoutes } from '../api/routes.ts';
import type { SecretSealer } from './auditAnchors.ts';
import { createRuntimeWithRoutes } from './runtime-core.ts';

export interface RuntimeOptions {
  userDataDir: string;
  defaultDataDir: string;
  appVersion: string;
  /** Folder for pevqori.log (default <userDataDir>/logs). */
  logDir?: string;
  clock?: Clock;
  /** Mirror log lines to the console (development). Default: NODE_ENV === 'development'. */
  consoleLog?: boolean;
  /** Idle timeout for secured companies in ms (default 30 minutes). */
  idleTimeoutMs?: number;
  /**
   * Approve a new data folder for 'app.dataDir.set' (return false to refuse with FORBIDDEN). Main should
   * pass a check against folders the user picked in a native dialog during this session (§8: the
   * renderer never supplies arbitrary paths). The current data folder is always allowed.
   */
  authorizeDataDir?: (absPath: string) => boolean;
  /**
   * Approve any other path the renderer sends (backup folder to write/list, backup file to read):
   * main passes a check against the files and folders picked in a native dialog this session. Paths
   * inside the data folder (and, for company routes, the configured backup folder) need no approval.
   * Omitted: ordinary local paths are allowed and UNC/device paths refused (core/lib/paths.ts).
   */
  authorizePath?: (absPath: string, use: PathUse) => boolean;
  /**
   * OS protection for the per-installation edit-log anchor key (Electron safeStorage → DPAPI on
   * Windows). Omitted: the key file is stored with owner-only permissions. See app/auditAnchors.ts.
   */
  secretSealer?: SecretSealer;
  /**
   * The per-installation edit-log anchor key (32 bytes), already loaded — and sealed on disk with the
   * OS — by Electron main (app/auditAnchors.ts loadOrCreateAnchorKey). The core runs on a worker
   * thread where safeStorage does not exist, so main loads the key and passes it in. Takes precedence
   * over `secretSealer`.
   */
  auditAnchorKey?: Uint8Array;
  /**
   * Routes dispatched (in order, as the current session) before the open company is closed on
   * shutdown — each bounded by `shutdownStepTimeoutMs`, failures only logged. createRuntime() passes
   * DEFAULT_SHUTDOWN_ROUTES: the F12 automatic backup, so closing the window or quitting the app
   * (paths that never reach the renderer's close flow) still backs up.
   */
  shutdownRoutes?: ReadonlyArray<{ route: string; input: unknown }>;
  /** Longest one shutdown route may take before the company is closed anyway (default 20 s). */
  shutdownStepTimeoutMs?: number;
}

/** What createRuntime() runs before closing the company on quit (see RuntimeOptions.shutdownRoutes). */
export const DEFAULT_SHUTDOWN_ROUTES: ReadonlyArray<{ route: string; input: unknown }> = [{ route: 'data.backup.auto', input: { trigger: 'close' } }];

export interface Runtime {
  dispatch(route: string, input: unknown): Promise<ApiResult<unknown>>;
  readonly app: AppRuntime;
  /** Close the open company cleanly (checkpoint WAL, release lock). Called on app quit. */
  shutdown(): Promise<void>;
  /** True while a company is open (main uses it for close confirmations). */
  hasOpenCompany(): boolean;
  /** Persisted UI theme preference (config.json). */
  getTheme(): 'system' | 'light' | 'dark';
  setTheme(mode: 'system' | 'light' | 'dark'): void;
}

export function createRuntime(opts: RuntimeOptions): Runtime {
  return createRuntimeWithRoutes({ ...opts, shutdownRoutes: opts.shutdownRoutes ?? DEFAULT_SHUTDOWN_ROUTES }, allRoutes as RouteMap);
}

/** Default log folder when main does not supply one. */
export const defaultLogDir = (userDataDir: string): string => path.join(userDataDir, 'logs');
