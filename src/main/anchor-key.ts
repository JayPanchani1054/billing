/**
 * The per-installation key that signs the edit-log anchors (core/lib/auditAnchor.ts,
 * core/app/auditAnchors.ts). Main loads it — sealed on disk with Electron safeStorage (DPAPI on
 * Windows, Keychain on macOS, libsecret/kwallet on Linux) — and passes the raw key to the core worker
 * (CoreWorkerInit.auditAnchorKey), because safeStorage exists only on Electron's main thread.
 *
 * Effect: copying userData/audit-anchor.key to another Windows account or computer does not give the
 * key, so anchors cannot be re-signed after rewriting a company's edit log elsewhere. Someone running
 * code as the same Windows user can still unseal it (documented in docs/SECURITY.md T4).
 */
import { loadAnchorKey, type SecretSealer } from '../core/app/auditAnchors.ts';

/** The part of Electron's safeStorage this module uses (exact upstream signatures). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * A SecretSealer backed by safeStorage, or undefined when the OS offers no real protection (no
 * keyring, or Linux's 'basic_text' backend, which encrypts with a fixed, public password).
 */
export function safeStorageSealer(safe: SafeStorageLike, platform: NodeJS.Platform = process.platform): SecretSealer | undefined {
  try {
    if (!safe.isEncryptionAvailable()) return undefined;
    if (platform === 'linux' && safe.getSelectedStorageBackend?.() === 'basic_text') return undefined;
  } catch {
    return undefined;
  }
  return {
    seal: (plain) => safe.encryptString(plain).toString('base64'),
    unseal: (sealed) => safe.decryptString(Buffer.from(sealed, 'base64')),
  };
}

/**
 * Load (or create) the anchor key in `userDataDir`, sealed with safeStorage when available. Never
 * throws: on any failure — or when the real key cannot be used this run (sealed but safeStorage is
 * unavailable, file unreadable) — it logs and returns undefined, and the core then manages the key file
 * itself (and, without a usable key, neither judges nor writes check-points).
 */
export function loadAnchorKeyForWorker(
  userDataDir: string,
  safe: SafeStorageLike,
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown) => void,
  platform: NodeJS.Platform = process.platform,
): Uint8Array | undefined {
  try {
    const { key, ephemeral } = loadAnchorKey({ dir: userDataDir, log, sealer: safeStorageSealer(safe, platform) });
    return ephemeral ? undefined : new Uint8Array(key);
  } catch (err) {
    log('warn', 'Could not load the edit-log anchor key; the core will manage it', { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}
