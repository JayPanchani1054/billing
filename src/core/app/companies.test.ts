import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { CreateCompanyInput } from '../../shared/types/app.ts';
import { Db } from '../db/db.ts';
import { getSchemaVersion, migrate, SCHEMA_VERSION } from '../db/migrate.ts';
import { migrations } from '../db/migrations/index.ts';
import { seedCompany } from '../db/seed.ts';
import { AppError } from '../lib/errors.ts';
import { makeGstin } from '../testing/fixtures.ts';
import { fixedClock } from './clock.ts';
import { CompanyStore } from './companies.ts';
import { LOCK_FILE, LOCK_STALE_MS, removeStaleLock } from './lock.ts';

let dataDir: string;
const logs: Array<{ level: string; message: string }> = [];
const clock = fixedClock('2026-10-05');

const newStore = () => new CompanyStore({ dataDir, appVersion: '1.0.0', clock, log: (level, message) => logs.push({ level, message }) });

const input = (name: string, over: Partial<CreateCompanyInput> = {}): CreateCompanyInput => ({
  name,
  stateCode: '29',
  gstRegistrationType: 'regular',
  gstin: makeGstin('29'),
  booksFrom: '2025-04-01',
  ...over,
});

const isCode = (code: string, re?: RegExp) => (e: unknown) => e instanceof AppError && e.code === code && (!re || re.test(e.message));

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-store-'));
  logs.length = 0;
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('CompanyStore', () => {
  it('creates a company folder with a migrated, seeded database', () => {
    const store = newStore();
    const c = store.create(input('Sharma & Sons Pvt. Ltd.'));
    assert.match(c.id, /^sharma-sons-pvt-ltd-[0-9a-z]{6}$/);
    assert.ok(fs.existsSync(c.dbPath));
    assert.ok(fs.existsSync(c.attachmentsDir));
    assert.ok(fs.existsSync(store.backupsDir) && fs.existsSync(store.trashDir));
    const meta = store.readMeta(c.id);
    assert.equal(meta.name, 'Sharma & Sons Pvt. Ltd.');
    assert.equal(meta.schemaVersion, SCHEMA_VERSION);
    assert.equal(meta.securityEnabled, false);
  });

  it('removes the half-created folder when creation fails', () => {
    const store = newStore();
    assert.throws(() => store.create(input('Bad GSTIN', { gstin: makeGstin('27') })), isCode('VALIDATION'));
    assert.deepEqual(fs.readdirSync(store.companiesDir), []);
  });

  it('lists companies with registry info, newest first, skipping broken folders', () => {
    const store = newStore();
    const a = store.create(input('Alpha Traders'));
    const b = store.create(input('Beta Stores', { gstRegistrationType: 'unregistered', gstin: undefined, stateCode: '07' }));
    fs.mkdirSync(path.join(store.companiesDir, 'broken-folder'));
    fs.writeFileSync(path.join(store.companiesDir, 'broken-folder', 'company.db'), 'not a database');
    fs.mkdirSync(path.join(store.companiesDir, 'Not Valid!'));
    store.registry.touch(b.id, new Date('2026-10-01T00:00:00Z'));

    const list = store.list();
    assert.deepEqual(list.map((c) => c.name), ['Beta Stores', 'Alpha Traders']);
    const alpha = list.find((c) => c.id === a.id);
    assert.ok(alpha);
    assert.equal(alpha.gstin, makeGstin('29'));
    assert.equal(alpha.stateCode, '29');
    assert.equal(alpha.fyLabel, '2026-27', 'FY of today (5-Oct-2026)');
    assert.equal(alpha.needsUpgrade, false);
    assert.equal(alpha.lastOpenedAt, null);
    assert.ok(alpha.sizeBytes > 0);
    assert.equal(list[0].lastOpenedAt, '2026-10-01T00:00:00.000Z');
    assert.ok(logs.some((l) => l.message === 'Skipping unreadable company folder'));
  });

  it('opens with a lock file and releases it on close', () => {
    const store = newStore();
    const c = store.create(input('Gamma'));
    const opened = store.open(c.id);
    const lockPath = path.join(c.dir, LOCK_FILE);
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.hostname, os.hostname());
    assert.equal(lock.appVersion, '1.0.0');
    assert.equal(opened.db.value('SELECT name FROM company'), 'Gamma');
    // A second open in the same process is refused.
    assert.throws(() => newStore().open(c.id), isCode('LOCKED', /open in another Bahi ERP window/));
    // Listing still works while open (read-only connection).
    assert.equal(store.list().length, 1);
    store.close(opened);
    assert.equal(fs.existsSync(lockPath), false);
    store.close(store.open(c.id));
  });

  it('honours a lock held by another live process on this machine', () => {
    const store = newStore();
    const c = store.create(input('Delta'));
    const beat = new Date(clock.now().getTime() - 60_000).toISOString();
    const live = { pid: process.ppid, hostname: os.hostname(), startedAt: beat, heartbeatAt: beat };
    fs.writeFileSync(path.join(c.dir, LOCK_FILE), JSON.stringify(live));
    assert.throws(() => store.open(c.id), isCode('LOCKED', /another Bahi ERP window/));
  });

  it('takes over a lock whose pid was recycled by another program after a crash (regression)', () => {
    const store = newStore();
    const c = store.create(input('Delta Two'));
    // The pid is alive (it is our parent) but the holder stopped heartbeating long ago.
    const old = new Date(clock.now().getTime() - LOCK_STALE_MS - 1000).toISOString();
    fs.writeFileSync(path.join(c.dir, LOCK_FILE), JSON.stringify({ pid: process.ppid, hostname: os.hostname(), startedAt: old, heartbeatAt: old }));
    store.close(store.open(c.id));
  });

  it('treats an unparsable lock file as held while fresh (holder mid-write), stale once old', () => {
    const store = newStore();
    const c = store.create(input('Delta Three'));
    const lockPath = path.join(c.dir, LOCK_FILE);
    fs.writeFileSync(lockPath, '');
    assert.throws(() => store.open(c.id), isCode('LOCKED', /being opened right now/));
    const longAgo = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    fs.utimesSync(lockPath, longAgo, longAgo);
    store.close(store.open(c.id));
  });

  it('never deletes a fresh lock that replaced the stale one it evaluated (race regression)', () => {
    const store = newStore();
    const c = store.create(input('Delta Five'));
    const lockPath = path.join(c.dir, LOCK_FILE);
    const staleText = JSON.stringify({ pid: 1, hostname: 'OLD-PC', startedAt: 'x', heartbeatAt: '2020-01-01T00:00:00Z' });
    // Another opener already replaced the stale lock with its own fresh one.
    const freshText = JSON.stringify({ pid: 2, hostname: 'NEW-PC', startedAt: 'y', heartbeatAt: clock.now().toISOString() });
    fs.writeFileSync(lockPath, freshText);
    assert.equal(removeStaleLock(lockPath, staleText), false);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), freshText, 'fresh lock restored');
    assert.deepEqual(fs.readdirSync(c.dir).filter((f) => f.includes('.stale-')), []);
    assert.throws(() => store.open(c.id), isCode('LOCKED', /NEW-PC/));
    // The genuinely stale content is removed.
    fs.writeFileSync(lockPath, staleText);
    assert.equal(removeStaleLock(lockPath, staleText), true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(removeStaleLock(lockPath, staleText), true, 'already gone is fine');
  });

  it('writes heartbeats atomically and keeps them parseable', () => {
    const store = newStore();
    const c = store.create(input('Delta Four'));
    const opened = store.open(c.id);
    const later = new Date(clock.now().getTime() + 5 * 60_000);
    opened.lock.heartbeat(later);
    const lock = JSON.parse(fs.readFileSync(path.join(c.dir, LOCK_FILE), 'utf8'));
    assert.equal(lock.heartbeatAt, later.toISOString());
    assert.equal(lock.pid, process.pid);
    assert.deepEqual(fs.readdirSync(c.dir).filter((f) => f.includes('.tmp-')), [], 'no temp files left');
    store.close(opened);
  });

  it('takes over a stale lock left by a crashed process', () => {
    const store = newStore();
    const c = store.create(input('Epsilon'));
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(path.join(c.dir, LOCK_FILE), JSON.stringify({ pid: dead, hostname: os.hostname(), startedAt: 'x' }));
    const opened = store.open(c.id);
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir, LOCK_FILE), 'utf8')).pid, process.pid);
    store.close(opened);
  });

  it('honours a fresh lock from another computer but takes over a silent one', () => {
    const store = newStore();
    const c = store.create(input('Zeta'));
    const lockPath = path.join(c.dir, LOCK_FILE);
    const fresh = new Date(clock.now().getTime() - 60_000).toISOString();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, hostname: 'ACCOUNTS-PC-2', startedAt: fresh, heartbeatAt: fresh }));
    assert.throws(() => store.open(c.id), isCode('LOCKED', /ACCOUNTS-PC-2/));
    const old = new Date(clock.now().getTime() - LOCK_STALE_MS - 1000).toISOString();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, hostname: 'ACCOUNTS-PC-2', startedAt: old, heartbeatAt: old }));
    store.close(store.open(c.id));
  });

  it('refuses a database from a newer app version', () => {
    const store = newStore();
    const c = store.create(input('Eta'));
    const db = new Db(c.dbPath);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    db.close();
    assert.throws(() => store.open(c.id), isCode('CONFLICT', /newer version/));
    assert.equal(fs.existsSync(path.join(c.dir, LOCK_FILE)), false, 'no lock left behind');
    assert.equal(store.list()[0].needsUpgrade, false);
  });

  it('upgrades an older database after writing a safety copy', () => {
    const store = newStore();
    store.ensureLayout();
    const id = 'legacy-co-abc123';
    const dir = path.join(store.companiesDir, id);
    fs.mkdirSync(dir);
    const db = new Db(path.join(dir, 'company.db'));
    migrate(db, [migrations[0]]);
    seedCompany(db, input('Legacy Co'), { now: clock.now() });
    db.close();
    assert.equal(store.list()[0].needsUpgrade, SCHEMA_VERSION > 1);

    const opened = store.open(id);
    assert.equal(getSchemaVersion(opened.db), SCHEMA_VERSION);
    store.close(opened);
    if (SCHEMA_VERSION > 1) {
      const copies = fs.readdirSync(path.join(store.backupsDir, id));
      assert.equal(copies.length, 1);
      assert.match(copies[0], /^pre-upgrade-v1-.*\.db$/);
      const copy = new Db(path.join(store.backupsDir, id, copies[0]), { readOnly: true });
      assert.equal(getSchemaVersion(copy), 1);
      assert.equal(copy.value('SELECT name FROM company'), 'Legacy Co');
      copy.close();
    }
  });

  it('moves a company to the trash only with the exact name and when not open', () => {
    const store = newStore();
    const c = store.create(input('Theta Mart'));
    assert.throws(() => store.moveToTrash(c.id, 'theta mart'), isCode('VALIDATION'));
    const opened = store.open(c.id);
    assert.throws(() => store.moveToTrash(c.id, 'Theta Mart'), isCode('LOCKED'));
    store.close(opened);
    store.registry.touch(c.id, clock.now());
    const target = store.moveToTrash(c.id, '  Theta Mart ');
    assert.ok(fs.existsSync(path.join(target, 'company.db')), 'data preserved in trash');
    assert.equal(path.dirname(target), store.trashDir);
    assert.deepEqual(store.list(), []);
    assert.equal(store.registry.lastOpenedAt(c.id), null);
  });

  it('install() refuses newer-version files and companies open elsewhere, leaving everything untouched', () => {
    const store = newStore();
    const c = store.create(input('Iota'));
    const newer = path.join(dataDir, 'newer.db');
    const src = new Db(c.dbPath, { readOnly: true });
    src.run('VACUUM INTO ?', [newer]);
    src.close();
    const w = new Db(newer);
    w.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    w.close();
    assert.throws(() => store.install(newer), isCode('CONFLICT', /newer version/));

    const good = path.join(dataDir, 'good.db');
    const src2 = new Db(c.dbPath, { readOnly: true });
    src2.run('VACUUM INTO ?', [good]);
    src2.close();
    const opened = store.open(c.id);
    assert.throws(() => store.install(good, { replaceId: c.id }), isCode('LOCKED'));
    store.close(opened);
    assert.throws(() => store.install(good, { replaceId: 'no-such-company-1' }), isCode('NOT_FOUND'));
    assert.deepEqual(store.list().map((x) => x.id), [c.id]);
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.startsWith('.staging')), []);
    const installed = store.install(good);
    assert.equal(store.readMeta(installed.paths.id).name, 'Iota');
    assert.ok(fs.existsSync(installed.paths.attachmentsDir));
  });

  it('untrusted company files: a view or foreign trigger is refused before any query; lost audit triggers come back on open', () => {
    const store = newStore();
    const c = store.create(input('Kappa'));
    const shadow = store.create(input('Lambda'));
    const raw = new Db(shadow.dbPath);
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec('DROP TABLE company');
    raw.exec('CREATE VIEW company AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x AS id, x AS name FROM c');
    raw.close();
    // The list skips it (logged) instead of hanging; opening it is refused.
    assert.deepEqual(store.list().map((x) => x.id), [c.id]);
    assert.throws(() => store.open(shadow.id), isCode('CONFLICT', /unexpected database objects/));
    // A copy with an extra trigger cannot be installed (restore path).
    const evil = path.join(dataDir, 'evil.db');
    const src = new Db(c.dbPath);
    src.run('VACUUM INTO ?', [evil]);
    src.close();
    const w = new Db(evil);
    w.exec(`CREATE TRIGGER skim AFTER INSERT ON ledger_entries BEGIN UPDATE ledger_entries SET amount = 0 WHERE id = NEW.id; END`);
    w.close();
    assert.throws(() => store.install(evil), isCode('VALIDATION', /unexpected database objects/));
    // Dropped append-only triggers are restored when the company is opened.
    const d = new Db(c.dbPath);
    d.exec('DROP TRIGGER audit_log_no_delete');
    d.close();
    const opened = store.open(c.id);
    try {
      assert.equal(opened.db.value(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_log_no_delete'`), 1);
      assert.ok(logs.some((l) => /Edit log protection was missing/.test(l.message)));
    } finally {
      store.close(opened);
    }
  });

  it('sweeps plaintext leftovers of a crash (decrypted restores, snapshots, temp files) but nothing recent or in use', () => {
    const store = newStore();
    const c = store.create(input('Mu'));
    const past = new Date(clock.now().getTime() - 2 * 60 * 60_000);
    const make = (p: string, dir = false): string => {
      if (dir) {
        fs.mkdirSync(p, { recursive: true });
        fs.writeFileSync(path.join(p, 'company.db'), 'decrypted');
      } else fs.writeFileSync(p, 'x');
      return p;
    };
    const aged = (p: string): string => {
      fs.utimesSync(p, past, past);
      return p;
    };
    const oldRestore = aged(make(path.join(dataDir, '.restore-abc123'), true));
    const oldStaging = aged(make(path.join(dataDir, '.staging-def456'), true));
    const freshRestore = make(path.join(dataDir, '.restore-fresh1'), true);
    const oldSnap = aged(make(path.join(c.dir, '.backup-xyz789.db')));
    const oldTmp = aged(make(path.join(c.dir, 'registry.json.tmp-123-abcd')));
    fs.mkdirSync(path.join(dataDir, 'backups', c.id), { recursive: true });
    const oldPartial = aged(make(path.join(dataDir, 'backups', c.id, '.Mu_20261005-100000.bahibak.ab12cd.tmp')));
    const keepBackup = aged(make(path.join(dataDir, 'backups', c.id, 'Mu_20261005-100000.bahibak')));
    assert.equal(store.sweepTemporaryFiles(), 5);
    for (const p of [oldRestore, oldStaging, oldSnap, oldTmp, oldPartial]) assert.equal(fs.existsSync(p), false, p);
    for (const p of [freshRestore, keepBackup, c.dbPath]) assert.equal(fs.existsSync(p), true, p);
    // A company open elsewhere is left alone.
    const opened = store.open(c.id);
    try {
      const snap = aged(make(path.join(c.dir, '.backup-inuse1.db')));
      assert.equal(store.sweepTemporaryFiles(), 0);
      assert.ok(fs.existsSync(snap));
    } finally {
      store.close(opened);
    }
  });

  it('rejects ids that could escape the companies folder', () => {
    const store = newStore();
    for (const bad of ['../x', 'a/b', '..', '', 'A-UPPER', 'x\\y']) assert.throws(() => store.paths(bad), isCode('NOT_FOUND'), bad);
  });
});
