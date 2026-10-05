/**
 * The core runtime used by Electron main. Main creates exactly one runtime at startup and forwards
 * every `bahi:api` IPC call to runtime.dispatch(route, input).
 *
 *   const runtime = createRuntime({ userDataDir: app.getPath('userData'),
 *                                   defaultDataDir: path.join(app.getPath('documents'), 'Bahi ERP'),
 *                                   appVersion: app.getVersion(), logDir: app.getPath('logs') });
 *   ipcMain.handle(IPC.api, (_e, route, input) => runtime.dispatch(route, input));
 *   app.on('before-quit', () => runtime.shutdown());
 */
import path from 'node:path';
import type { ApiResult } from '../../shared/api.ts';
import type { AppRuntime, Clock } from '../api/context.ts';
import type { RouteMap } from '../api/route.ts';
import { routes as allRoutes } from '../api/routes.ts';
import { createRuntimeWithRoutes } from './runtime-core.ts';

export interface RuntimeOptions {
  userDataDir: string;
  defaultDataDir: string;
  appVersion: string;
  /** Folder for bahi.log (default <userDataDir>/logs). */
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
}

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
  return createRuntimeWithRoutes(opts, allRoutes as RouteMap);
}

/** Default log folder when main does not supply one. */
export const defaultLogDir = (userDataDir: string): string => path.join(userDataDir, 'logs');
