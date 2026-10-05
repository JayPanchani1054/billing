/**
 * The IPC surface: exactly two invoke channels (api, native) and one fire-and-forget channel (dirty).
 * Every message is checked to come from the top-level frame of an app window on the app origin;
 * inputs are shape-checked before the core dispatcher validates them again against route schemas.
 * Handlers always resolve to an ApiResult — nothing is ever thrown across the bridge.
 */
import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/api.ts';
import type { ApiResult } from '../shared/api.ts';
import type { Runtime } from '../core/app/runtime.ts';
import { DIRTY_CHANNEL } from './channels.ts';
import type { DevServer } from './config.ts';
import { describeError, log } from './log.ts';
import type { NativeHandler } from './native.ts';
import { isTrustedFrame, isValidRouteName } from './policy.ts';
import type { WindowManager } from './window.ts';

const FORBIDDEN: ApiResult<never> = {
  ok: false,
  error: { code: 'FORBIDDEN', message: 'This request is not allowed.' },
};

const INTERNAL: ApiResult<never> = {
  ok: false,
  error: { code: 'INTERNAL', message: 'An unexpected error occurred. Details have been written to the application log.' },
};

export interface IpcDeps {
  runtime: Runtime;
  native: NativeHandler;
  windows: WindowManager;
  dev: DevServer | null;
}

function trusted(event: IpcMainInvokeEvent | IpcMainEvent, deps: IpcDeps): boolean {
  return deps.windows.isAppWebContents(event.sender) && isTrustedFrame(event.senderFrame, deps.dev);
}

let rejectedCount = 0;
function reportRejected(channel: string, reason: string): void {
  // Bounded so a misbehaving renderer cannot flood the log.
  if (rejectedCount++ < 50) log('warn', 'Rejected IPC message', { channel, reason });
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle(IPC.api, async (event, route: unknown, input: unknown): Promise<ApiResult<unknown>> => {
    if (!trusted(event, deps)) {
      reportRejected(IPC.api, 'untrusted sender');
      return FORBIDDEN;
    }
    if (!isValidRouteName(route)) {
      reportRejected(IPC.api, 'malformed route name');
      return { ok: false, error: { code: 'UNKNOWN_ROUTE', message: 'Unknown request.' } };
    }
    try {
      return await deps.runtime.dispatch(route, input);
    } catch (err) {
      log('error', `Dispatcher threw for route ${route}`, describeError(err));
      return INTERNAL;
    }
  });

  ipcMain.handle(IPC.native, async (event, action: unknown, payload: unknown): Promise<ApiResult<unknown>> => {
    if (!trusted(event, deps)) {
      reportRejected(IPC.native, 'untrusted sender');
      return FORBIDDEN;
    }
    try {
      return await deps.native({ sender: event.sender, window: BrowserWindow.fromWebContents(event.sender) }, action, payload);
    } catch (err) {
      log('error', 'Native handler threw', describeError(err));
      return INTERNAL;
    }
  });

  ipcMain.on(DIRTY_CHANNEL, (event, dirty: unknown) => {
    if (!trusted(event, deps)) {
      reportRejected(DIRTY_CHANNEL, 'untrusted sender');
      return;
    }
    deps.windows.setDirty(event.sender, dirty === true);
  });
}
