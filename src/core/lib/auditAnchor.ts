/**
 * External anchoring of the edit-log hash chain.
 *
 * The chain in audit_log (audit.ts) proves that entries were not altered, inserted or removed IN THE
 * MIDDLE — but anyone who can write the company file can drop the append-only triggers, rewrite or
 * cut off entries and recompute every hash from genesis; the chain alone then still verifies. To make
 * that detectable, the app keeps the latest head of each company's chain (last id + hash) OUTSIDE the
 * company database — in the installation's userData folder (app/auditAnchors.ts) and in every backup
 * manifest — authenticated with an HMAC key that is never stored in a company file or a backup.
 *
 * A later check compares the current chain with that anchor: the anchored entry must still exist with
 * the same hash. Because each hash covers everything before it, this detects
 *   - truncation (the anchored entry is gone),
 *   - any rewrite of the anchored entry or of anything before it (its hash changes),
 *   - a company file swapped for another one (different company guid),
 *   - an edited anchor (its MAC no longer verifies).
 * Limits (documented in docs/SECURITY.md T4): entries written after the newest anchor can still be
 * removed undetected if the app is stopped before it records a new anchor (anchors are refreshed on
 * every API call after a change, on close, and in every backup); and an attacker who controls the
 * user's Windows profile (userData + the DPAPI-protected key) can forge anchors too.
 */
import type { AuditAnchor } from '../api/context.ts';
import type { Db } from '../db/db.ts';
import { LEGACY_ANCHOR_MAC_PREFIX } from './legacyNames.ts';

export interface AuditHead {
  lastId: number;
  lastHash: string;
}

/** Newest entry of the edit log (null when empty). Uses the primary key: O(log n). */
export function auditHead(db: Db): AuditHead | null {
  const r = db.get<{ id: number; hash: string }>('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1');
  return r ? { lastId: r.id, lastHash: r.hash } : null;
}

/** Domain-separation prefix of the MAC input. */
export const ANCHOR_MAC_PREFIX = 'pevqori-audit-anchor-v1';

/**
 * Canonical byte string the MAC covers (field order fixed; '|' cannot occur in ids, guids, hex or ISO
 * dates). `legacy` = the prefix of anchors recorded before the rename (verification only).
 */
export function anchorMacInput(a: Omit<AuditAnchor, 'mac'>, legacy = false): string {
  return [legacy ? LEGACY_ANCHOR_MAC_PREFIX : ANCHOR_MAC_PREFIX, a.companyId, a.companyGuid, String(a.lastId), a.lastHash, a.at].join('|');
}

export type AnchorStatus = 'match' | 'mismatch' | 'invalid' | 'missing';

export interface AnchorCheck {
  status: AnchorStatus;
  /** When the anchor was recorded (null when missing). */
  at: string | null;
  anchoredId: number | null;
  /** What was found, for the report. */
  reason: 'ok' | 'no_anchor' | 'bad_mac' | 'other_company' | 'entry_removed' | 'entry_rewritten';
}

/**
 * Compare a company's edit log with its anchor. `macValid` = AuditAnchorStore.verify(anchor).
 * Pure apart from one indexed read.
 */
export function checkAuditAnchor(db: Db, anchor: AuditAnchor | null, macValid: boolean, companyGuid: string): AnchorCheck {
  if (!anchor) return { status: 'missing', at: null, anchoredId: null, reason: 'no_anchor' };
  const base = { at: anchor.at, anchoredId: anchor.lastId };
  if (!macValid) return { ...base, status: 'invalid', reason: 'bad_mac' };
  if (anchor.companyGuid !== companyGuid) return { ...base, status: 'mismatch', reason: 'other_company' };
  const row = db.get<{ hash: string }>('SELECT hash FROM audit_log WHERE id = :id', { id: anchor.lastId });
  if (!row) return { ...base, status: 'mismatch', reason: 'entry_removed' };
  if (row.hash !== anchor.lastHash) return { ...base, status: 'mismatch', reason: 'entry_rewritten' };
  return { ...base, status: 'match', reason: 'ok' };
}
