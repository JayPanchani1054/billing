/**
 * Edit-log anchoring outside the company file (finding: an unkeyed, unanchored chain can be rewritten
 * or truncated undetectably by anyone with file access).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ApiResult } from '../../shared/api.ts';
import type { AppState, CreateCompanyInput } from '../../shared/types/app.ts';
import type { BackupCreateResult, BackupVerifyResult } from '../../shared/types/data.ts';
import type { AuditVerifyReport } from '../../shared/types/security.ts';
import { Db } from '../db/db.ts';
import { computeAuditHash, GENESIS_HASH, verifyAuditChain } from '../lib/audit.ts';
import { ANCHOR_MAC_PREFIX, anchorMacInput } from '../lib/auditAnchor.ts';
import { LEGACY_ANCHOR_MAC_PREFIX } from '../lib/legacyNames.ts';
import { companyRoutes } from '../modules/company/routes.ts';
import { readContainerInfo, writeContainer } from '../modules/data/container.ts';
import { dataRoutes } from '../modules/data/routes.ts';
import { securityRoutes } from '../modules/security/routes.ts';
import { makeGstin } from '../testing/fixtures.ts';
import { ANCHOR_KEY_FILE, ANCHORS_FILE, FileAuditAnchorStore } from './auditAnchors.ts';
import { fixedClock, type FixedClock } from './clock.ts';
import { appRoutes } from './routes.ts';
import type { Runtime } from './runtime.ts';
import { createRuntimeWithRoutes } from './runtime-core.ts';

let root: string;
let clock: FixedClock;
const runtimes: Runtime[] = [];

const makeRuntime = (): Runtime => {
  const rt = createRuntimeWithRoutes(
    { userDataDir: path.join(root, 'userData'), defaultDataDir: path.join(root, 'data'), appVersion: '1.0.0', clock, consoleLog: false },
    { ...appRoutes, ...companyRoutes, ...securityRoutes, ...dataRoutes },
  );
  runtimes.push(rt);
  return rt;
};
const call = async <T>(rt: Runtime, route: string, input: unknown = {}): Promise<T> => {
  const r: ApiResult<unknown> = await rt.dispatch(route, input);
  if (!r.ok) assert.fail(`${route}: ${r.error.code} ${r.error.message}`);
  return r.data as T;
};
const company: CreateCompanyInput = { name: 'Anchor Traders', stateCode: '27', gstRegistrationType: 'regular', gstin: makeGstin('27'), booksFrom: '2026-04-01' };

/** Some audited changes (F12 settings) so the log has a few entries. */
async function work(rt: Runtime, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await call(rt, 'company.config.save', { invoice: { terms: `Terms v${i}` } });
}

/** Rewrite the edit log as an attacker with file access would: triggers off, edit, re-hash from genesis. */
function rewriteLog(dbPath: string, edit: (db: Db) => void): void {
  const db = new Db(dbPath);
  try {
    db.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
    edit(db);
    let prev = GENESIS_HASH;
    for (const r of db.all<Parameters<typeof computeAuditHash>[1] & { id: number }>('SELECT * FROM audit_log ORDER BY id')) {
      const hash = computeAuditHash(prev, r);
      db.run('UPDATE audit_log SET prev_hash = :prev, hash = :hash WHERE id = :id', { prev, hash, id: r.id });
      prev = hash;
    }
    db.exec(`CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;`);
    assert.equal(verifyAuditChain(db).ok, true, 'the chain alone no longer shows anything');
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pevqori-anchor-'));
  clock = fixedClock('2026-10-05');
});
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

async function setup(): Promise<{ rt: Runtime; id: string; dbPath: string }> {
  const rt = makeRuntime();
  const s = await call<AppState>(rt, 'app.company.create', company);
  const id = s.companies[0].id;
  await work(rt, 4);
  await call(rt, 'app.company.close');
  return { rt, id, dbPath: path.join(root, 'data', 'companies', id, 'company.db') };
}

