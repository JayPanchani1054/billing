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
import { autoBackup, BACKUP_PAGES_PER_STEP, createBackup, defaultBackupFolder, lastBackupAt, listBackups, verifyBackup } from './backup.ts';
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
    const v = await verifyBackup(t.ctx, r.path, undefined);
    assert.equal(v.ok, true, JSON.stringify(v.checks));
    assert.deepEqual(
      v.checks.map((c) => c.name),
      ['container', 'checksum', 'decompress', 'database_checksum', 'integrity', 'schema', 'company', 'edit_log'],
    );
    assert.equal(v.companyName, 'Shree Ganesh Traders');
    assert.equal(v.supported, true);
    assert.ok((v.counts?.ledgers ?? 0) >= 6);
  });

  it('round trip (encrypted): needs the password; right password passes; wrong password fails', async () => {
    const r = await createBackup(t.ctx, { folder: dir, password: PASSWORD });
    assert.equal(r.encrypted, true);
    assert.equal(readContainerInfo(r.path).manifest.encrypted, true);
    const noPw = await verifyBackup(t.ctx, r.path, undefined);
    assert.equal(noPw.ok, false);
    assert.equal(noPw.needsPassword, true);
    assert.equal(noPw.checks.find((c) => c.name === 'password')?.ok, null);
    const good = await verifyBackup(t.ctx, r.path, PASSWORD);
    assert.equal(good.ok, true, JSON.stringify(good.checks));
    assert.equal(good.checks.find((c) => c.name === 'password')?.ok, true);
    const bad = await verifyBackup(t.ctx, r.path, 'Wrong@2026');
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
    const v = await verifyBackup(t.ctx, r.path, undefined);
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
    const v = await verifyBackup(t.ctx, r.path, PASSWORD);
    assert.equal(v.checks.find((c) => c.name === 'checksum')?.ok, true);
    assert.equal(v.checks.find((c) => c.name === 'password')?.ok, false);
    assert.equal(v.ok, false);
  });

  it('a truncated file is reported as incomplete', async () => {
    const r = await createBackup(t.ctx, { folder: dir });
    const buf = fs.readFileSync(r.path);
    fs.writeFileSync(r.path, buf.subarray(0, buf.length - 100));
    const v = await verifyBackup(t.ctx, r.path, undefined);
    assert.equal(v.ok, false);
    assert.match(v.checks[0].message, /incomplete|damaged/);
  });

  it('a file that is not a backup is refused clearly', async () => {
    const p = path.join(dir, 'notes.bahibak');
    fs.writeFileSync(p, 'hello world, not a backup');
    const v = await verifyBackup(t.ctx, p, undefined);
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
    const v = await verifyBackup(t.ctx, target, undefined);
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

  it("auto backup on open skips a brand-new company (reason 'new') but backs it up on close", async () => {
    t.db.transaction(() => saveConfig(t.ctx, { backup: { folder: dir, auto: true } }));
    const onOpen = await autoBackup(t.ctx, { trigger: 'open' });
    assert.deepEqual([onOpen.ran, onOpen.reason], [false, 'new']);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.bahibak')).length, 0);
    const onClose = await autoBackup(t.ctx, { trigger: 'close' });
    assert.deepEqual([onClose.ran, onClose.reason], [true, 'created']);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.bahibak')).length, 1);
  });

  it('auto backup on open catches up on a company over a day old that was never backed up', async () => {
    t.db.transaction(() => saveConfig(t.ctx, { backup: { folder: dir, auto: true } }));
    t.clock.advance(25 * 3600_000); // the company was created 25 hours ago
    const r = await autoBackup(t.ctx, { trigger: 'open' });
    assert.deepEqual([r.ran, r.reason], [true, 'created']);
  });

  it("'data.backup.auto' route takes the trigger and runs for any logged-in user (company policy)", async () => {
    t.db.transaction(() => saveConfig(t.ctx, { backup: { folder: dir, auto: true } }));
    const clerk = t.sessionAs({ permissions: ['vouchers.view'] });
    const opened = await t.call(dataRoutes, 'data.backup.auto', { trigger: 'open' }, { session: clerk });
    assert.ok(opened.ok);
    if (opened.ok) assert.equal((opened.data as { reason: string }).reason, 'new');
    const closed = await t.call(dataRoutes, 'data.backup.auto', { trigger: 'close' }, { session: clerk });
    assert.ok(closed.ok);
    if (closed.ok) assert.equal((closed.data as { ran: boolean }).ran, true);
    const bad = await t.call(dataRoutes, 'data.backup.auto', { trigger: 'later' });
    assert.equal(bad.ok, false);
  });

  it('overlapping automatic backups (open catch-up, close, shutdown step) share one run: one file', async () => {
    t.db.transaction(() => saveConfig(t.ctx, { backup: { folder: dir, auto: true } }));
    t.clock.advance(25 * 3600_000);
    const [a, b, c] = await Promise.all([autoBackup(t.ctx, { trigger: 'open' }), autoBackup(t.ctx, { trigger: 'close' }), autoBackup(t.ctx, { trigger: 'close' })]);
    assert.deepEqual([a.ran, b.ran, c.ran], [true, true, true]);
    assert.equal(a.backup?.path, b.backup?.path);
    assert.equal(a.backup?.path, c.backup?.path);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.bahibak')).length, 1);
    // Once finished, the next call decides afresh (backed up just now → 'recent').
    const later = await autoBackup(t.ctx, { trigger: 'close' });
    assert.deepEqual([later.ran, later.reason], [false, 'recent']);
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
    // The wrong guess counts against the company's own lockout and is in ITS edit log.
    const target = new Db(path.join(root, 'data', 'companies', id, 'company.db'), { readOnly: true });
    try {
      assert.equal(target.value(`SELECT failed_attempts FROM users WHERE username = 'owner'`), 1);
      assert.equal(JSON.parse(target.value<string>(`SELECT after_json FROM audit_log WHERE action = 'login_failed' ORDER BY id DESC LIMIT 1`) ?? '{}').context, 'restore.replace');
    } finally {
      target.close();
    }
    const res = await call<BackupRestoreResult>('data.backup.restoreFromFile', { path: backup.path, mode: 'replace', replaceId: id, ownerUsername: 'owner', ownerPassword: 'Owner@2026' });
    assert.equal(res.company.id, id);
    assert.ok(res.replacedTo);
  });
});

