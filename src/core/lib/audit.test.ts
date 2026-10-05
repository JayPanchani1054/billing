import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Session } from '../api/context.ts';
import { Db } from '../db/db.ts';
import { migrate } from '../db/migrate.ts';
import { appendAudit, computeAuditHash, GENESIS_HASH, MAX_AUDIT_LABEL, sanitizeForAudit, storableText, verifyAuditChain } from './audit.ts';
import { canonicalJson } from './canonical.ts';
import { sha256Hex } from './crypto.ts';

const NOW = new Date('2026-04-15T04:30:00.000Z');
const session: Session = {
  userId: 7,
  username: 'meera',
  displayName: 'Meera',
  role: 'Accountant',
  permissions: new Set(['vouchers.create']),
  isOwner: false,
  implicit: false,
  startedAt: NOW.toISOString(),
};

function freshDb(): Db {
  const db = new Db(':memory:');
  migrate(db);
  return db;
}

interface Row {
  id: number;
  ts: string;
  user_id: number | null;
  username: string | null;
  action: string;
  before_json: string | null;
  after_json: string | null;
  prev_hash: string;
  hash: string;
}

/** Append-only triggers are part of the schema; tests that simulate tampering lift them temporarily. */
function withoutTriggers(db: Db, fn: () => void): void {
  db.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
  try {
    fn();
  } finally {
    db.exec(`CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
             CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;`);
  }
}

function seedChain(db: Db, n: number): void {
  for (let i = 1; i <= n; i++) {
    appendAudit(db, { action: 'create', entityType: 'ledger', entityId: i, entityLabel: `Ledger ${i}`, after: { name: `Ledger ${i}` } }, session, new Date(NOW.getTime() + i * 1000));
  }
}

describe('appendAudit', () => {
  it('links rows into a SHA-256 chain starting from the genesis hash', () => {
    const db = freshDb();
    seedChain(db, 3);
    const rows = db.all<Row>('SELECT * FROM audit_log ORDER BY id');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].prev_hash, GENESIS_HASH);
    assert.equal(rows[1].prev_hash, rows[0].hash);
    assert.equal(rows[2].prev_hash, rows[1].hash);
    assert.equal(rows[0].user_id, 7);
    assert.equal(rows[0].username, 'meera');
    // Hash definition: sha256(prev_hash + canonicalJson(fields)).
    const expected = sha256Hex(
      GENESIS_HASH +
        canonicalJson({
          ts: rows[0].ts,
          user_id: 7,
          username: 'meera',
          action: 'create',
          entity_type: 'ledger',
          entity_id: 1,
          entity_guid: null,
          entity_label: 'Ledger 1',
          before_json: null,
          after_json: '{"name":"Ledger 1"}',
        }),
    );
    assert.equal(rows[0].hash, expected);
    db.close();
  });

  it('records system entries without a session', () => {
    const db = freshDb();
    appendAudit(db, { action: 'login_failed', entityType: 'user', entityLabel: 'ghost' }, null, NOW);
    const row = db.get<Row>('SELECT * FROM audit_log');
    assert.equal(row?.user_id, null);
    assert.equal(row?.username, null);
    assert.equal(row?.before_json, null);
    db.close();
  });

  it('strips secrets and bulky binary from before/after', () => {
    const db = freshDb();
    const logo = `data:image/png;base64,${'A'.repeat(1000)}`;
    appendAudit(
      db,
      {
        action: 'alter',
        entityType: 'user',
        before: { username: 'a', password_hash: 'scrypt$…', nested: { passwordHash: 'x', password: 'p', newPassword: 'n' } },
        after: { username: 'a', must_change_password: 1, logo, blob: new Uint8Array(10) },
      },
      session,
      NOW,
    );
    const row = db.get<Row>('SELECT * FROM audit_log');
    assert.equal(row?.before_json, '{"nested":{},"username":"a"}');
    const after = JSON.parse(row?.after_json ?? '{}');
    assert.equal(after.must_change_password, 1, 'flags that merely mention password are kept');
    assert.equal(after.logo, '[image/png data URL, 1022 chars]');
    assert.equal(after.blob, '[binary, 10 bytes]');
    db.close();
  });

  it('is rolled back with the surrounding transaction', () => {
    const db = freshDb();
    assert.throws(() =>
      db.transaction(() => {
        appendAudit(db, { action: 'create' }, session, NOW);
        throw new Error('boom');
      }),
    );
    assert.equal(db.value('SELECT COUNT(*) FROM audit_log'), 0);
    db.close();
  });

  it('the table itself refuses UPDATE and DELETE', () => {
    const db = freshDb();
    seedChain(db, 1);
    assert.throws(() => db.run(`UPDATE audit_log SET action = 'x'`), /append-only/);
    assert.throws(() => db.run('DELETE FROM audit_log'), /append-only/);
    db.close();
  });
});

