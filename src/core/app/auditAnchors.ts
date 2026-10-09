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

export class FileAuditAnchorStore implements AuditAnchorStore {
  readonly file: string;
  readonly keyFile: string;
  private readonly log: Logger['log'];
  private readonly sealer: SecretSealer | undefined;
  private keyBytes: Buffer | null = null;
  private anchors: Record<string, AuditAnchor> | null = null;

  constructor(opts: { dir: string; log: Logger['log']; sealer?: SecretSealer }) {
    this.file = path.join(opts.dir, ANCHORS_FILE);
    this.keyFile = path.join(opts.dir, ANCHOR_KEY_FILE);
    this.log = opts.log;
    this.sealer = opts.sealer;
  }

  private key(): Buffer {
    if (this.keyBytes) return this.keyBytes;
    const r = readJsonFile<{ v?: unknown; sealed?: unknown; key?: unknown }>(this.keyFile);
    if (r.status === 'ok' && r.value && typeof r.value.key === 'string') {
      try {
        const hex = r.value.sealed === true ? (this.sealer ? this.sealer.unseal(r.value.key) : '') : r.value.key;
        if (HEX64.test(hex)) {
          this.keyBytes = Buffer.from(hex, 'hex');
          return this.keyBytes;
        }
      } catch {
        /* fall through: a key sealed for another Windows account / computer */
      }
    }
    if (r.status === 'unreadable') {
      // Never replace a key we merely could not read right now: use a throw-away key for this run.
      this.log('warn', 'The edit-log anchor key could not be read; anchors cannot be confirmed this session');
      this.keyBytes = randomBytes(32);
      return this.keyBytes;
    }
    if (r.status !== 'missing') {
      try {
        fs.renameSync(this.keyFile, `${this.keyFile}.unusable-${fileTimestamp()}`);
      } catch {
        /* ignore */
      }
      this.log('warn', 'The edit-log anchor key was unusable and has been replaced; existing anchors cannot be confirmed');
    }
    const fresh = randomBytes(32);
    const hex = fresh.toString('hex');
    let stored: { v: 1; sealed: boolean; key: string } = { v: 1, sealed: false, key: hex };
    if (this.sealer) {
      try {
        stored = { v: 1, sealed: true, key: this.sealer.seal(hex) };
      } catch (err) {
        this.log('warn', 'OS protection for the edit-log anchor key is unavailable; stored with owner-only file permissions', { error: err });
      }
    }
    writeJsonAtomic(this.keyFile, stored);
    this.keyBytes = fresh;
    return fresh;
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
    const a = this.all()[companyId];
    return a ? { ...a } : null;
  }

  put(head: Omit<AuditAnchor, 'mac' | 'at'>, now: Date): AuditAnchor {
    const unsigned = { ...head, at: now.toISOString() };
    const anchor: AuditAnchor = { ...unsigned, mac: this.sign(unsigned) };
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
