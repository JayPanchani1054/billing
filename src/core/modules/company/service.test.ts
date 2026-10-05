import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { ApiResult } from '../../../shared/api.ts';
import { DEFAULT_CONFIG, DEFAULT_FEATURES, type CompanyConfig, type CompanyFeatures } from '../../../shared/settings.ts';
import type { CompanyProfile, CompanyProfileInput } from '../../../shared/types/company.ts';
import { verifyAuditChain } from '../../lib/audit.ts';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany, makeGstin, type TestCompany } from '../../testing/fixtures.ts';
import { companyRoutes } from './routes.ts';
import {
  assertDateUnlocked,
  decodeLogo,
  getCompanyProfile,
  getConfig,
  getFeatures,
  saveCompanyProfile,
  saveConfig,
  saveFeatures,
  setPeriodLock,
} from './service.ts';

const isCode = (code: string, re?: RegExp) => (e: unknown) => e instanceof AppError && e.code === code && (!re || re.test(e.message));
const errCode = (r: ApiResult<unknown>) => (r.ok ? null : r.error.code);

// 1×1 transparent PNG.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function profileInput(t: TestCompany, over: Partial<CompanyProfileInput> = {}): CompanyProfileInput {
  const p = getCompanyProfile(t.db);
  return {
    name: p.name,
    mailingName: p.mailingName,
    address: p.address,
    stateCode: p.stateCode ?? '27',
    gstRegistrationType: p.gstRegistrationType,
    gstin: p.gstin,
    pan: p.pan,
    booksFrom: p.booksFrom,
    fyStartMonth: p.fyStartMonth,
    ...over,
  };
}

function insertVoucher(t: TestCompany, date: string): void {
  t.db.run(
    `INSERT INTO vouchers (guid, voucher_type_id, base_type, date, created_at, updated_at)
     VALUES (:g, :vt, 'journal', :date, :ts, :ts)`,
    { g: randomUUID(), vt: t.ids.voucherTypes.journal, date, ts: t.clock.now().toISOString() },
  );
}

const lastAudit = (t: TestCompany) =>
  t.db.get<{ action: string; entity_type: string; before_json: string; after_json: string; username: string }>(
    'SELECT * FROM audit_log ORDER BY id DESC LIMIT 1',
  );

