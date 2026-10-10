/**
 * Preload (sandboxed, context-isolated). Exposes exactly the PevqoriBridge contract as `window.pevqori` and
 * nothing else — never ipcRenderer itself, never Node APIs. Bundled to CommonJS (out/preload/index.cjs)
 * because sandboxed preloads can only `require('electron')`; esbuild inlines the shared constants.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/api.ts';
import type { ApiResult } from '../shared/api.ts';
import type { PevqoriBridge, BridgeEvents, NativeAction, NativeActions } from '../shared/bridge.ts';
import { DIRTY_CHANNEL } from '../main/channels.ts';

type EventName = keyof BridgeEvents;

const EVENT_NAMES: ReadonlySet<string> = new Set<EventName>(['command', 'before-close', 'theme-changed']);

/** One IPC listener for all bridge events; subscribers are kept per event name. */
const subscribers = new Map<string, Set<(payload: unknown) => void>>();

ipcRenderer.on(IPC.event, (_event, name: unknown, payload: unknown) => {
  if (typeof name !== 'string') return;
  const set = subscribers.get(name);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(payload);
    } catch (err) {
      console.error(`[pevqori] listener for "${name}" threw`, err);
    }
  }
});

function api(route: string, input: unknown): Promise<ApiResult<unknown>> {
  return ipcRenderer.invoke(IPC.api, route, input) as Promise<ApiResult<unknown>>;
}

function native<A extends NativeAction>(action: A, payload: NativeActions[A]['in']): Promise<ApiResult<NativeActions[A]['out']>> {
  return ipcRenderer.invoke(IPC.native, action, payload) as Promise<ApiResult<NativeActions[A]['out']>>;
}

function on<E extends EventName>(event: E, listener: (payload: BridgeEvents[E]) => void): () => void {
  if (!EVENT_NAMES.has(event) || typeof listener !== 'function') {
    throw new TypeError(`pevqori.on: unknown event "${String(event)}" or invalid listener`);
  }
  // A fresh wrapper per subscription: unsubscribing removes only this subscription, even when the
  // same listener function was registered more than once. The IpcRendererEvent never leaks out.
  const wrapped = (payload: unknown): void => listener(payload as BridgeEvents[E]);
  let set = subscribers.get(event);
  if (!set) {
    set = new Set();
    subscribers.set(event, set);
  }
  set.add(wrapped);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers.get(event)?.delete(wrapped);
  };
}

function setDirty(dirty: boolean): void {
  ipcRenderer.send(DIRTY_CHANNEL, dirty === true);
}

const bridge: PevqoriBridge = Object.freeze({
  api,
  native,
  on,
  setDirty,
  platform: process.platform,
});

contextBridge.exposeInMainWorld('pevqori', bridge);
