/**
 * Entry of the separate updater bundle out/main/updater.cjs (scripts/build-config.mjs `updater`).
 *
 * electron-updater lives ONLY in this bundle: out/main/index.cjs never contains it (R2 — nothing is added to
 * the start-up path) and loads this file with a computed-path require the first time the user checks for
 * updates (updates/loader.ts). With updates turned off the file is never even read.
 *
 * The adapter below is the whole surface the update service uses (service.ts UpdaterPort); everything else
 * of the library stays unused.
 */
import { autoUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import type { UpdateOffer, UpdaterPort } from './service.ts';

function offerOf(info: UpdateInfo): UpdateOffer {
  const files = Array.isArray(info.files) ? info.files : [];
  const installer = files.find((f) => typeof f.url === 'string' && /\.exe$/i.test(f.url)) ?? files[0];
  return {
    version: String(info.version ?? ''),
    releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : '',
    releaseNotes: info.releaseNotes ?? null,
    sizeBytes: typeof installer?.size === 'number' ? installer.size : 0,
  };
}

export function createUpdater(): UpdaterPort {
  const u = autoUpdater;
  return {
    configure(settings, logger) {
      u.autoDownload = settings.autoDownload;
      u.autoInstallOnAppQuit = settings.autoInstallOnAppQuit;
      u.allowDowngrade = settings.allowDowngrade;
      u.allowPrerelease = settings.allowPrerelease;
      u.disableWebInstaller = settings.disableWebInstaller;
      u.logger = logger;
      // The library emits 'error' as well as rejecting; an EventEmitter without an 'error' listener would
      // turn that into an uncaught exception (e.g. from the installer spawn in quitAndInstall).
      u.on('error', (error: Error) => logger.error(`error event: ${error?.message ?? String(error)}`));
    },
    async check() {
      // The library tells "newer or not" through events emitted before checkForUpdates() resolves.
      let available: boolean | null = null;
      const yes = (): void => {
        available = true;
      };
      const no = (): void => {
        available = false;
      };
      u.once('update-available', yes);
      u.once('update-not-available', no);
      try {
        const result = await u.checkForUpdates();
        if (!result || available === null) return null;
        return { available, offer: offerOf(result.updateInfo) };
      } finally {
        u.removeListener('update-available', yes);
        u.removeListener('update-not-available', no);
      }
    },
    async download(onProgress) {
      const listener = (p: ProgressInfo): void => onProgress({ percent: p.percent, bytesPerSecond: p.bytesPerSecond });
      u.on('download-progress', listener);
      try {
        // Resolves after the sha512 (and, for signed builds, Authenticode publisher) checks passed.
        await u.downloadUpdate();
      } finally {
        u.removeListener('download-progress', listener);
      }
    },
    quitAndInstall(runAfter) {
      // isSilent: no installer wizard; isForceRunAfter: start Pevqori again when done (Restart to update).
      u.quitAndInstall(true, runAfter);
    },
  };
}