// ───────────────────────────── Renderer paths need a dialog choice (§8) ─────────────────────────────

describe('backup paths: only what the user picked in a dialog (main’s authorizePath)', () => {
  let root: string;
  let rt: Runtime;
  const chosenFolders = new Set<string>();
  const chosenFiles = new Set<string>();
  const inside = (p: string) => [...chosenFolders].some((f) => p === f || p.startsWith(f + path.sep));

  const call = async <T>(route: string, input: unknown = {}): Promise<T> => {
    const r: ApiResult<unknown> = await rt.dispatch(route, input);
    if (!r.ok) throw new AppError(r.error.code, r.error.message, r.error.details);
    return r.data as T;
  };
  const code = async (route: string, input: unknown): Promise<string | null> => {
    const r = await rt.dispatch(route, input);
    return r.ok ? null : r.error.code;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-paths-'));
    chosenFolders.clear();
    chosenFiles.clear();
    rt = createRuntimeWithRoutes(
      {
        userDataDir: path.join(root, 'userData'),
        defaultDataDir: path.join(root, 'data'),
        appVersion: '1.2.3',
        clock: fixedClock('2026-10-05'),
        consoleLog: false,
        authorizePath: (p, use) => (use === 'read-file' && chosenFiles.has(p)) || inside(p),
      },
      { ...appRoutes, ...companyRoutes, ...dataRoutes },
    );
  });
  afterEach(async () => {
    await rt.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses backup folders, backup files and F12 folders the user did not choose (FORBIDDEN, nothing written)', async () => {
    await call('app.company.create', { name: 'Path Co', stateCode: '27', gstRegistrationType: 'regular', gstin: makeGstin('27'), booksFrom: '2026-04-01' });
    const attacker = path.join(root, 'attacker-share');
    fs.mkdirSync(attacker);
    assert.equal(await code('data.backup.create', { folder: attacker }), 'FORBIDDEN');
    assert.deepEqual(fs.readdirSync(attacker), [], 'no copy of the books was written');
    assert.equal(await code('data.backup.list', { folder: attacker }), 'FORBIDDEN');
    assert.equal(await code('company.config.save', { backup: { folder: attacker } }), 'FORBIDDEN');

    // The default folder (inside the data folder) needs no dialog; neither do its files.
    const own = await call<BackupCreateResult>('data.backup.create', {});
    assert.equal((await call<BackupVerifyResult>('data.backup.verify', { path: own.path })).ok, true);

    // A folder picked in the dialog works for backups, listing and F12; files in it can be checked.
    const picked = path.join(root, 'picked');
    fs.mkdirSync(picked);
    chosenFolders.add(picked);
    const made = await call<BackupCreateResult>('data.backup.create', { folder: picked });
    assert.equal((await call<BackupListResult>('data.backup.list', { folder: picked })).backups.length, 1);
    await call('company.config.save', { backup: { folder: picked } });
    // Once saved in F12 the folder is trusted for this company even in a later session (new dialog set).
    chosenFolders.clear();
    assert.equal((await call<BackupVerifyResult>('data.backup.verify', { path: made.path })).ok, true);
    assert.equal((await call<BackupListResult>('data.backup.list', {})).folder, picked);

    // No company open (public routes): only dialog-chosen files or files in the data folder.
    await call('app.company.close');
    const copy = path.join(attacker, 'copy.bahibak');
    fs.copyFileSync(made.path, copy);
    assert.equal(await code('data.backup.inspectFile', { path: copy }), 'FORBIDDEN');
    assert.equal(await code('data.backup.verifyFile', { path: copy }), 'FORBIDDEN');
    assert.equal(await code('data.backup.restoreFromFile', { path: copy, mode: 'new' }), 'FORBIDDEN');
    assert.equal(await code('data.backup.verifyFile', { path: made.path }), 'FORBIDDEN', 'the F12 folder is trusted only inside its company');
    assert.equal((await call<CompanyListItem[]>('app.company.list')).length, 1, 'nothing restored');
    chosenFiles.add(copy);
    assert.equal((await call<BackupVerifyResult>('data.backup.verifyFile', { path: copy })).ok, true);
    assert.equal((await call<BackupVerifyResult>('data.backup.verifyFile', { path: own.path })).ok, true, 'data folder');
  });

  it('a restored backup cannot bring its own F12 backup folder: cleared unless this installation vouches for it', async () => {
    type Cfg = { backup: { folder: string | null } };
    const opened = await call<OpenResult>('app.company.create', { name: 'Leak Co', stateCode: '27', gstRegistrationType: 'regular', gstin: makeGstin('27'), booksFrom: '2026-04-01' });
    const sourceId = opened.company?.id as string;
    // A backup whose F12 folder is somewhere the restoring user never chose (in real life: a crafted
    // file naming \\attacker\share — automatic backups after every login would then copy the books there).
    const attacker = path.join(root, 'attacker-share');
    fs.mkdirSync(attacker);
    chosenFolders.add(attacker);
    await call('company.config.save', { backup: { folder: attacker } });
    const crafted = await call<BackupCreateResult>('data.backup.create', { folder: path.join(root, 'data', 'backups', 'outbox') });
    // A second backup, kept in a folder the user picked and configured.
    const picked = path.join(root, 'picked');
    fs.mkdirSync(picked);
    chosenFolders.add(picked);
    await call('company.config.save', { backup: { folder: picked } });
    const own = await call<BackupCreateResult>('data.backup.create', {});
    assert.equal(path.dirname(own.path), picked);
    const ownElsewhere = await call<BackupCreateResult>('data.backup.create', { folder: path.join(root, 'data', 'backups', 'outbox2') });
    await call('app.company.close');
    chosenFolders.clear(); // a later session: nothing picked yet

    const restoredFolder = async (backupPath: string): Promise<{ folder: string | null; notKept: unknown }> => {
      const res = await call<BackupRestoreResult>('data.backup.restoreFromFile', { path: backupPath, mode: 'new' });
      const db = new Db(path.join(root, 'data', 'companies', res.company.id, 'company.db'), { readOnly: true });
      try {
        const cfg = JSON.parse(db.value<string>(`SELECT value FROM settings WHERE key = 'config'`) ?? '{}') as Cfg;
        const entry = db.get<{ after_json: string }>(`SELECT after_json FROM audit_log WHERE action = 'restore' ORDER BY id DESC LIMIT 1`);
        assert.equal(verifyAuditChain(db).ok, true);
        return { folder: cfg.backup.folder, notKept: (JSON.parse(entry?.after_json ?? '{}') as { backupFolderNotKept?: unknown }).backupFolderNotKept };
      } finally {
        db.close();
      }
    };

    // Not vouched for: cleared, and the edit log says which folder was dropped.
    const r1 = await restoredFolder(crafted.path);
    assert.equal(r1.folder, null);
    assert.equal(r1.notKept, attacker);
    // Restored from inside its own configured folder (picked in the file dialog): kept.
    chosenFiles.add(own.path);
    const r2 = await restoredFolder(own.path);
    assert.equal(r2.folder, picked);
    assert.equal(r2.notKept, undefined);
    // A folder picked in the dialog this session is kept too.
    chosenFolders.add(attacker);
    assert.equal((await restoredFolder(crafted.path)).folder, attacker);
    chosenFolders.clear();

    // Replacing a company keeps the folder that company already used.
    const r3 = await call<BackupRestoreResult>('data.backup.restoreFromFile', { path: crafted.path, mode: 'replace', replaceId: sourceId });
    assert.ok(r3.replacedTo);
    const db = new Db(path.join(root, 'data', 'companies', sourceId, 'company.db'), { readOnly: true });
    try {
      // The replaced company's own F12 folder was `picked`, not the backup's `attacker`.
      assert.equal((JSON.parse(db.value<string>(`SELECT value FROM settings WHERE key = 'config'`) ?? '{}') as Cfg).backup.folder, null);
    } finally {
      db.close();
    }
    // Now the company's folder is the default one; a backup naming `picked` over a company that uses
    // `picked` keeps it (restored from the data folder, nothing picked this session).
    await call('app.company.open', { id: sourceId });
    chosenFolders.add(picked);
    await call('company.config.save', { backup: { folder: picked } });
    await call('app.company.close');
    chosenFolders.clear();
    await call('data.backup.restoreFromFile', { path: ownElsewhere.path, mode: 'replace', replaceId: sourceId });
    const db2 = new Db(path.join(root, 'data', 'companies', sourceId, 'company.db'), { readOnly: true });
    try {
      assert.equal((JSON.parse(db2.value<string>(`SELECT value FROM settings WHERE key = 'config'`) ?? '{}') as Cfg).backup.folder, picked);
    } finally {
      db2.close();
    }
  });
});

