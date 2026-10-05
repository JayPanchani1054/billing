/**
 * Access to the preload bridge (`window.bahi`). Every native call goes through `native()` which
 * unwraps the ApiResult and throws ApiError — never call window.bahi directly from screens.
 */
import type { BahiBridge, BridgeEvents, NativeAction, NativeActions } from '../../shared/bridge.ts';
import { ApiError } from './lib/apiErrors.ts';

/** The bridge, or null when the page runs outside Electron (plain browser, tests). */
export function getBridge(): BahiBridge | null {
  if (typeof window === 'undefined') return null;
  const b = (window as Partial<Window>).bahi;
  return b && typeof b.api === 'function' && typeof b.native === 'function' ? b : null;
}

export function hasBridge(): boolean {
  return getBridge() !== null;
}

function requireBridge(what: string): BahiBridge {
  const b = getBridge();
  if (!b) throw new ApiError('BRIDGE_UNAVAILABLE', 'Bahi ERP must be opened from the desktop app.', undefined, what);
  return b;
}

/** Call a native (Electron-only) action: dialogs, printing, theme, quit… */
export async function native<A extends NativeAction>(action: A, payload: NativeActions[A]['in']): Promise<NativeActions[A]['out']> {
  const bridge = requireBridge(action);
  let res: Awaited<ReturnType<BahiBridge['native']>>;
  try {
    res = await bridge.native(action, payload);
  } catch {
    throw new ApiError('IPC_FAILED', 'The app could not complete the request.', undefined, action);
  }
  if (!res || typeof res !== 'object') throw new ApiError('IPC_FAILED', 'The app returned an unexpected response.', undefined, action);
  if (!res.ok) throw ApiError.from(res.error, action);
  return res.data as NativeActions[A]['out'];
}

/** Subscribe to a bridge event; a no-op outside Electron. */
export function onBridgeEvent<E extends keyof BridgeEvents>(event: E, listener: (payload: BridgeEvents[E]) => void): () => void {
  const b = getBridge();
  if (!b) return () => undefined;
  try {
    return b.on(event, listener);
  } catch {
    return () => undefined;
  }
}

let lastDirty: boolean | null = null;
/** Tell main whether there is unsaved work (controls its close confirmation). De-duplicated. */
export function setNativeDirty(dirty: boolean): void {
  if (lastDirty === dirty) return;
  lastDirty = dirty;
  try {
    getBridge()?.setDirty(dirty);
  } catch {
    // ignore — the close guard simply won't ask
  }
}