describe('company profile', () => {
  it('reads the seeded profile', () => {
    const t = createTestCompany();
    const p = getCompanyProfile(t.db);
    assert.equal(p.name, 'Test Traders Pvt Ltd');
    assert.equal(p.gstin, makeGstin('27'));
    assert.equal(p.pan, 'AAPFU0939F');
    assert.equal(p.gstRegistrationType, 'regular');
    assert.equal(p.booksFrom, '2026-04-01');
    assert.equal(p.logo, null);
    t.close();
  });

  it('saves edits, normalises fields and audits before/after', () => {
    const t = createTestCompany();
    const saved = saveCompanyProfile(t.ctx, profileInput(t, { name: '  New Name Ltd ', email: 'accounts@newname.in', tan: 'mumn12345a', mailingName: '' }));
    assert.equal(saved.name, 'New Name Ltd');
    assert.equal(saved.mailingName, 'New Name Ltd');
    assert.equal(saved.tan, 'MUMN12345A');
    assert.equal(saved.email, 'accounts@newname.in');
    const a = lastAudit(t);
    assert.equal(a?.action, 'alter');
    assert.equal(a?.entity_type, 'company');
    assert.equal(JSON.parse(a?.before_json ?? '{}').name, 'Test Traders Pvt Ltd');
    assert.equal(JSON.parse(a?.after_json ?? '{}').name, 'New Name Ltd');
    t.close();
  });

  it('rejects inconsistent GST details', () => {
    const t = createTestCompany();
    assert.throws(() => saveCompanyProfile(t.ctx, profileInput(t, { stateCode: '29' })), isCode('VALIDATION', /does not match/));
    assert.throws(() => saveCompanyProfile(t.ctx, profileInput(t, { gstin: null })), isCode('VALIDATION', /GSTIN is required/));
    assert.throws(() => saveCompanyProfile(t.ctx, profileInput(t, { email: 'not-an-email' })), isCode('VALIDATION'));
    t.close();
  });

  it('stores the logo as bytes and returns a data URL; rejects SVG, junk and oversize images', () => {
    const t = createTestCompany();
    const withLogo = saveCompanyProfile(t.ctx, profileInput(t, { logo: `data:image/png;base64,${PNG_1PX}` }));
    assert.equal(withLogo.logo, `data:image/png;base64,${PNG_1PX}`);
    assert.ok(t.db.value('SELECT logo FROM company') instanceof Uint8Array);
    assert.match(lastAudit(t)?.after_json ?? '', /\[logo \d+ chars\]/, 'audit does not embed the image');
    // Omitted logo keeps it; null removes it.
    assert.equal(saveCompanyProfile(t.ctx, profileInput(t)).logo, withLogo.logo);
    assert.equal(saveCompanyProfile(t.ctx, profileInput(t, { logo: null })).logo, null);

    assert.throws(() => decodeLogo('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), isCode('VALIDATION', /PNG, JPEG/));
    assert.throws(() => decodeLogo(`data:image/png;base64,${Buffer.from('hello world').toString('base64')}`), isCode('VALIDATION', /not a valid image/));
    const big = Buffer.alloc(600 * 1024);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.throws(() => decodeLogo(`data:image/png;base64,${big.toString('base64')}`), isCode('VALIDATION', /too large/));
    assert.throws(() => decodeLogo('javascript:alert(1)'), isCode('VALIDATION'));
    t.close();
  });

  it('refuses a books-from date after existing vouchers and an FY-month change once vouchers exist', () => {
    const t = createTestCompany();
    insertVoucher(t, '2026-04-05');
    assert.throws(() => saveCompanyProfile(t.ctx, profileInput(t, { booksFrom: '2026-05-01' })), isCode('BUSINESS_RULE', /1 voucher is dated before/));
    assert.equal(saveCompanyProfile(t.ctx, profileInput(t, { booksFrom: '2026-04-05' })).booksFrom, '2026-04-05');
    assert.throws(() => saveCompanyProfile(t.ctx, profileInput(t, { fyStartMonth: 1 })), isCode('BUSINESS_RULE'));
    t.close();
  });

  it('switching to unregistered turns GST off; registering again turns it on and creates ledgers', () => {
    const t = createTestCompany({ gst: false });
    assert.equal(getFeatures(t.db).gst, false);
    const registered = saveCompanyProfile(t.ctx, profileInput(t, { gstRegistrationType: 'regular', gstin: makeGstin('27') }));
    assert.equal(registered.gstin, makeGstin('27'));
    assert.equal(getFeatures(t.db).gst, true);
    assert.equal(t.db.value(`SELECT COUNT(*) FROM ledgers WHERE tax_type = 'GST'`), 12);
    saveCompanyProfile(t.ctx, profileInput(t, { gstRegistrationType: 'unregistered' }));
    assert.equal(getFeatures(t.db).gst, false);
    assert.equal(getCompanyProfile(t.db).gstin, null);
    assert.equal(t.db.value(`SELECT COUNT(*) FROM ledgers WHERE tax_type = 'GST'`), 12, 'ledgers kept');
    t.close();
  });
});

describe('features (F11)', () => {
  it('merges stored features over defaults (new keys get defaults)', () => {
    const t = createTestCompany();
    t.db.run(`UPDATE settings SET value = '{"gst":true,"costCentres":true}' WHERE key = 'features'`);
    assert.deepEqual(getFeatures(t.db), { ...DEFAULT_FEATURES, costCentres: true });
    t.close();
  });

  it('enabling GST creates the tax ledgers idempotently; disabling keeps them', () => {
    // Registered business that started with the GST feature off: no tax ledgers yet.
    const t = createTestCompany({ gst: false, registrationType: 'regular' });
    assert.equal(t.db.value(`SELECT COUNT(*) FROM ledgers WHERE tax_type = 'GST'`), 0);
    const on = saveFeatures(t.ctx, { gst: true, einvoice: true });
    assert.equal(on.einvoice, true);
    assert.equal(t.ctx.company.gstEnabled, true);
    assert.equal(t.db.value(`SELECT COUNT(*) FROM ledgers WHERE tax_type = 'GST'`), 12);
    saveFeatures(t.ctx, { gst: true });
    assert.equal(t.db.value(`SELECT COUNT(*) FROM ledgers WHERE tax_type = 'GST'`), 12);
    const off = saveFeatures(t.ctx, { gst: false });
    assert.equal(off.gst, false);
    assert.equal(off.einvoice, false, 'e-invoice depends on GST');
    assert.equal(t.db.value(`SELECT COUNT(*) FROM ledgers WHERE tax_type = 'GST'`), 12);
    assert.equal(lastAudit(t)?.action, 'settings');
    t.close();
  });

  it('refuses GST for an unregistered business and applies dependency rules', () => {
    const t = createTestCompany({ gst: false });
    assert.throws(() => saveFeatures(t.ctx, { gst: true }), isCode('BUSINESS_RULE', /unregistered/));
    const f = saveFeatures(t.ctx, { inventory: false, batches: true, expiryDates: true });
    assert.equal(f.inventory, false);
    assert.equal(f.batches, false);
    assert.equal(f.expiryDates, false);
    assert.equal(f.integrateInventory, false);
    t.close();
  });

  it('security can be turned on only with an Owner user and only by a security manager', () => {
    const t = createTestCompany();
    assert.throws(() => saveFeatures(t.ctx, { security: true }), isCode('BUSINESS_RULE', /Owner user/));
    const manager = t.ctxAs({ permissions: ['company.manage'] });
    // Not touching the security flag needs only company.manage.
    assert.equal(saveFeatures(manager, { security: false, billWise: false }).billWise, false);
    t.close();

    const s = createTestCompany({ security: true });
    assert.throws(() => saveFeatures(s.ctxAs({ permissions: ['company.manage'] }), { security: false }), isCode('FORBIDDEN'));
    assert.equal(saveFeatures(s.ctx, { security: false }).security, false);
    assert.equal(saveFeatures(s.ctx, { security: true }).security, true);
    s.close();
  });
});

describe('configuration (F12)', () => {
  it('deep-merges partial updates and ignores lockedUpTo', () => {
    const t = createTestCompany();
    const c = saveConfig(t.ctx, { invoice: { template: 'classic', terms: 'Net 30' }, guards: { negativeStock: 'block' } });
    assert.equal(c.invoice.template, 'classic');
    assert.equal(c.invoice.terms, 'Net 30');
    assert.equal(c.invoice.declaration, DEFAULT_CONFIG.invoice.declaration, 'siblings kept');
    assert.equal(c.guards.negativeStock, 'block');
    assert.equal(c.guards.negativeCash, 'warn');
    saveConfig(t.ctx, { lockedUpTo: '2026-04-10' } as never);
    assert.equal(getConfig(t.db).lockedUpTo, null);
    assert.deepEqual(getConfig(t.db).invoice.copies, ['original']);
    t.close();
  });

  it('validates the bank ledger and LUT dates', () => {
    const t = createTestCompany();
    assert.throws(() => saveConfig(t.ctx, { invoice: { bankLedgerId: 99_999 } }), isCode('VALIDATION'));
    const bank = t.addLedger({ name: 'HDFC Bank', group: 'BANK_ACCOUNTS' });
    assert.equal(saveConfig(t.ctx, { invoice: { bankLedgerId: bank } }).invoice.bankLedgerId, bank);
    assert.throws(() => saveConfig(t.ctx, { gst: { lutValidFrom: '2026-04-01', lutValidTo: '2026-03-01' } }), isCode('VALIDATION'));
    t.close();
  });
});

describe('period lock', () => {
  it('locks and unlocks books with audit, refusing future dates', () => {
    const t = createTestCompany({ today: '2026-06-30' });
    assert.doesNotThrow(() => assertDateUnlocked(t.db, '2026-04-01'));
    assert.deepEqual(setPeriodLock(t.ctx, '2026-05-31'), { lockedUpTo: '2026-05-31' });
    assert.throws(() => assertDateUnlocked(t.db, '2026-05-31'), isCode('LOCKED', /locked up to 31-May-2026/));
    assert.throws(() => assertDateUnlocked(t.db, '2026-04-01'), isCode('LOCKED'));
    assert.doesNotThrow(() => assertDateUnlocked(t.db, '2026-06-01'));
    assert.equal(lastAudit(t)?.after_json, '{"lockedUpTo":"2026-05-31"}');
    assert.throws(() => setPeriodLock(t.ctx, '2026-07-01'), isCode('BUSINESS_RULE', /only up to today/));
    setPeriodLock(t.ctx, null);
    assert.doesNotThrow(() => assertDateUnlocked(t.db, '2026-04-01'));
    // Configuration saves do not disturb the lock.
    setPeriodLock(t.ctx, '2026-04-30');
    saveConfig(t.ctx, { display: { showZeroBalances: true } });
    assert.equal(getConfig(t.db).lockedUpTo, '2026-04-30');
    assert.equal(verifyAuditChain(t.db).ok, true);
    t.close();
  });
});

describe('company routes', () => {
  it('serve profile, features, config and summary to an authenticated session', async () => {
    const t = createTestCompany();
    const profile = await t.callOk<CompanyProfile>(companyRoutes, 'company.profile.get');
    assert.equal(profile.name, 'Test Traders Pvt Ltd');
    assert.equal((await t.callOk<CompanyFeatures>(companyRoutes, 'company.features.get')).gst, true);
    assert.equal((await t.callOk<CompanyConfig>(companyRoutes, 'company.config.get')).roundOff.unit, 100);
    const summary = await t.callOk<{ id: string; gstEnabled: boolean; stateCode: string }>(companyRoutes, 'company.summary');
    assert.deepEqual([summary.id, summary.gstEnabled, summary.stateCode], ['test-company', true, '27']);
    t.close();
  });

  it('enforce permissions per route', async () => {
    const t = createTestCompany();
    const dataEntry = { session: t.sessionAs({ role: 'Data Entry' }) };
    const auditor = { session: t.sessionAs({ role: 'Auditor' }) };
    const input = profileInput(t, { name: 'Hacked' });
    assert.equal(errCode(await t.call(companyRoutes, 'company.profile.save', input, dataEntry)), 'FORBIDDEN');
    assert.equal(errCode(await t.call(companyRoutes, 'company.features.save', { gst: false }, auditor)), 'FORBIDDEN');
    assert.equal(errCode(await t.call(companyRoutes, 'company.periodLock.set', { date: '2026-04-01' }, dataEntry)), 'FORBIDDEN');
    assert.ok((await t.call(companyRoutes, 'company.profile.get', {}, auditor)).ok);
    assert.ok((await t.call(companyRoutes, 'company.features.get', {}, dataEntry)).ok);
    assert.equal(getCompanyProfile(t.db).name, 'Test Traders Pvt Ltd');
    const accountant = { session: t.sessionAs({ role: 'Accountant' }) };
    assert.ok((await t.call(companyRoutes, 'company.periodLock.set', { date: '2026-04-10' }, accountant)).ok);
    t.close();
  });

  it('validate inputs (patch semantics for config, explicit null for unlock)', async () => {
    const t = createTestCompany();
    assert.equal(errCode(await t.call(companyRoutes, 'company.periodLock.set', {})), 'VALIDATION');
    assert.equal(errCode(await t.call(companyRoutes, 'company.config.save', { roundOff: { method: 'sideways' } })), 'VALIDATION');
    assert.equal(errCode(await t.call(companyRoutes, 'company.config.save', { invoice: { upiId: 'not a upi' } })), 'VALIDATION');
    assert.equal(errCode(await t.call(companyRoutes, 'company.features.save', { gst: 'yes' })), 'VALIDATION');
    const bank = t.addLedger({ name: 'SBI', group: 'BANK_ACCOUNTS' });
    await t.callOk(companyRoutes, 'company.config.save', { invoice: { bankLedgerId: bank, upiId: 'shop@okhdfc' } });
    await t.callOk(companyRoutes, 'company.config.save', { invoice: { terms: 'x' } });
    assert.equal(getConfig(t.db).invoice.bankLedgerId, bank, 'omitted key keeps value');
    await t.callOk(companyRoutes, 'company.config.save', { invoice: { bankLedgerId: null } });
    assert.equal(getConfig(t.db).invoice.bankLedgerId, null, 'explicit null clears');
    await t.callOk(companyRoutes, 'company.periodLock.set', { date: '2026-04-10' });
    await t.callOk(companyRoutes, 'company.periodLock.set', { date: null });
    assert.equal(getConfig(t.db).lockedUpTo, null);
    const saved = await t.callOk<CompanyProfile>(companyRoutes, 'company.profile.save', { ...profileInput(t), logo: `data:image/png;base64,${PNG_1PX}` });
    assert.ok(saved.logo);
    t.close();
  });

  it('roll back the whole save when a rule fails mid-way', async () => {
    const t = createTestCompany({ gst: false });
    const before = t.db.value('SELECT COUNT(*) FROM audit_log');
    const r = await t.call(companyRoutes, 'company.features.save', { gst: true, costCentres: true });
    assert.equal(errCode(r), 'BUSINESS_RULE');
    assert.equal(getFeatures(t.db).costCentres, false);
    assert.equal(t.db.value('SELECT COUNT(*) FROM audit_log'), before);
    t.close();
  });
});