// ───────────────────────────── Untrusted backup contents ─────────────────────────────

describe('backup: crafted databases are refused before they are queried', () => {
  async function crafted(tamper: (raw: DatabaseSync) => void, name: string): Promise<string> {
    const snap = path.join(dir, `${name}.db`);
    t.db.run('VACUUM INTO ?', [snap]);
    const raw = new DatabaseSync(snap);
    raw.exec('PRAGMA foreign_keys = OFF');
    tamper(raw);
    raw.close();
    const target = path.join(dir, `${name}.bahibak`);
    await writeContainer({
      dbPath: snap,
      target,
      manifest: {
        appVersion: '1.0.0',
        schemaVersion: SCHEMA_VERSION,
        companyId: 'test-company',
        companyGuid: 'x',
        companyName: 'Crafted',
        gstin: null,
        booksFrom: '2026-04-01',
        createdAt: '2026-10-05T04:30:00.000Z',
        createdBy: null,
        note: null,
        kind: 'manual',
      },
    });
    return target;
  }

  it('a view shadowing "ledgers" (endless recursive CTE) is reported in seconds, not a frozen app', async () => {
    const file = await crafted((raw) => {
      raw.exec('DROP TABLE ledgers');
      raw.exec('CREATE VIEW ledgers AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x AS id FROM c');
    }, 'view');
    const started = Date.now();
    const v = await verifyBackup(t.ctx, file, undefined);
    assert.ok(Date.now() - started < 5000);
    assert.equal(v.ok, false);
    const schema = v.checks.find((c) => c.name === 'schema');
    assert.equal(schema?.ok, false);
    assert.match(schema?.message ?? '', /unexpected database objects.*view "ledgers"/);
  });

  it('an extra trigger (silently changing amounts) is refused on verify and on restore', async () => {
    const file = await crafted((raw) => raw.exec(`CREATE TRIGGER skim AFTER INSERT ON ledger_entries BEGIN UPDATE ledger_entries SET amount = amount - 1 WHERE id = NEW.id; END`), 'trigger');
    const v = await verifyBackup(t.ctx, file, undefined);
    assert.match(v.checks.find((c) => c.name === 'schema')?.message ?? '', /trigger "skim"/);
    const r = await t.call(dataRoutes, 'data.backup.restore', { path: file, mode: 'new' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, 'VALIDATION');
      assert.match(r.error.message, /unexpected database objects/);
    }
  });
});

