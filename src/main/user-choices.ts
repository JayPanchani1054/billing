/**
 * Files and folders the user picked through a native dialog during this session. The core accepts a
 * renderer-supplied path only if the user chose it (§8: the renderer never supplies arbitrary paths):
 *   - a new data folder must be a chosen folder (RuntimeOptions.authorizeDataDir);
 *   - any other path (backup folder to write/list, backup file to read) must be a chosen file (read
 *     only) or lie inside a chosen folder (RuntimeOptions.authorizePath → isUserChosenPath).
 * So a compromised renderer cannot redirect company data, or read/write files, at arbitrary paths.
 *
 * The core runs on a worker thread (core-worker.ts), so the allowlist is mirrored there: every choice
 * remembered here is passed to the listeners (index.ts → coreProxy.authorizeChoice) before the dialog
 * result is returned to the renderer — i.e. before any route naming that path can reach the core.
 * isUserChosenPath() is pure, so the worker applies exactly the same rule to its mirror.
 */
import type { PathUse } from '../core/api/context.ts';
import { PathSet } from './files.ts';

export const chosenFolders = new PathSet();
export const chosenFiles = new PathSet();

export interface ChosenSets {
  files: PathSet;
  folders: PathSet;
}

export type UserChoice = { kind: 'file' | 'folder'; path: string };

/**
 * Main's AppRuntime.authorizePath rule: anything inside a chosen folder may be read or written; a
 * chosen file may only be read (it does not authorise its folder, nor writing).
 */
export function isUserChosenPath(absPath: string, use: PathUse, sets: ChosenSets = { files: chosenFiles, folders: chosenFolders }): boolean {
  if (sets.folders.covers(absPath)) return true;
  return use === 'read-file' && sets.files.has(absPath);
}

const listeners = new Set<(choice: UserChoice) => void>();

function notify(choice: UserChoice): void {
  for (const listener of listeners) listener(choice);
}

/** Remember a folder chosen in a native dialog and tell every listener. */
export function rememberChosenFolder(absPath: string): void {
  chosenFolders.add(absPath);
  notify({ kind: 'folder', path: absPath });
}

/** Remember a file chosen in a native open dialog and tell every listener. */
export function rememberChosenFile(absPath: string): void {
  chosenFiles.add(absPath);
  notify({ kind: 'file', path: absPath });
}

/** Subscribe to user choices; returns the unsubscribe function. */
export function onUserChoice(listener: (choice: UserChoice) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
