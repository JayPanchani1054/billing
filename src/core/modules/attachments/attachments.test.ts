/**
 * Attachments (dataplus): storing, checks on the file, permissions, edit log, removal, period lock,
 * masters that still have files, data check, and — through the real app runtime — backup and restore
 * carrying the files.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ApiResult } from '../../../shared/api.ts';
import { MAX_ATTACHMENT_BYTES } from '../../../shared/attachments.ts';
import type { CreateCompanyInput, OpenResult } from '../../../shared/types/app.ts';
import type { AttachmentFile, AttachmentRow } from '../../../shared/types/attachments.ts';
import type { BackupCreateResult, BackupRestoreResult, BackupVerifyResult, DataVerifyResult } from '../../../shared/types/data.ts';
import type { LedgerDetail } from '../../../shared/types/accounts.ts';
import { appRoutes } from '../../app/routes.ts';
import { fixedClock } from '../../app/clock.ts';
import { createRuntimeWithRoutes } from '../../app/runtime-core.ts';
import type { Runtime } from '../../app/runtime.ts';
import { AppError } from '../../lib/errors.ts';
import { makeGstin } from '../../testing/fixtures.ts';
import { accountsRoutes } from '../accounts/routes.ts';
import { deleteLedger } from '../accounts/ledgers.ts';
import { companyRoutes } from '../company/routes.ts';
import { setPeriodLock } from '../company/service.ts';
import { dataRoutes } from '../data/routes.ts';
import { verifyData } from '../data/verify.ts';
import { deleteItem } from '../inventory/items.ts';
import { vouchersRoutes } from '../vouchers/routes.ts';
import { cancelVoucher, deleteVoucher } from '../vouchers/service.ts';
import { salesInput, save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { attachmentsRoutes } from './routes.ts';
import { addAttachment, removeUnusedFiles } from './service.ts';
import { attachmentsDir, contentProblem, sha256Hex } from './store.ts';
import { attachmentTypeOf } from '../../../shared/attachments.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const PDF = enc('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
const PDF2 = enc('%PDF-1.4\n% second scanned bill\n%%EOF\n');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

let k: Kit;
let voucherId: number;
beforeEach(() => {
  k = setupKit();
  voucherId = save(k, salesInput(k)).id;
});
afterEach(() => k.t.close());

async function ok<T>(route: string, input: unknown, who?: { permissions: string[] }): Promise<T> {
  const r = await k.t.call(attachmentsRoutes, route, input, who ? { session: k.t.sessionAs({ permissions: who.permissions as never }) } : undefined);
  if (!r.ok) throw new AppError(r.error.code, r.error.message, r.error.details);
  return r.data as T;
}

async function fails(route: string, input: unknown, code: string, re?: RegExp, who?: { permissions: string[] }): Promise<void> {
  const r = await k.t.call(attachmentsRoutes, route, input, who ? { session: k.t.sessionAs({ permissions: who.permissions as never }) } : undefined);
  assert.equal(r.ok, false, `${route} should fail`);
  if (!r.ok) {
    assert.equal(r.error.code, code, r.error.message);
    if (re) assert.match(r.error.message + JSON.stringify(r.error.details ?? ''), re);
  }
}

const attach = (bytes: Uint8Array, fileName = 'Supplier bill 1042.pdf', entityType = 'voucher', entityId = voucherId): Promise<AttachmentRow> =>
  ok<AttachmentRow>('attachments.add', { entityType, entityId, fileName, bytes });

describe('attachments: add, list, read', () => {
  it('stores the file under its SHA-256 in the company folder, lists and reads it back', async () => {
    const a = await attach(PDF);
    assert.equal(a.fileName, 'Supplier bill 1042.pdf');
    assert.equal(a.mime, 'application/pdf');
    assert.equal(a.sizeBytes, PDF.byteLength);
    assert.equal(a.sha256, sha256Hex(PDF));
    assert.equal(a.fileOk, true);
    const stored = path.join(attachmentsDir(k.t.ctx.company.dir), `${a.sha256}.pdf`);
    assert.deepEqual(new Uint8Array(fs.readFileSync(stored)), PDF);
    const list = await ok<AttachmentRow[]>('attachments.list', { entityType: 'voucher', entityId: voucherId });
    assert.deepEqual(list.map((r) => r.id), [a.id]);
    const file = await ok<AttachmentFile>('attachments.read', { id: a.id });
    assert.deepEqual(new Uint8Array(file.bytes), PDF);
    const counts = await ok<Record<string, number>>('attachments.counts', { entityType: 'voucher', ids: [voucherId, 999] });
    assert.deepEqual(counts, { [String(voucherId)]: 1 });
  });

  it('records the attachment in the voucher’s edit history', async () => {
    const a = await attach(PDF);
    const log = k.t.db.get<{ action: string; entity_label: string; after_json: string }>(
      `SELECT action, entity_label, after_json FROM audit_log WHERE entity_type = 'voucher' AND entity_id = :id ORDER BY id DESC LIMIT 1`,
      { id: voucherId },
    );
    assert.equal(log?.action, 'alter');
    assert.match(log?.entity_label ?? '', /file attached: Supplier bill 1042\.pdf/);
    assert.equal((JSON.parse(log?.after_json ?? '{}') as { attachmentAdded: { sha256: string } }).attachmentAdded.sha256, a.sha256);
  });

  it('the same scan on two vouchers is stored once; twice on the same voucher is refused', async () => {
    const other = save(k, salesInput(k)).id;
    await attach(PDF);
    await attach(PDF, 'copy.pdf', 'voucher', other);
    assert.equal(fs.readdirSync(attachmentsDir(k.t.ctx.company.dir)).filter((f) => f.endsWith('.pdf')).length, 1);
    await fails('attachments.add', { entityType: 'voucher', entityId: voucherId, fileName: 'again.pdf', bytes: PDF }, 'CONFLICT', /already attached/);
  });

  it('refuses programs, unknown kinds, wrong contents, macros, non-UTF-8 text and oversized files', async () => {
    const add = (fileName: string, bytes: Uint8Array) => ({ entityType: 'voucher', entityId: voucherId, fileName, bytes });
    await fails('attachments.add', add('setup.exe', enc('MZ......')), 'VALIDATION', /cannot be attached/);
    await fails('attachments.add', add('invoice.html', enc('<html></html>')), 'VALIDATION', /cannot be attached/);
    await fails('attachments.add', add('bill.pdf', enc('MZ\x90\x00 this is a program')), 'VALIDATION', /program/);
    await fails('attachments.add', add('bill.pdf', PNG), 'VALIDATION', /not a PDF document/);
    const macro = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...enc('xl/vbaProject.bin')]);
    await fails('attachments.add', add('book.xlsx', macro), 'VALIDATION', /macros/);
    await fails('attachments.add', add('notes.txt', new Uint8Array([0x41, 0xff, 0xfe, 0x42])), 'VALIDATION', /UTF-8/);
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    big.set(enc('%PDF-1.7'));
    await fails('attachments.add', add('big.pdf', big), 'VALIDATION', /at most 25\.0 MB/);
    // A folder in the name is dropped; the name never reaches the file system.
    const a = await attach(PNG, '..\\..\\Windows\\photo.png');
    assert.equal(a.fileName, 'photo.png');
    assert.equal(contentProblem(attachmentTypeOf('a.jpg')!, new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), null);
  });

  it('an XML file that is really a web page or an Office document is refused; plain XML data is fine', async () => {
    const xml = attachmentTypeOf('a.xml')!;
    // Opened from the books, these run in the browser / Office that handles .xml on the computer.
    for (const active of [
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body onload="x()">bill</body></html>',
      '<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="evil.xsl"?><bill/>',
      '<bill><script>alert(1)</script></bill>',
      '<?xml version="1.0"?><?mso-application progid="Word.Document"?><w:wordDocument/>',
      '<!DOCTYPE b [<!ENTITY x SYSTEM "file:///c:/windows/win.ini">]><b>&x;</b>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a/></svg>',
    ]) {
      assert.match(contentProblem(xml, enc(active)) ?? '', /could run when opened/, active);
    }
    assert.equal(contentProblem(xml, enc('<?xml version="1.0"?><Invoice><Irn>abc</Irn><Note>A &amp; B</Note></Invoice>')), null);
    await fails('attachments.add', { entityType: 'voucher', entityId: voucherId, fileName: 'einv.xml', bytes: enc('<a><script>x</script></a>') }, 'VALIDATION', /could run/);
  });
});

describe('attachments: permissions, removal, period lock', () => {
  it('an auditor sees but cannot add; data entry adds but cannot remove', async () => {
    await attach(PDF);
    const auditor = { permissions: ['vouchers.view', 'masters.view'] };
    assert.equal((await ok<AttachmentRow[]>('attachments.list', { entityType: 'voucher', entityId: voucherId }, auditor)).length, 1);
    await fails('attachments.add', { entityType: 'voucher', entityId: voucherId, fileName: 'x.png', bytes: PNG }, 'FORBIDDEN', undefined, auditor);
    const clerk = { permissions: ['vouchers.view', 'vouchers.create', 'attachments.add'] };
    const a = await ok<AttachmentRow>('attachments.add', { entityType: 'voucher', entityId: voucherId, fileName: 'x.png', bytes: PNG }, clerk);
    await fails('attachments.remove', { id: a.id }, 'FORBIDDEN', undefined, clerk);
    // Without vouchers.view nothing about the voucher is shown.
    await fails('attachments.list', { entityType: 'voucher', entityId: voucherId }, 'FORBIDDEN', undefined, { permissions: ['masters.view'] });
  });

  it('removal deletes the row, audits it, and deletes the stored file once nothing uses it', async () => {
    const other = save(k, salesInput(k)).id;
    const a = await attach(PDF);
    const b = await attach(PDF, 'copy.pdf', 'voucher', other);
    const file = path.join(attachmentsDir(k.t.ctx.company.dir), `${a.sha256}.pdf`);
    await ok('attachments.remove', { id: a.id });
    assert.equal(fs.existsSync(file), true, 'still used by the other voucher');
    await ok('attachments.remove', { id: b.id });
    assert.equal(fs.existsSync(file), false);
    const log = k.t.db.get<{ entity_label: string; before_json: string }>(
      `SELECT entity_label, before_json FROM audit_log WHERE entity_type = 'voucher' AND entity_id = :id ORDER BY id DESC LIMIT 1`,
      { id: other },
    );
    assert.match(log?.entity_label ?? '', /attachment removed: copy\.pdf/);
  });

  it('files of a voucher in the locked period can be added but not removed', async () => {
    const a = await attach(PDF);
    setPeriodLock(k.t.ctx, '2026-04-15');
    await fails('attachments.remove', { id: a.id }, 'LOCKED', /locked up to/);
    await attach(PDF2, 'later scan.pdf');
  });

  it('a ledger, stock item or voucher with files cannot be deleted (also not by a user who may not remove files)', async () => {
    const ledger = k.t.addLedger({ name: 'Empty Party', group: 'SUNDRY_DEBTORS' });
    await attach(PDF, 'agreement.pdf', 'ledger', ledger);
    assert.throws(() => deleteLedger(k.t.ctx, ledger), (e: unknown) => e instanceof AppError && /attachments/.test(e.message));
    const item = k.t.addStockItem({ name: 'Spare Part', unit: 'Nos' });
    await attach(PNG, 'photo.png', 'stock_item', item);
    assert.throws(() => deleteItem(k.t.ctx, item), (e: unknown) => e instanceof AppError && /attached file/.test(e.message));

    // A voucher: deleting it would take the evidence away with it, so it is refused — through the
    // dispatcher too, for a user who may delete vouchers but not remove attachments.
    const bill = await attach(PDF2, 'bill.pdf');
    assert.throws(() => deleteVoucher(k.t.ctx, voucherId), (e: unknown) => e instanceof AppError && e.code === 'BUSINESS_RULE' && /1 attached file/.test(e.message));
    const viaRoute = await k.t.call(vouchersRoutes, 'vouchers.delete', { id: voucherId }, { session: k.t.sessionAs({ permissions: ['vouchers.view', 'vouchers.delete'] as never }) });
    assert.equal(viaRoute.ok, false);
    if (!viaRoute.ok) assert.match(viaRoute.error.message, /Remove the attachments first/);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM vouchers WHERE id = :id', { id: voucherId }), 1);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM attachments WHERE voucher_id = :id', { id: voucherId }), 1);
    // Cancelling keeps the voucher and its file; once the file is removed the voucher can be deleted.
    await ok('attachments.remove', { id: bill.id });
    deleteVoucher(k.t.ctx, voucherId);
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM vouchers WHERE id = :id', { id: voucherId }), 0);
  });

  it('a stored file nothing refers to is reported by the data check and removed by the sweep', async () => {
    const dir = attachmentsDir(k.t.ctx.company.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sha256Hex(PDF2)}.pdf`), PDF2);
    const before = verifyData(k.t.ctx).checks.find((c) => c.name === 'attachments');
    assert.equal(before?.ok, true);
    assert.match(before?.details.join(' ') ?? '', /not attached to anything/);
    assert.equal(removeUnusedFiles(k.t.ctx), 1);
  });

  it('a file whose row cannot be written is not left behind in the folder', async () => {
    const realAudit = k.t.ctx.audit;
    k.t.ctx.audit = () => {
      throw new Error('disk full');
    };
    try {
      await assert.rejects(() => Promise.resolve().then(() => addAttachment(k.t.ctx, { entityType: 'voucher', entityId: voucherId, fileName: 'scan.pdf', bytes: PDF })));
    } finally {
      k.t.ctx.audit = realAudit;
    }
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM attachments'), 0);
    assert.equal(fs.existsSync(path.join(attachmentsDir(k.t.ctx.company.dir), `${sha256Hex(PDF)}.pdf`)), false);
  });

  it('cancelling a voucher keeps its files', async () => {
    await attach(PDF);
    cancelVoucher(k.t.ctx, voucherId, 'Wrong party');
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM attachments WHERE voucher_id = :id', { id: voucherId }), 1);
  });
});

describe('attachments: register', () => {
  it('lists every attachment with its owner, filtered by kind and search; voucher files need vouchers.view', async () => {
    const ledger = k.t.addLedger({ name: 'Kirana Wholesale', group: 'SUNDRY_CREDITORS' });
    await attach(PDF, 'GST certificate.pdf', 'ledger', ledger);
    await attach(PNG, 'delivery photo.png');
    const all = await ok<{ rows: Array<{ fileName: string; ownerLabel: string; entityType: string }>; total: number; totalBytes: number }>('attachments.register', {});
    assert.equal(all.total, 2);
    assert.equal(all.totalBytes, PDF.byteLength + PNG.byteLength);
    assert.ok(all.rows.some((r) => r.entityType === 'ledger' && r.ownerLabel === 'Kirana Wholesale'));
    assert.ok(all.rows.some((r) => r.entityType === 'voucher' && /\(15-Apr-2026\)$/.test(r.ownerLabel)), JSON.stringify(all.rows));
    const kirana = await ok<{ total: number }>('attachments.register', { search: 'kirana' });
    assert.equal(kirana.total, 1);
    const vouchersOnly = await ok<{ total: number }>('attachments.register', { entityType: 'voucher' });
    assert.equal(vouchersOnly.total, 1);
    const mastersOnly = await ok<{ total: number }>('attachments.register', {}, { permissions: ['masters.view'] });
    assert.equal(mastersOnly.total, 1);
  });
});

describe('attachments: data check', () => {
  it('reports a missing or changed stored file', async () => {
    const a = await attach(PDF);
    const b = await attach(PNG, 'photo.png');
    const dir = attachmentsDir(k.t.ctx.company.dir);
    fs.rmSync(path.join(dir, `${a.sha256}.pdf`));
    fs.writeFileSync(path.join(dir, `${b.sha256}.png`), new Uint8Array([...PNG.subarray(0, 11), 99]));
    const c = verifyData(k.t.ctx).checks.find((x) => x.name === 'attachments');
    assert.equal(c?.ok, false);
    assert.equal(c?.count, 2);
    assert.match(c?.details.join(' | ') ?? '', /missing from the attachments folder.*\|.*changed outside Pevqori/);
    await fails('attachments.read', { id: b.id }, 'BUSINESS_RULE', /changed outside/);
  });
});

describe('attachments in backup and restore (app runtime, end to end)', () => {
  let root: string;
  let rt: Runtime;
  const call = async <T>(route: string, input: unknown = {}): Promise<T> => {
    const r: ApiResult<unknown> = await rt.dispatch(route, input);
    if (!r.ok) throw new AppError(r.error.code, r.error.message, r.error.details);
    return r.data as T;
  };
  const company = (name: string): CreateCompanyInput => ({ name, stateCode: '27', gstRegistrationType: 'regular', gstin: makeGstin('27'), booksFrom: '2026-04-01' });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pevqori-att-'));
    rt = createRuntimeWithRoutes(
      { userDataDir: path.join(root, 'userData'), defaultDataDir: path.join(root, 'data'), appVersion: '1.2.3', clock: fixedClock('2026-10-05'), consoleLog: false },
      { ...appRoutes, ...companyRoutes, ...dataRoutes, ...accountsRoutes, ...attachmentsRoutes },
    );
  });
  afterEach(async () => {
    await rt.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const password of [undefined, 'Backup@2026']) {
    it(`a ${password ? 'password-protected' : 'plain'} backup carries the files; the restored company opens them`, async () => {
      const opened = await call<OpenResult>('app.company.create', company('Alpha Traders'));
      assert.ok(opened.company);
      const groups = await call<{ rows: Array<{ id: number; name: string }> }>('accounts.group.list', {});
      const debtors = groups.rows.find((g) => g.name === 'Sundry Debtors');
      assert.ok(debtors);
      const ledger = await call<LedgerDetail>('accounts.ledger.save', { name: 'Acme Traders', groupId: debtors.id });
      const a = await call<AttachmentRow>('attachments.add', { entityType: 'ledger', entityId: ledger.id, fileName: 'KYC.pdf', bytes: PDF });
      await call<AttachmentRow>('attachments.add', { entityType: 'ledger', entityId: ledger.id, fileName: 'photo.png', bytes: PNG });
      const backup = await call<BackupCreateResult>('data.backup.create', { folder: path.join(root, 'bk'), ...(password ? { password } : {}) });
      assert.deepEqual(backup.attachments, { files: 2, missing: [] });
      // The live company never keeps file contents in its database.
      const check = await call<DataVerifyResult>('data.verify', {});
      assert.equal(check.ok, true, JSON.stringify(check.checks.filter((c) => !c.ok)));

      const v = await call<BackupVerifyResult>('data.backup.verify', { path: backup.path, ...(password ? { password } : {}) });
      const att = v.checks.find((c) => c.name === 'attachments');
      assert.equal(att?.ok, true, JSON.stringify(v.checks));
      assert.match(att?.message ?? '', /All 2 attached file/);

      await call('app.company.close');
      const res = await call<BackupRestoreResult>('data.backup.restoreFromFile', { path: backup.path, mode: 'new', ...(password ? { password } : {}) });
      const files = fs.readdirSync(path.join(root, 'data', 'companies', res.company.id, 'attachments')).sort();
      assert.deepEqual(files, [`${sha256Hex(PDF)}.pdf`, `${sha256Hex(PNG)}.png`].sort());
      await call('app.company.open', { id: res.company.id });
      const back = await call<AttachmentFile>('attachments.read', { id: a.id });
      assert.deepEqual(new Uint8Array(back.bytes), PDF);
      const after = await call<DataVerifyResult>('data.verify', {});
      assert.equal(after.checks.find((c) => c.name === 'attachments')?.ok, true);
    });
  }
});