describe('backup: decompression bombs', () => {
  async function bomb(declaredDbBytes: number): Promise<string> {
    // 8 MiB of zeros gzips to a few KiB; the manifest then claims a tiny (or huge) database.
    const zeros = path.join(dir, 'zeros.db');
    fs.writeFileSync(zeros, Buffer.alloc(8 * 1024 * 1024));
    const target = path.join(dir, `bomb-${declaredDbBytes}.bahibak`);
    await writeContainer({
      dbPath: zeros,
      target,
      manifest: {
        appVersion: '1.0.0',
        schemaVersion: SCHEMA_VERSION,
        companyId: 'test-company',
        companyGuid: 'x',
        companyName: 'Bomb',
        gstin: null,
        booksFrom: '2026-04-01',
        createdAt: '2026-10-05T04:30:00.000Z',
        createdBy: null,
        note: null,
        kind: 'manual',
      },
    });
    // The payload checksum stays valid: only the (unauthenticated) manifest is rewritten.
    const info = readContainerInfo(target);
    const forged = Buffer.from(JSON.stringify({ ...info.manifest, dbBytes: declaredDbBytes }), 'utf8');
    const fd = fs.openSync(target, 'r+');
    try {
      const area = Buffer.alloc(info.payloadOffset - 12, 0x20);
      forged.copy(area);
      fs.writeSync(fd, area, 0, area.length, 12);
    } finally {
      fs.closeSync(fd);
    }
    return target;
  }

  it('stops unpacking as soon as the data exceeds the declared size (the disk never fills)', async () => {
    const file = await bomb(4096);
    const v = await verifyBackup(t.ctx, file, undefined);
    assert.equal(v.ok, false);
    assert.equal(v.checks.find((c) => c.name === 'checksum')?.ok, true, 'the payload itself is intact');
    const failed = v.checks.find((c) => c.name === 'decompress');
    assert.equal(failed?.ok, false);
    assert.match(failed?.message ?? '', /unpacks to more data than it declares/);
    assert.deepEqual(fs.readdirSync(t.ctx.app.dataDir).filter((f) => f.startsWith('.restore-')), [], 'work folder removed');
  });

  it('refuses a manifest declaring an impossibly large database before unpacking anything', async () => {
    const file = await bomb(60 * 1024 ** 3);
    const v = await verifyBackup(t.ctx, file, undefined);
    assert.match(v.checks.find((c) => c.name === 'decompress')?.message ?? '', /impossibly large/);
  });
});

describe('online backup step size (regression: Electron 44 rejected rate -1 and every backup failed)', () => {
  it('is a positive 32-bit integer large enough to copy any company file in one step', () => {
    assert.ok(Number.isInteger(BACKUP_PAGES_PER_STEP) && BACKUP_PAGES_PER_STEP > 0 && BACKUP_PAGES_PER_STEP <= 0x7fffffff);
    // 0x7fffffff pages of the 4 KiB default page size is 8 TiB: far beyond any company file.
    assert.ok(BACKUP_PAGES_PER_STEP * 4096 > 1024 ** 4);
  });
});
