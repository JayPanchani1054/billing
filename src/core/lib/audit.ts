/**
 * Tamper-evident edit log (audit trail).
 *
 * Every row stores prev_hash (hash of the previous row, or 64 zeros for the first row) and
 *   hash = sha256_hex(prev_hash + canonicalJson({ ts, user_id, username, action, entity_type,
 *                                                entity_id, entity_guid, entity_label,
 *                                                before_json, after_json }))
 * so altering, inserting or deleting any row in the middle breaks the chain from that point on.
 * The table is additionally append-only via triggers (001_init.ts).
 *
 * Secrets never enter the log: keys named like passwords are removed from before/after (any value),
 * and string values under keys that mention password/secret/token/api key are removed too (so a
 * `vaultPassword` or `apiToken` cannot slip through, while flags such as must_change_password = 1
 * are kept). Binary values and large data: URLs are replaced by short placeholders.
 *
 * Stored text must hash exactly as it reads back: SQLite cannot store lone UTF-16 surrogates
 * (they become U+FFFD) and node:sqlite truncates TEXT at NUL, so every text column is normalised
 * with storableText() BEFORE hashing. Otherwise an innocent entry (e.g. a label cut in the middle
 * of an emoji) would later be reported as tampered.
 */
import type { AuditEntry, Session } from '../api/context.ts';
import type { Db } from '../db/db.ts';
import { canonicalJson } from './canonical.ts';
import { sha256Hex } from './crypto.ts';

export const GENESIS_HASH = '0'.repeat(64);

const SECRET_KEYS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'current_password',
  'new_password',
  'confirm_password',
]);

/** Keys whose *string* values are treated as secrets wherever they appear. */
const SECRET_KEY_PATTERN = /pass(word|wd|phrase)|secret|token|api_?key|private_?key/i;

const MAX_INLINE_DATA_URL = 256;
/** Longest entity label kept in the log (code units; never splits a surrogate pair). */
export const MAX_AUDIT_LABEL = 500;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text exactly as SQLite will store and return it: lone surrogates → U+FFFD, NUL → U+FFFD,
 * optionally truncated without splitting a surrogate pair. Pure.
 */
export function storableText(value: string, maxLength?: number): string {
  let s = value.replace(LONE_SURROGATE, '\uFFFD').replace(/\u0000/g, '\uFFFD');
  if (maxLength !== undefined && s.length > maxLength) {
    s = s.slice(0, maxLength);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  }
  return s;
}

const isSecretEntry = (key: string, value: unknown): boolean =>
  SECRET_KEYS.has(key.toLowerCase()) || (SECRET_KEY_PATTERN.test(key) && (typeof value === 'string' || value instanceof Uint8Array));

/** Remove secrets and bulky binary from a value destined for the audit log. Pure. */
export function sanitizeForAudit(value: unknown): unknown {
  return clean(value, 0);
}

function clean(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 32) return '[nested too deeply]';
  if (typeof value === 'string') {
    if (value.length > MAX_INLINE_DATA_URL && value.startsWith('data:')) {
      const mime = value.slice(5, value.indexOf(';') > 0 ? value.indexOf(';') : 30);
      return `[${mime || 'data'} data URL, ${value.length} chars]`;
    }
    return value;
  }
  if (typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value;
  if (value instanceof Uint8Array) return `[binary, ${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  if (value instanceof Set) return [...value].map((v) => clean(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretEntry(k, v)) continue;
    out[k] = clean(v, depth + 1);
  }
  return out;
}

interface AuditRow {
  id: number;
  ts: string;
  user_id: number | null;
  username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  entity_guid: string | null;
  entity_label: string | null;
  before_json: string | null;
  after_json: string | null;
  prev_hash: string;
  hash: string;
}

type HashFields = Omit<AuditRow, 'id' | 'prev_hash' | 'hash'>;

/** Compute a row hash. Exported so verification tools and tests share one definition. */
export function computeAuditHash(prevHash: string, f: HashFields): string {
  const payload = {
    ts: f.ts,
    user_id: f.user_id ?? null,
    username: f.username ?? null,
    action: f.action,
    entity_type: f.entity_type ?? null,
    entity_id: f.entity_id ?? null,
    entity_guid: f.entity_guid ?? null,
    entity_label: f.entity_label ?? null,
    before_json: f.before_json ?? null,
    after_json: f.after_json ?? null,
  };
  return sha256Hex(prevHash + canonicalJson(payload));
}

const toJson = (v: unknown): string | null => (v === undefined ? null : canonicalJson(sanitizeForAudit(v)));

/**
 * Append one entry to the edit log. Call inside the same transaction as the change it records
 * (ctx.audit does this for route handlers). Returns the new row id.
 */
export function appendAudit(db: Db, entry: AuditEntry, session: Session | null, now: Date): number {
  return db.transaction(() => {
    const prev = db.value<string>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1') ?? GENESIS_HASH;
    const text = (v: unknown, max?: number): string | null => (v === undefined || v === null ? null : storableText(String(v), max));
    const fields: HashFields = {
      ts: now.toISOString(),
      user_id: session && Number.isSafeInteger(session.userId) ? session.userId : null,
      username: text(session?.username, 200),
      action: storableText(String(entry.action)),
      entity_type: text(entry.entityType, 100),
      // Only safe integers survive a round trip through SQLite INTEGER → JS number.
      entity_id: Number.isSafeInteger(entry.entityId) ? (entry.entityId as number) : null,
      entity_guid: text(entry.entityGuid, 100),
      entity_label: text(entry.entityLabel, MAX_AUDIT_LABEL),
      // canonicalJson escapes lone surrogates and control characters, so these are always storable.
      before_json: toJson(entry.before),
      after_json: toJson(entry.after),
    };
    const hash = computeAuditHash(prev, fields);
    const r = db.run(
      `INSERT INTO audit_log (ts, user_id, username, action, entity_type, entity_id, entity_guid, entity_label,
                              before_json, after_json, prev_hash, hash)
       VALUES (:ts, :user_id, :username, :action, :entity_type, :entity_id, :entity_guid, :entity_label,
               :before_json, :after_json, :prev_hash, :hash)`,
      { ...fields, prev_hash: prev, hash },
    );
    return r.lastInsertRowid;
  });
}

export type AuditVerifyResult =
  | { ok: true; count: number }
  /** brokenAtId: first row whose link or content does not match; count: rows verified before it. */
  | { ok: false; brokenAtId: number; count: number; reason: 'prev_hash_mismatch' | 'hash_mismatch' };

/**
 * Walk the whole chain in id order (paged, so large logs do not load into memory at once).
 * Note: truncation of the newest rows cannot be detected from the chain alone.
 */
export function verifyAuditChain(db: Db, table = 'audit_log'): AuditVerifyResult {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error('Invalid table name');
  const PAGE = 2000;
  let expectedPrev = GENESIS_HASH;
  let lastId = 0;
  let count = 0;
  for (;;) {
    const rows = db.all<AuditRow>(`SELECT * FROM ${table} WHERE id > :lastId ORDER BY id LIMIT ${PAGE}`, { lastId });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) return { ok: false, brokenAtId: row.id, count, reason: 'prev_hash_mismatch' };
      if (computeAuditHash(row.prev_hash, row) !== row.hash) return { ok: false, brokenAtId: row.id, count, reason: 'hash_mismatch' };
      expectedPrev = row.hash;
      lastId = row.id;
      count++;
    }
  }
  return { ok: true, count };
}
