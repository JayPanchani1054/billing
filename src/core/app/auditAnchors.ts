/**
 * Out-of-database anchors for the edit-log hash chain (see core/lib/auditAnchor.ts for the model).
 *
 *   <userDataDir>/audit-anchors.json   { v: 1, anchors: { <company folder id>: AuditAnchor } }
 *   <userDataDir>/audit-anchor.key     { v: 1, sealed: boolean, key: <hex or sealed text> }
 *
 * The key is 32 random bytes created on first use. Electron main may pass a `sealer` (safeStorage:
 * DPAPI on Windows) so the key file is useless when copied off the user's account; without one the
 * key is stored as hex with owner-only permissions. Neither file is ever inside the data folder, a
 * company file or a backup — so editing a company file (or a backup) cannot re-sign its anchor.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AuditAnchor, AuditAnchorStore } from '../api/context.ts';
import { anchorMacInput } from '../lib/auditAnchor.ts';
import { fileTimestamp, readJsonFile, writeJsonAtomic } from '../lib/fsutil.ts';
import type { Logger } from './logger.ts';

/** Protects a secret with the OS (Electron safeStorage). Both directions throw on failure. */
export interface SecretSealer {
  seal(plain: string): string;
  unseal(sealed: string): string;
}

export const ANCHORS_FILE = 'audit-anchors.json';
export const ANCHOR_KEY_FILE = 'audit-anchor.key';

const HEX64 = /^[0-9a-f]{64}$/;

function isAnchor(v: unknown, companyId: string): v is AuditAnchor {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    a.companyId === companyId &&
    typeof a.companyGuid === 'string' &&
    typeof a.lastId === 'number' &&
    Number.isSafeInteger(a.lastId) &&
    typeof a.lastHash === 'string' &&
    typeof a.at === 'string' &&
    typeof a.mac === 'string'
  );
}

/**
 * Read this installation's anchor key from `<dir>/audit-anchor.key`, creating it on first use. With a
 * `sealer` (Electron safeStorage → DPAPI on Windows) the key is stored sealed, so the file is useless
 * when copied to another account or computer; a key stored unsealed earlier is re-sealed. Electron main
 * calls this (safeStorage exists only on the main thread) and hands the key to the core worker
 * (RuntimeOptions.auditAnchorKey); without main, FileAuditAnchorStore calls it itself.
 */
export function loadOrCreateAnchorKey(opts: { dir: string; log: Logger['log']; sealer?: SecretSealer }): Buffer {
  return loadAnchorKey(opts).key;
}

/**
 * loadOrCreateAnchorKey with its provenance. `ephemeral` = the real key exists but cannot be used in
 * this run (unreadable right now, or sealed by the OS and read without the sealer): `key` is then a
 * throw-away key. Anchors must never be written or judged with it — a check-point signed with it
 * would fail verification under the real key in the next run and be reported as tampering.
 */
export function loadAnchorKey(opts: { dir: string; log: Logger['log']; sealer?: SecretSealer }): { key: Buffer; ephemeral: boolean } {
  const keyFile = path.join(opts.dir, ANCHOR_KEY_FILE);
  const { log, sealer } = opts;
  const r = readJsonFile<{ v?: unknown; sealed?: unknown; key?: unknown }>(keyFile);
  if (r.status === 'ok' && r.value && typeof r.value.key === 'string') {
    try {
      const sealed = r.value.sealed === true;
      const hex = sealed ? (sealer ? sealer.unseal(r.value.key) : '') : r.value.key;
      if (HEX64.test(hex)) {
        if (!sealed && sealer) {
          // Upgrade a key written before OS protection was available (never fatal).
          try {
            writeJsonAtomic(keyFile, { v: 1, sealed: true, key: sealer.seal(hex) });
          } catch (err) {
            log('warn', 'Could not protect the edit-log anchor key with the operating system', { error: err });
          }
        }
        return { key: Buffer.from(hex, 'hex'), ephemeral: false };
      }
      if (sealed && !sealer) {
        // Sealed by Electron main but read without it (e.g. a headless tool): never replace it.
        log('warn', 'The edit-log anchor key is protected by the operating system; anchors cannot be confirmed here');
        return { key: randomBytes(32), ephemeral: true };
      }
    } catch {
      /* fall through: a key sealed for another Windows account / computer */
    }
  }
  if (r.status === 'unreadable') {
    // Never replace a key we merely could not read right now: use a throw-away key for this run.
    log('warn', 'The edit-log anchor key could not be read; anchors cannot be confirmed this session');
    return { key: randomBytes(32), ephemeral: true };
  }
  if (r.status !== 'missing') {
    try {
      fs.renameSync(keyFile, `${keyFile}.unusable-${fileTimestamp()}`);
    } catch {
      /* ignore */
    }
    log('warn', 'The edit-log anchor key was unusable and has been replaced; existing anchors cannot be confirmed');
  }
  const fresh = randomBytes(32);
  const hex = fresh.toString('hex');
  let stored: { v: 1; sealed: boolean; key: string } = { v: 1, sealed: false, key: hex };
  if (sealer) {
    try {
      stored = { v: 1, sealed: true, key: sealer.seal(hex) };
    } catch (err) {
      log('warn', 'OS protection for the edit-log anchor key is unavailable; stored with owner-only file permissions', { error: err });
    }
  }
  writeJsonAtomic(keyFile, stored);
  return { key: fresh, ephemeral: false };
}

