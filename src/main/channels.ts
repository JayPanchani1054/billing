/**
 * IPC channel names private to main ↔ preload (the public ones live in src/shared/api.ts → IPC).
 * Kept dependency-free: the sandboxed preload bundles this file and may only require('electron').
 */

/** Renderer → main, fire-and-forget: the window has (or no longer has) unsaved work. */
export const DIRTY_CHANNEL = 'pevqori:dirty';