describe('edit-log anchor outside the company file', () => {
  it('an untouched log matches its check-point; the anchor file and key live in userData, not the data folder', async () => {
    const { rt, id } = await setup();
    await call(rt, 'app.company.open', { id });
    const v = await call<AuditVerifyReport>(rt, 'security.audit.verify');
    assert.equal(v.ok, true, v.message);
    assert.equal(v.anchor?.status, 'match');
    assert.match(v.detail, /matches the check-point/);
    assert.ok(fs.existsSync(path.join(root, 'userData', ANCHORS_FILE)));
    assert.ok(fs.existsSync(path.join(root, 'userData', ANCHOR_KEY_FILE)));
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'userData', ANCHOR_KEY_FILE)).mode & 0o077, 0, 'key readable by the owner only');
  });

  it('detects the newest entries cut off with the chain re-hashed (truncation)', async () => {
    const { rt, id, dbPath } = await setup();
    rewriteLog(dbPath, (db) => db.run('DELETE FROM audit_log WHERE id > (SELECT MAX(id) - 3 FROM audit_log)'));
    await call(rt, 'app.company.open', { id });
    const v = await call<AuditVerifyReport>(rt, 'security.audit.verify');
    assert.equal(v.ok, false);
    assert.equal(v.anchor?.status, 'mismatch');
    assert.match(v.message, /no longer matches the check-point/);
    assert.match(v.detail, /have been removed/);
    // Further work does not silently re-anchor the tampered log.
    await work(rt, 1);
    assert.equal((await call<AuditVerifyReport>(rt, 'security.audit.verify')).ok, false);
  });

  it('detects an entry rewritten with every hash recomputed from genesis', async () => {
    const { rt, id, dbPath } = await setup();
    rewriteLog(dbPath, (db) => db.run(`UPDATE audit_log SET username = 'someone-else' WHERE id = 2`));
    await call(rt, 'app.company.open', { id });
    const v = await call<AuditVerifyReport>(rt, 'security.audit.verify');
    assert.equal(v.ok, false);
    assert.match(v.detail, /have been rewritten/);
    assert.equal(v.anchor?.canReset, true, 'the (implicit) Owner may accept it');
  });

  it('an edited check-point is reported as invalid (HMAC)', async () => {
    const { rt, id } = await setup();
    const file = path.join(root, 'userData', ANCHORS_FILE);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.anchors[id].lastId -= 1;
    fs.writeFileSync(file, JSON.stringify(doc));
    const rt2 = makeRuntime(); // fresh process reads the edited file
    await rt.shutdown();
    await call(rt2, 'app.company.open', { id });
    const v = await call<AuditVerifyReport>(rt2, 'security.audit.verify');
    assert.equal(v.anchor?.status, 'invalid');
    assert.equal(v.ok, false);
  });

  it('an Owner can accept the current log as the new check-point (recorded in the log itself)', async () => {
    const { rt, id, dbPath } = await setup();
    rewriteLog(dbPath, (db) => db.run('DELETE FROM audit_log WHERE id = (SELECT MAX(id) FROM audit_log)'));
    await call(rt, 'app.company.open', { id });
    assert.equal((await call<AuditVerifyReport>(rt, 'security.audit.verify')).ok, false);
    await call(rt, 'security.audit.resetAnchor');
    const v = await call<AuditVerifyReport>(rt, 'security.audit.verify');
    assert.equal(v.ok, true, v.message);
    assert.equal(v.anchor?.status, 'match');
    const db = new Db(dbPath, { readOnly: true });
    try {
      assert.equal(db.value(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'audit_anchor'`), 1);
    } finally {
      db.close();
    }
    const again = await rt.dispatch('security.audit.resetAnchor', {});
    assert.equal(again.ok ? 'ok' : again.error.code, 'BUSINESS_RULE', 'nothing to reset when it matches');
  });

  it('restoring an older backup (Restore) is not reported as tampering', async () => {
    const { rt, id } = await setup();
    await call(rt, 'app.company.open', { id });
    const bk = await call<BackupCreateResult>(rt, 'data.backup.create', {});
    assert.ok(readContainerInfo(bk.path).manifest.auditHead?.mac, 'the backup carries a signed edit-log head');
    await work(rt, 3); // newer entries the backup does not have
    await call(rt, 'app.company.close');
    await call(rt, 'data.backup.restoreFromFile', { path: bk.path, mode: 'replace', replaceId: id });
    await call(rt, 'app.company.open', { id });
    const v = await call<AuditVerifyReport>(rt, 'security.audit.verify');
    assert.equal(v.ok, true, v.message);
  });

  it('a backup whose edit log was rewritten after it was made fails its check and is not restored', async () => {
    const { rt, id } = await setup();
    await call(rt, 'app.company.open', { id });
    const bk = await call<BackupCreateResult>(rt, 'data.backup.create', {});
    const good = await call<BackupVerifyResult>(rt, 'data.backup.verify', { path: bk.path });
    assert.equal(good.checks.find((c) => c.name === 'edit_log')?.ok, true);
    assert.match(good.checks.find((c) => c.name === 'edit_log')?.message ?? '', /matches the fingerprint/);
    // Re-pack the same data with a consistently rewritten log, keeping the signed head from the manifest.
    const snap = path.join(root, 'tampered.db');
    const live = new Db(path.join(root, 'data', 'companies', id, 'company.db'), { readOnly: true });
    live.run('VACUUM INTO ?', [snap]);
    live.close();
    rewriteLog(snap, (db) => db.run(`UPDATE audit_log SET username = 'nobody' WHERE id = 1`));
    const m = readContainerInfo(bk.path).manifest;
    const forged = path.join(path.dirname(bk.path), 'forged.pvqbak');
    await writeContainer({
      dbPath: snap,
      target: forged,
      manifest: {
        appVersion: m.appVersion,
        schemaVersion: m.schemaVersion,
        companyId: m.companyId,
        companyGuid: m.companyGuid,
        companyName: m.companyName,
        gstin: m.gstin,
        booksFrom: m.booksFrom,
        createdAt: m.createdAt,
        createdBy: m.createdBy,
        note: m.note,
        kind: m.kind,
        auditHead: m.auditHead,
      },
    });
    const v = await call<BackupVerifyResult>(rt, 'data.backup.verify', { path: forged });
    assert.equal(v.ok, false);
    assert.match(v.checks.find((c) => c.name === 'edit_log')?.message ?? '', /changed after the backup was made/);
    const r = await rt.dispatch('data.backup.restore', { path: forged, mode: 'new' });
    assert.equal(r.ok ? 'ok' : r.error.code, 'CONFLICT');
  });
});

describe('FileAuditAnchorStore', () => {
  it('signs with a per-installation key (optionally sealed by the OS); another installation cannot verify', () => {
    const dir = path.join(root, 'u1');
    const sealed: string[] = [];
    const sealer = {
      seal: (p: string) => {
        sealed.push(p);
        return `sealed:${Buffer.from(p).toString('base64')}`;
      },
      unseal: (s: string) => Buffer.from(s.replace(/^sealed:/, ''), 'base64').toString(),
    };
    const a = new FileAuditAnchorStore({ dir, log: () => undefined, sealer });
    const anchor = a.put({ companyId: 'c1', companyGuid: 'g', lastId: 5, lastHash: 'ab'.repeat(32) }, new Date('2026-10-05T00:00:00Z'));
    assert.equal(a.verify(anchor), true);
    assert.equal(a.verify({ ...anchor, lastId: 4 }), false);
    const keyDoc = JSON.parse(fs.readFileSync(path.join(dir, ANCHOR_KEY_FILE), 'utf8'));
    assert.equal(keyDoc.sealed, true);
    assert.equal(sealed.length, 1);
    assert.doesNotMatch(JSON.stringify(keyDoc), new RegExp(sealed[0]), 'the raw key is not on disk');
    // Same installation, new process: same key.
    const again = new FileAuditAnchorStore({ dir, log: () => undefined, sealer });
    assert.equal(again.verify(again.get('c1') as never), true);
    // Another installation (different key) cannot vouch for it.
    const other = new FileAuditAnchorStore({ dir: path.join(root, 'u2'), log: () => undefined });
    assert.equal(other.verify(anchor), false);
  });

  it('check-points recorded before the rename (other MAC prefix) still verify; new ones use the current prefix', () => {
    const key = Buffer.alloc(32, 7);
    const store = new FileAuditAnchorStore({ dir: path.join(root, 'u3'), log: () => undefined, key });
    const head = { companyId: 'c1', companyGuid: 'g', lastId: 9, lastHash: 'cd'.repeat(32), at: '2026-10-05T00:00:00.000Z' };
    const mac = (prefixLegacy: boolean): string => createHmac('sha256', key).update(anchorMacInput(head, prefixLegacy)).digest('hex');
    assert.ok(anchorMacInput(head).startsWith(`${ANCHOR_MAC_PREFIX}|`));
    assert.ok(anchorMacInput(head, true).startsWith(`${LEGACY_ANCHOR_MAC_PREFIX}|`));
    assert.equal(store.verify({ ...head, mac: mac(true) }), true, 'legacy check-point');
    assert.equal(store.verify({ ...head, mac: mac(false) }), true, 'current check-point');
    assert.equal(store.verify({ ...head, lastId: 8, mac: mac(true) }), false, 'an edited legacy check-point is still caught');
    const fresh = store.put({ companyId: 'c1', companyGuid: 'g', lastId: 9, lastHash: 'cd'.repeat(32) }, new Date(head.at));
    assert.equal(fresh.mac, mac(false), 'new check-points are signed with the current prefix');
  });
});
