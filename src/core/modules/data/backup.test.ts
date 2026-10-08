import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { ApiResult } from '../../../shared/api.ts';
import type { CompanyListItem, CreateCompanyInput, OpenResult } from '../../../shared/types/app.ts';
import type { BackupCreateResult, BackupListResult, BackupRestoreResult, BackupVerifyResult } from '../../../shared/types/data.ts';
import { appRoutes } from '../../app/routes.ts';
import { fixedClock, type FixedClock } from '../../app/clock.ts';
import { createRuntimeWithRoutes } from '../../app/runtime-core.ts';
import type { Runtime } from '../../app/runtime.ts';
import { Db } from '../../db/db.ts';
import { SCHEMA_VERSION } from '../../db/migrate.ts';
import { verifyAuditChain } from '../../lib/audit.ts';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany, makeGstin, type TestCompany } from '../../testing/fixtures.ts';
import { companyRoutes } from '../company/routes.ts';
import { saveConfig } from '../company/service.ts';
import { autoBackup, createBackup, defaultBackupFolder, lastBackupAt, listBackups, verifyBackup } from './backup.ts';
import { BACKUP_MAGIC, readContainerInfo, writeContainer } from './container.ts';
import { dataRoutes } from './routes.ts';
import { securityRoutes } from '../security/routes.ts';

let t: TestCompany;
let dir: string;

