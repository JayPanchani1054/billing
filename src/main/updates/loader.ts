/**
 * Loads the updater bundle (out/main/updater.cjs, built from updates/entry.ts) on first use only.
 *
 * The require path is computed at run time on purpose: esbuild leaves a non-literal require alone, so
 * electron-updater is never pulled into out/main/index.cjs (src/main/build-scripts.test.ts checks both
 * the source graph and, after a build, the bundles). Never called while updates are off.
 */
import path from 'node:path';
import type { UpdaterPort } from './service.ts';

/** File name of the bundle next to index.cjs (scripts/build-config.mjs `updater.outfile`). */
export const UPDATER_BUNDLE = 'updater.cjs';

interface UpdaterBundle {
  createUpdater(): UpdaterPort;
}

export function loadUpdaterBundle(mainDir: string, load: (file: string) => unknown = (file) => require(file)): UpdaterPort {
  const file = path.join(mainDir, UPDATER_BUNDLE);
  const mod = load(file) as Partial<UpdaterBundle> | null;
  if (!mod || typeof mod.createUpdater !== 'function') throw new Error(`The updater bundle ${UPDATER_BUNDLE} is missing or invalid.`);
  return mod.createUpdater();
}