describe('verifyAuditChain', () => {
  it('accepts an empty and an intact chain', () => {
    const db = freshDb();
    assert.deepEqual(verifyAuditChain(db), { ok: true, count: 0 });
    seedChain(db, 5);
    assert.deepEqual(verifyAuditChain(db), { ok: true, count: 5 });
    db.close();
  });

  it('detects an altered row (content no longer matches its hash)', () => {
    const db = freshDb();
    seedChain(db, 5);
    withoutTriggers(db, () => db.run(`UPDATE audit_log SET after_json = '{"name":"Forged"}' WHERE id = 3`));
    assert.deepEqual(verifyAuditChain(db), { ok: false, brokenAtId: 3, count: 2, reason: 'hash_mismatch' });
    db.close();
  });

  it('detects a deleted row (next row no longer links)', () => {
    const db = freshDb();
    seedChain(db, 5);
    withoutTriggers(db, () => db.run('DELETE FROM audit_log WHERE id = 2'));
    assert.deepEqual(verifyAuditChain(db), { ok: false, brokenAtId: 3, count: 1, reason: 'prev_hash_mismatch' });
    db.close();
  });

  it('detects a re-hashed forgery that does not re-link the following rows', () => {
    const db = freshDb();
    seedChain(db, 4);
    withoutTriggers(db, () => {
      const r = db.get<Row & Record<string, unknown>>('SELECT * FROM audit_log WHERE id = 2');
      assert.ok(r);
      const forged = { ...r, after_json: '{"name":"Forged"}' };
      const hash = computeAuditHash(r.prev_hash, forged as never);
      db.run('UPDATE audit_log SET after_json = :a, hash = :h WHERE id = 2', { a: forged.after_json, h: hash });
    });
    const res = verifyAuditChain(db);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.brokenAtId, 3);
    db.close();
  });

  it('pages through long chains', () => {
    const db = freshDb();
    db.transaction(() => seedChain(db, 2500));
    assert.deepEqual(verifyAuditChain(db), { ok: true, count: 2500 });
    db.close();
  });
});

describe('sanitizeForAudit', () => {
  it('is pure and handles sets, dates and arrays', () => {
    const input = { a: new Set([1, 2]), d: new Date('2026-01-01T00:00:00Z'), list: [{ password: 'x', ok: true }] };
    assert.deepEqual(sanitizeForAudit(input), { a: [1, 2], d: '2026-01-01T00:00:00.000Z', list: [{ ok: true }] });
    assert.deepEqual(input.list[0], { password: 'x', ok: true }, 'input untouched');
  });
});

describe('storable text (regression: false tamper alarms)', () => {
  it('keeps the chain verifiable for lone surrogates, NUL and an emoji cut at the label limit', () => {
    const db = freshDb();
    const longLabel = 'x'.repeat(MAX_AUDIT_LABEL - 1) + '😀';
    appendAudit(db, { action: 'create', entityLabel: longLabel }, session, NOW);
    appendAudit(db, { action: 'create', entityLabel: 'bad \uD800 label', entityType: 'ty\uDC00pe' }, session, NOW);
    appendAudit(db, { action: 'create', entityLabel: 'a\u0000b' }, session, NOW);
    appendAudit(db, { action: 'create', entityId: 2 ** 53 + 2, entityLabel: 'unsafe id' }, session, NOW);
    appendAudit(db, { action: 'alter', before: { name: 'pair \uD83D' }, after: { name: 'nul \u0000' } }, session, NOW);
    assert.deepEqual(verifyAuditChain(db), { ok: true, count: 5 });
    const labels = db.all<{ entity_label: string; entity_id: number | null }>('SELECT entity_label, entity_id FROM audit_log ORDER BY id');
    assert.equal(labels[0].entity_label, 'x'.repeat(MAX_AUDIT_LABEL - 1), 'half a surrogate pair is dropped, not stored');
    assert.equal(labels[1].entity_label, 'bad \uFFFD label');
    assert.equal(labels[2].entity_label, 'a\uFFFDb', 'NUL no longer truncates the label');
    assert.equal(labels[3].entity_id, null, 'ids that cannot round-trip are not stored');
    db.close();
  });

  it('storableText is idempotent and leaves well-formed text alone', () => {
    assert.equal(storableText('₹ 1,234 — नमस्ते 😀'), '₹ 1,234 — नमस्ते 😀');
    assert.equal(storableText('ab😀', 3), 'ab');
    assert.equal(storableText('ab😀', 4), 'ab😀');
    const once = storableText('\uDC00x\uD800');
    assert.equal(once, '\uFFFDx\uFFFD');
    assert.equal(storableText(once), once);
  });
});

describe('secret stripping (regression: only exact key names were removed)', () => {
  it('drops string values under any password/secret/token-like key but keeps flags', () => {
    const out = sanitizeForAudit({
      vaultPassword: 'v-secret',
      apiToken: 'tok',
      smtp: { clientSecret: 's', host: 'mail' },
      einvoice: { api_key: 'k', username: 'gsp' },
      must_change_password: 1,
      passwordChanged: true,
      tokens: 3,
    });
    assert.deepEqual(out, {
      smtp: { host: 'mail' },
      einvoice: { username: 'gsp' },
      must_change_password: 1,
      passwordChanged: true,
      tokens: 3,
    });
  });
});
