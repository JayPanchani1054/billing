/**
 * Renderer globals. `window.bahi` is installed by the preload script (src/preload/index.ts) and is
 * the ONLY channel to the main process. It is absent when the page is opened in a plain browser —
 * always go through app/bridge.ts (getBridge) instead of touching window.bahi directly.
 */
import type { BahiBridge } from '../../shared/bridge.ts';

declare global {
  interface Window {
    bahi: BahiBridge;
  }
}

export {};