export class FileAuditAnchorStore implements AuditAnchorStore {
  readonly file: string;
  readonly keyFile: string;
  private readonly log: Logger['log'];
  private readonly sealer: SecretSealer | undefined;
  private keyBytes: Buffer | null = null;
  /** The real key cannot be used this run (see loadAnchorKey): read and write no check-points. */
  private ephemeral = false;
  private anchors: Record<string, AuditAnchor> | null = null;

  /**
   * `key`: the installation key already loaded by Electron main (loadOrCreateAnchorKey with the OS
   * sealer); when omitted the key file is read (or created) here on first use, with `sealer` if given.
   */
  constructor(opts: { dir: string; log: Logger['log']; sealer?: SecretSealer; key?: Uint8Array }) {
    this.file = path.join(opts.dir, ANCHORS_FILE);
    this.keyFile = path.join(opts.dir, ANCHOR_KEY_FILE);
    this.log = opts.log;
    this.sealer = opts.sealer;
    if (opts.key && opts.key.length === 32) this.keyBytes = Buffer.from(opts.key);
  }

  private key(): Buffer {
    if (!this.keyBytes) {
      const loaded = loadAnchorKey({ dir: path.dirname(this.keyFile), log: this.log, sealer: this.sealer });
      this.keyBytes = loaded.key;
      this.ephemeral = loaded.ephemeral;
    }
    return this.keyBytes;
  }

  /** False when this run cannot use the installation key (check-points are then neither judged nor written). */
  get usable(): boolean {
    this.key();
    return !this.ephemeral;
  }

  private all(): Record<string, AuditAnchor> {
    if (this.anchors) return this.anchors;
    const r = readJsonFile<{ anchors?: unknown }>(this.file);
    const out: Record<string, AuditAnchor> = {};
    if (r.status === 'ok' && r.value && typeof r.value.anchors === 'object' && r.value.anchors) {
      for (const [id, a] of Object.entries(r.value.anchors as Record<string, unknown>)) if (isAnchor(a, id)) out[id] = a;
    } else if (r.status === 'corrupt') {
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${fileTimestamp()}`);
      } catch {
        /* ignore */
      }
      this.log('warn', 'Edit-log anchors file was unreadable; kept aside and started again');
    }
    this.anchors = out;
    return out;
  }

  sign(head: Omit<AuditAnchor, 'mac'>): string {
    return createHmac('sha256', this.key()).update(anchorMacInput(head)).digest('hex');
  }

  verify(anchor: AuditAnchor): boolean {
    if (typeof anchor.mac !== 'string' || !HEX64.test(anchor.mac)) return false;
    const expected = Buffer.from(this.sign(anchor), 'hex');
    return timingSafeEqual(expected, Buffer.from(anchor.mac, 'hex'));
  }

  get(companyId: string): AuditAnchor | null {
    // Without the real key every check-point would look edited: report "none" rather than tampering.
    if (!this.usable) return null;
    const a = this.all()[companyId];
    return a ? { ...a } : null;
  }

  put(head: Omit<AuditAnchor, 'mac' | 'at'>, now: Date): AuditAnchor {
    const unsigned = { ...head, at: now.toISOString() };
    const anchor: AuditAnchor = { ...unsigned, mac: this.sign(unsigned) };
    // Never overwrite a check-point with one signed by a throw-away key (it would fail next run).
    if (!this.usable) return anchor;
    const all = this.all();
    all[head.companyId] = anchor;
    writeJsonAtomic(this.file, { v: 1, anchors: all });
    return { ...anchor };
  }

  remove(companyId: string): void {
    const all = this.all();
    if (!(companyId in all)) return;
    delete all[companyId];
    writeJsonAtomic(this.file, { v: 1, anchors: all });
  }
}
