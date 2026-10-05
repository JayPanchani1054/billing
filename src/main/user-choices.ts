/**
 * Folders the user picked through a native folder dialog during this session. The core runtime
 * accepts a new data folder only if it is in this set (see RuntimeOptions.authorizeDataDir), so a
 * compromised renderer cannot redirect company data to an arbitrary path.
 */
import { PathSet } from './files.ts';

export const chosenFolders = new PathSet();