beforeEach(() => {
  t = createTestCompany({ today: '2026-10-05', name: 'Shree Ganesh Traders' });
  t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', openingBalance: 1_234_50 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-bk-'));
});
afterEach(() => {
  t.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const PASSWORD = 'Backup@2026';

describe('backup: create and verify', () => {
  it('writes <Company Name>_<YYYYMMDD-HHmmss>.bahibak with the BAHIBAK1 magic and a manifest', async () => {
    const r = await createBackup(t.ctx, { folder: dir, note: 'Before GST filing' });
    assert.match(r.fileName, /^Shree Ganesh Traders_\d{8}-\d{6}\.bahibak$/);
    assert.equal(path.dirname(r.path), dir);
    const head = fs.readFileSync(r.path).subarray(0, 8).toString('ascii');
    assert.equal(head, BACKUP_MAGIC);
    const m = readContainerInfo(r.path).manifest;
    assert.equal(m.companyName, 'Shree Ganesh Traders');
    assert.equal(m.companyId, 'test-company');
    assert.equal(m.gstin, makeGstin('27'));
    assert.equal(m.schemaVersion, SCHEMA_VERSION);
    assert.equal(m.encrypted, false);
    assert.equal(m.compression, 'gzip');
    assert.equal(m.note, 'Before GST filing');
    assert.equal(m.kind, 'manual');
    assert.match(m.payloadSha256, /^[0-9a-f]{64}$/);
    assert.equal(r.encrypted, false);
    assert.equal(r.sizeBytes, fs.statSync(r.path).size);
  });

  it('records a backup_history row and a "backup" audit entry (chain stays valid)', async () => {
    const r = await createBackup(t.ctx, { folder: dir });
    assert.equal(t.db.value('SELECT COUNT(*) FROM backup_history'), 1);
    assert.equal(lastBackupAt(t.db), r.createdAt);
    const audit = t.db.get<{ entity_label: string; after_json: string }>(`SELECT entity_label, after_json FROM audit_log WHERE action = 'backup'`);
    assert.equal(audit?.entity_label, r.fileName);
    assert.equal(JSON.parse(audit?.after_json ?? '{}').encrypted, false);
    assert.equal(verifyAuditChain(t.db).ok, true);
  });

  it('round trip (plain): verify passes every check and the data is the company', async () => {
    const r = await createBackup(t.ctx, { folder: dir });
    const v = await verifyBackup(t.ctx.app.dataDir, r.path, undefined);
    assert.equal(v.ok, true, JSON.stringify(v.checks));
    assert.deepEqual(
      v.checks.map((c) => c.name),
      ['container', 'checksum', 'decompress', 'database_checksum', 'integrity', 'schema', 'company'],
    );
    assert.equal(v.companyName, 'Shree Ganesh Traders');
    assert.equal(v.supported, true);
    assert.ok((v.counts?.ledgers ?? 0) >= 6);
  });

  it('round trip (encrypted): needs the password; right password passes; wrong password fails', async () => {
    const r = await createBackup(t.ctx, { folder: dir, password: PASSWORD });
    assert.equal(r.encrypted, true);
    assert.equal(readContainerInfo(r.path).manifest.encrypted, true);
    const noPw = await verifyBackup(t.ctx.app.dataDir, r.path, undefined);
    assert.equal(noPw.ok, false);
    assert.equal(noPw.needsPassword, true);
    assert.equal(noPw.checks.find((c) => c.name === 'password')?.ok, null);
    const good = await verifyBackup(t.ctx.app.dataDir, r.path, PASSWORD);
    assert.equal(good.ok, true, JSON.stringify(good.checks));
    assert.equal(good.checks.find((c) => c.name === 'password')?.ok, true);
    const bad = await verifyBackup(t.ctx.app.dataDir, r.path, 'Wrong@2026');
    assert.equal(bad.ok, false);
    const pw = bad.checks.find((c) => c.name === 'password');
    assert.equal(pw?.ok, false);
    assert.match(pw?.message ?? '', /Wrong password/);
  });

  it('a password shorter than 8 characters is refused', async () => {
    await assert.rejects(createBackup(t.ctx, { folder: dir, password: 'short' }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
  });

  it('a relative folder is refused (paths come from a folder dialog)', async () => {
    await assert.rejects(createBackup(t.ctx, { folder: 'backups' }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
  });

  it('defaults to <data folder>/backups/<company id>, or the F12 folder', async () => {
    assert.equal(defaultBackupFolder(t.ctx), path.join(t.ctx.app.dataDir, 'backups', 'test-company'));
    t.db.transaction(() => saveConfig(t.ctx, { backup: { folder: dir } }));
    assert.equal(defaultBackupFolder(t.ctx), dir);
    const r = await createBackup(t.ctx, {});
    assert.equal(r.folder, dir);
  });
});

describe('backup: damaged and foreign files', () => {
  it('a changed byte in the payload fails the checksum (tampered plain backup)', async () => {
    const r = await createBackup(t.ctx, { folder: dir });
    const buf = fs.readFileSync(r.path);
    buf[buf.length - 10] ^= 0xff;
    fs.writeFileSync(r.path, buf);
    const v = await verifyBackup(t.ctx.app.dataDir, r.path, undefined);
    assert.equal(v.ok, false);
    assert.equal(v.checks.find((c) => c.name === 'checksum')?.ok, false);
  });

  it('tampering with an encrypted payload is caught by AES-GCM even when the checksum is forged', async () => {
    const r = await createBackup(t.ctx, { folder: dir, password: PASSWORD });
    const info = readContainerInfo(r.path);
    const buf = fs.readFileSync(r.path);
    buf[buf.length - 5] ^= 0x01;
    // Forge the manifest checksum so only the cipher can notice.
    const { createHash } = await import('node:crypto');
    const forged = { ...info.manifest, payloadSha256: createHash('sha256').update(buf.subarray(info.payloadOffset)).digest('hex') };
    const json = Buffer.from(JSON.stringify(forged));
    buf.fill(0x20, 12, info.payloadOffset);
    json.copy(buf, 12);
    fs.writeFileSync(r.path, buf);
    const v = await verifyBackup(t.ctx.app.dataDir, r.path, PASSWORD);
    assert.equal(v.checks.find((c) => c.name === 'checksum')?.ok, true);
    assert.equal(v.checks.find((c) => c.name === 'password')?.ok, false);
    assert.equal(v.ok, false);
  });

  it('a truncated file is reported as incomplete', async () => {
    const r = await createBackup(t.ctx, { folder: dir });
    const buf = fs.readFileSync(r.path);
    fs.writeFileSync(r.path, buf.subarray(0, buf.length - 100));
    const v = await verifyBackup(t.ctx.app.dataDir, r.path, undefined);
    assert.equal(v.ok, false);
    assert.match(v.checks[0].message, /incomplete|damaged/);
  });

  it('a file that is not a backup is refused clearly', async () => {
    const p = path.join(dir, 'notes.bahibak');
    fs.writeFileSync(p, 'hello world, not a backup');
    const v = await verifyBackup(t.ctx.app.dataDir, p, undefined);
    assert.equal(v.ok, false);
    assert.match(v.checks[0].message, /not a Bahi ERP backup/);
  });

  it('a backup from a newer app (schema) is reported unsupported', async () => {
    // Snapshot this company, raise its schema version and pack it as a newer app would.
    const snap = path.join(dir, 'newer.db');
    t.db.run('VACUUM INTO ?', [snap]);
    const raw = new DatabaseSync(snap);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 10}`);
    raw.close();
    const target = path.join(dir, 'Newer_20261005-100000.bahibak');
    await writeContainer({
      dbPath: snap,
      target,
      manifest: {
        appVersion: '9.0.0',
        schemaVersion: SCHEMA_VERSION + 10,
        companyId: 'test-company',
        companyGuid: 'x',
        companyName: 'Newer',
        gstin: null,
        booksFrom: '2026-04-01',
        createdAt: '2026-10-05T04:30:00.000Z',
        createdBy: null,
        note: null,
        kind: 'manual',
      },
    });
    const v = await verifyBackup(t.ctx.app.dataDir, target, undefined);
    assert.equal(v.ok, false);
    assert.equal(v.supported, false);
    const schema = v.checks.find((c) => c.name === 'schema');
    assert.equal(schema?.ok, false);
    assert.match(schema?.message ?? '', /newer version of Bahi ERP/);
  });

  it('a backup container format from the future is refused (CONFLICT)', async () => {
    const r = await createBackup(t.ctx, { folder: dir });
    const info = readContainerInfo(r.path);
    const buf = fs.readFileSync(r.path);
    const json = Buffer.from(JSON.stringify({ ...info.manifest, formatVersion: 2 }));
    buf.fill(0x20, 12, info.payloadOffset);
    json.copy(buf, 12);
    fs.writeFileSync(r.path, buf);
    assert.throws(() => readContainerInfo(r.path), (e: unknown) => e instanceof AppError && e.code === 'CONFLICT' && /newer version/.test(e.message));
  });
});

describe('backup: list, retention and automatic backups', () => {
  it('lists newest first, marks this company and flags unreadable files', async () => {
    const a = await createBackup(t.ctx, { folder: dir });
    t.clock.advance(60_000);
    const b = await createBackup(t.ctx, { folder: dir });
    fs.writeFileSync(path.join(dir, 'broken.bahibak'), 'junk');
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'ignored');
    const list: BackupListResult = listBackups(t.ctx, dir);
    assert.equal(list.folder, dir);
    const good = list.backups.filter((x) => x.manifest);
    assert.deepEqual(
      good.map((x) => x.fileName),
      [b.fileName, a.fileName],
    );
    assert.ok(good.every((x) => x.isCurrentCompany));
    const broken = list.backups.find((x) => x.fileName === 'broken.bahibak');
    assert.ok(broken?.problem);
    assert.equal(list.backups.some((x) => x.fileName === 'readme.txt'), false);
    assert.equal(list.lastBackupAt, b.createdAt);
  });

  it('"keep last N" removes only this company\'s oldest backups', async () => {
    t.db.transaction(() => saveConfig(t.ctx, { backup: { keepLast: 2 } }));
    // Another company's backup in the same folder must survive.
    const other = createTestCompany({ today: '2026-10-05', name: 'Other Co' });
    const foreign = await createBackup(other.ctx, { folder: dir });
    other.close();
    const made: BackupCreateResult[] = [];
    for (let i = 0; i < 3; i++) {
      made.push(await createBackup(t.ctx, { folder: dir }));
      t.clock.advance(1000);
    }
    assert.deepEqual(made[2].removed, [made[0].fileName]);
    assert.equal(fs.existsSync(made[0].path), false);
    assert.equal(fs.existsSync(made[1].path), true);
    assert.equal(fs.existsSync(made[2].path), true);
    assert.equal(fs.existsSync(foreign.path), true);
  });

  it('a new backup that cannot be read back keeps every older backup (retention never runs)', async () => {
    t.db.transaction(() => saveConfig(t.ctx, { backup: { keepLast: 1 } }));
    const first = await createBackup(t.ctx, { folder: dir });
    t.clock.advance(60_000);
    // Simulate a drive that corrupts what is written: flip the last byte of every file renamed into place.
    const realRename = fs.renameSync;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
      realRename(from, to);
      const buf = fs.readFileSync(to);
      buf[buf.length - 1] ^= 0xff;
      fs.writeFileSync(to, buf);
    };
    try {
      await assert.rejects(createBackup(t.ctx, { folder: dir }), (e: unknown) => e instanceof AppError && /could not be read back/.test(e.message) && /Older backups were kept/.test(e.message));
    } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
    }
    assert.ok(fs.existsSync(first.path), 'the older good backup is still there');
  });

  it('auto backup runs when on and the last backup is over 24 hours old', async () => {
    t.db.transaction(() => saveConfig(t.ctx, { backup: { folder: dir, auto: true } }));
    const first = await autoBackup(t.ctx);
    assert.equal(first.ran, true);
    assert.equal(first.reason, 'created');
    assert.equal(readContainerInfo(first.backup?.path ?? '').manifest.kind, 'auto');
    t.clock.advance(23 * 3600_000);
    const recent = await autoBackup(t.ctx);
    assert.deepEqual([recent.ran, recent.reason], [false, 'recent']);
    t.clock.advance(2 * 3600_000); // 25 h after the first
    const again = await autoBackup(t.ctx);
    assert.deepEqual([again.ran, again.reason], [true, 'created']);
  });

  it('auto backup does nothing when switched off in F12', async () => {
    t.db.transaction(() => saveConfig(t.ctx, { backup: { folder: dir, auto: false } }));
    const r = await autoBackup(t.ctx);
    assert.deepEqual([r.ran, r.reason], [false, 'disabled']);
    assert.equal(fs.readdirSync(dir).length, 0);
  });

  it('auto backup reports a failure instead of throwing (folder not writable)', async () => {
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, 'x');
    t.db.transaction(() => saveConfig(t.ctx, { backup: { folder: path.join(file, 'sub'), auto: true } }));
    const r = await autoBackup(t.ctx);
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'failed');
    assert.ok(r.error);
  });
});

describe('backup routes: permissions', () => {
  it('data.backup.create needs the data.backup permission', async () => {
    const r = await t.call(dataRoutes, 'data.backup.create', { folder: dir }, { session: t.sessionAs({ permissions: ['vouchers.view'] }) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'FORBIDDEN');
  });

  it('data.backup.create runs through the dispatcher (async, non-transactional)', async () => {
    const r = await t.callOk<BackupCreateResult>(dataRoutes, 'data.backup.create', { folder: dir });
    assert.ok(fs.existsSync(r.path));
    const v = await t.callOk<BackupVerifyResult>(dataRoutes, 'data.backup.verify', { path: r.path });
    assert.equal(v.ok, true);
  });
});

// ───────────────────────────── Restore through the app runtime ─────────────────────────────

describe('restore (app runtime)', () => {
  let root: string;
  let clock: FixedClock;
  let rt: Runtime;

  const call = async <T>(route: string, input: unknown = {}): Promise<T> => {
    const r: ApiResult<unknown> = await rt.dispatch(route, input);
    if (!r.ok) throw new AppError(r.error.code, r.error.message, r.error.details);
    return r.data as T;
  };
  const fails = async (route: string, input: unknown, code: string, re?: RegExp): Promise<void> => {
    const r = await rt.dispatch(route, input);
    assert.equal(r.ok, false, `${route} should fail`);
    if (!r.ok) {
      assert.equal(r.error.code, code, r.error.message);
      if (re) assert.match(r.error.message, re);
    }
  };
  const company = (name: string): CreateCompanyInput => ({ name, stateCode: '27', gstRegistrationType: 'regular', gstin: makeGstin('27'), booksFrom: '2026-04-01' });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-restore-'));
    clock = fixedClock('2026-10-05');
    rt = createRuntimeWithRoutes(
      { userDataDir: path.join(root, 'userData'), defaultDataDir: path.join(root, 'data'), appVersion: '1.2.3', clock, consoleLog: false },
      { ...appRoutes, ...companyRoutes, ...dataRoutes, ...securityRoutes },
    );
  });
  afterEach(async () => {
    await rt.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function backupOf(name: string, password?: string): Promise<{ id: string; backup: BackupCreateResult }> {
    const opened = await call<OpenResult>('app.company.create', company(name));
    const id = opened.company?.id;
    assert.ok(id);
    const backup = await call<BackupCreateResult>('data.backup.create', { folder: path.join(root, 'bk'), password });
    return { id: id as string, backup };
  }

  it('restores a backup as a new company from the Company Select screen, with a "restore" audit entry', async () => {
    const { backup } = await backupOf('Alpha Traders', PASSWORD);
    await call('app.company.close');
    const res = await call<BackupRestoreResult>('data.backup.restoreFromFile', { path: backup.path, password: PASSWORD, mode: 'new' });
    assert.equal(res.company.name, 'Alpha Traders');
    assert.equal(res.replacedTo, null);
    const list = await call<CompanyListItem[]>('app.company.list');
    assert.equal(list.length, 2);
    const db = new Db(path.join(root, 'data', 'companies', res.company.id, 'company.db'), { readOnly: true });
    try {
      const restore = db.get<{ entity_label: string }>(`SELECT entity_label FROM audit_log WHERE action = 'restore'`);
      assert.equal(restore?.entity_label, 'Alpha Traders');
      assert.equal(verifyAuditChain(db).ok, true);
    } finally {
      db.close();
    }
  });

  it('a wrong password restores nothing', async () => {
    const { backup } = await backupOf('Beta Traders', PASSWORD);
    await call('app.company.close');
    await fails('data.backup.restoreFromFile', { path: backup.path, password: 'Nope12345', mode: 'new' }, 'VALIDATION', /Wrong password/);
    assert.equal((await call<CompanyListItem[]>('app.company.list')).length, 1);
  });

  it('restoreFromFile is refused while a company is open', async () => {
    const { backup } = await backupOf('Gamma Traders');
    await fails('data.backup.restoreFromFile', { path: backup.path, mode: 'new' }, 'CONFLICT', /Close the company/);
  });

  it('replacing the open company is refused with a clear message', async () => {
    const { id, backup } = await backupOf('Delta Traders');
    await fails('data.backup.restore', { path: backup.path, mode: 'replace', replaceId: id }, 'CONFLICT', /is open/);
  });

  it('replaces a closed company: the old folder goes to the trash and the backup data comes back', async () => {
    const { id, backup } = await backupOf('Epsilon Traders');
    await call('app.company.close');
    const res = await call<BackupRestoreResult>('data.backup.restoreFromFile', { path: backup.path, mode: 'replace', replaceId: id });
    assert.equal(res.company.id, id);
    assert.ok(res.replacedTo && fs.existsSync(res.replacedTo));
    assert.equal((await call<CompanyListItem[]>('app.company.list')).length, 1);
  });

  it('a backup of another company cannot replace this one', async () => {
    const a = await backupOf('Zeta Traders');
    await call('app.company.close');
    const b = await backupOf('Eta Traders');
    await call('app.company.close');
    await fails('data.backup.restoreFromFile', { path: a.backup.path, mode: 'replace', replaceId: b.id }, 'CONFLICT', /belongs to "Zeta Traders"/);
  });

  it('a forged manifest (company id copied from the target) is caught by the data inside; the target stays', async () => {
    const a = await backupOf('Theta Traders');
    await call('app.company.close');
    const b = await backupOf('Iota Traders');
    await call('app.company.close');
    // Rewrite A's plain-JSON manifest to claim it is B (same length area, still valid JSON).
    const info = readContainerInfo(a.backup.path);
    const bGuid = readContainerInfo(b.backup.path).manifest.companyGuid;
    const forged = Buffer.from(JSON.stringify({ ...info.manifest, companyGuid: bGuid, companyName: 'Iota Traders' }), 'utf8');
    const fd = fs.openSync(a.backup.path, 'r+');
    try {
      const area = Buffer.alloc(info.payloadOffset - 12, 0x20);
      forged.copy(area);
      fs.writeSync(fd, area, 0, area.length, 12);
    } finally {
      fs.closeSync(fd);
    }
    await fails('data.backup.restoreFromFile', { path: a.backup.path, mode: 'replace', replaceId: b.id }, 'CONFLICT', /belongs to "Theta Traders"/);
    const list = await call<CompanyListItem[]>('app.company.list');
    assert.equal(list.find((c) => c.id === b.id)?.name, 'Iota Traders', 'the company being replaced is untouched');
    assert.equal(list.length, 2);
  });

  it('replacing a password-protected company needs its owner password (wrong tries refused)', async () => {
    const { id, backup } = await backupOf('Kappa Traders');
    await call('security.enable', { username: 'owner', password: 'Owner@2026' });
    await call('app.company.close');
    await fails('data.backup.restoreFromFile', { path: backup.path, mode: 'replace', replaceId: id }, 'VALIDATION', /owner password/);
    await fails('data.backup.restoreFromFile', { path: backup.path, mode: 'replace', replaceId: id, ownerPassword: 'Wrong@2026' }, 'UNAUTHENTICATED', /incorrect/);
    const res = await call<BackupRestoreResult>('data.backup.restoreFromFile', { path: backup.path, mode: 'replace', replaceId: id, ownerUsername: 'owner', ownerPassword: 'Owner@2026' });
    assert.equal(res.company.id, id);
    assert.ok(res.replacedTo);
  });
});
