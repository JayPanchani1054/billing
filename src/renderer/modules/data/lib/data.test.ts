import fs from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CompanyListItem } from '../../../../shared/types/app.ts';
import type { BackupFileInfo, BackupManifest, BackupVerifyResult, DataVerifyResult, ImportPreviewResult, ImportRowResult, XmlImportResult, XmlPreviewResult } from '../../../../shared/types/data.ts';
import {
  backupFileNamePreview,
  backupFreshness,
  backupRowStatus,
  dataCheckSummary,
  passwordProblem,
  passwordStrength,
  restoreTargets,
  verifyOutcome,
} from './backupView.ts';
import {
  actionText,
  commitBlockReason,
  commitResultText,
  filterRows,
  issueCounts,
  previewSummaryText,
  progressPercent,
  spreadsheetFileProblem,
  statusBadge,
  xmlCountRows,
  xmlFileProblem,
  xmlOptionsProblem,
  xmlResultSummary,
} from './importView.ts';

const manifest = (over: Partial<BackupManifest> = {}): BackupManifest => ({
  format: 'pevqori-backup',
  formatVersion: 1,
  appVersion: '1.0.0',
  schemaVersion: 140,
  companyId: 'shree',
  companyGuid: 'g',
  companyName: 'Shree Traders',
  gstin: null,
  booksFrom: '2026-04-01',
  createdAt: '2026-10-05T04:30:00.000Z',
  createdBy: 'Owner',
  note: null,
  kind: 'manual',
  encrypted: false,
  compression: 'gzip',
  payloadSha256: 'x',
  payloadBytes: 1,
  dbSha256: 'y',
  dbBytes: 2,
  ...over,
});

describe('backup password', () => {
  it('rates length first, then variety; common sequences are weak', () => {
    assert.equal(passwordStrength('').label, 'No password');
    assert.deepEqual([passwordStrength('abc').score, passwordStrength('abc').label], [0, 'Too short']);
    assert.match(passwordStrength('abcdefg').tip ?? '', /Add 1 more character \(at least 8\)/);
    assert.equal(passwordStrength('kitchens').label, 'Weak'); // 8 lower-case letters
    assert.equal(passwordStrength('kitchen-table').label, 'Fair'); // 13 chars, 2 classes
    assert.equal(passwordStrength('Kitchen-Table-26').label, 'Strong'); // 16 chars, 4 classes
    assert.equal(passwordStrength('12345678901234').label, 'Weak'); // sequence
    assert.equal(passwordStrength('aaaaaaaaaaaaaaaa').label, 'Weak');
  });

  it('checks minimum length and the confirmation', () => {
    assert.equal(passwordProblem('', ''), null); // no password = unencrypted backup
    assert.deepEqual(passwordProblem('short', 'short')?.field, 'password');
    assert.deepEqual(passwordProblem('Backup@2026', 'Backup@2025')?.field, 'confirm');
    assert.equal(passwordProblem('Backup@2026', 'Backup@2026'), null);
  });
});

describe('backup list and freshness', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  it('describes how old the last backup is', () => {
    assert.deepEqual(backupFreshness(null, now), { tone: 'warning', title: 'This company has never been backed up' });
    assert.equal(backupFreshness('2026-10-05T11:30:00Z', now).title, 'Last backup less than an hour ago');
    assert.equal(backupFreshness('2026-10-05T09:00:00Z', now).title, 'Last backup 3 hours ago');
    assert.deepEqual(backupFreshness('2026-10-03T12:00:00Z', now), { tone: 'warning', title: 'Last backup 2 days ago' });
    assert.equal(backupFreshness('2026-09-20T12:00:00Z', now).tone, 'danger');
  });

  it('labels files: unreadable, password, automatic or manual', () => {
    const base: BackupFileInfo = { path: '/b/x.pvqbak', fileName: 'x.pvqbak', sizeBytes: 10, modifiedAt: '', manifest: manifest(), problem: null, isCurrentCompany: true };
    assert.deepEqual(backupRowStatus(base), { label: 'Manual', tone: 'neutral' });
    assert.equal(backupRowStatus({ ...base, manifest: manifest({ kind: 'auto' }) }).label, 'Automatic');
    assert.equal(backupRowStatus({ ...base, manifest: manifest({ encrypted: true }) }).label, 'Password');
    assert.equal(backupRowStatus({ ...base, manifest: null, problem: 'Not a backup' }).tone, 'danger');
  });

  it('previews the file name like the server (unsafe characters, trailing dots)', () => {
    const d = new Date(2026, 9, 5, 14, 3, 9);
    assert.equal(backupFileNamePreview('Shree: Ganesh/Traders.', d), 'Shree Ganesh Traders_20261005-140309.pvqbak');
    assert.equal(backupFileNamePreview('CON', d), 'Company_20261005-140309.pvqbak');
  });
});

describe('verify and restore', () => {
  const result = (over: Partial<BackupVerifyResult>): BackupVerifyResult => ({
    ok: false,
    path: '/x',
    manifest: manifest(),
    checks: [],
    needsPassword: false,
    companyName: 'Shree Traders',
    schemaVersion: 140,
    supported: true,
    counts: null,
    ...over,
  });

  it('turns check results into one clear outcome', () => {
    assert.equal(verifyOutcome(result({ ok: true, counts: { ledgers: 12, vouchers: 340, stockItems: 3 } })).message, 'Shree Traders can be restored from this file (12 ledgers, 340 vouchers).');
    assert.equal(verifyOutcome(result({ needsPassword: true })).title, 'This backup has a password');
    assert.equal(verifyOutcome(result({ checks: [{ name: 'password', ok: false, message: 'Wrong password.' }] })).message, 'Wrong password.');
    assert.equal(verifyOutcome(result({ supported: false })).title, 'Made by a newer version of Pevqori');
  });

  it('never offers the open company as a restore target; the backup’s company comes first', () => {
    const c = (id: string, name: string): CompanyListItem => ({ id, name, gstin: null, stateCode: null, booksFrom: '', fyLabel: '', securityEnabled: false, lastOpenedAt: null, sizeBytes: 0, schemaVersion: 1, needsUpgrade: false });
    const t = restoreTargets([c('a', 'Alpha'), c('shree', 'Shree Traders'), c('z', 'Zeta')], 'z', 'shree');
    assert.deepEqual(
      t.map((x) => [x.id, x.disabledReason !== null]),
      [
        ['shree', false],
        ['a', false],
        ['z', true],
      ],
    );
  });

  it('summarises the data check', () => {
    const ok: DataVerifyResult = { ok: true, checkedAt: '', checks: [{ name: 'integrity', label: '', ok: true, count: 0, details: [] }] };
    assert.equal(dataCheckSummary(ok).tone, 'success');
    const bad: DataVerifyResult = {
      ok: false,
      checkedAt: '',
      checks: [
        { name: 'voucher_balance', label: '', ok: false, count: 2, details: [] },
        { name: 'orphans', label: '', ok: false, count: 1, details: [] },
        { name: 'integrity', label: '', ok: true, count: 0, details: [] },
      ],
    };
    const s = dataCheckSummary(bad);
    assert.equal(s.tone, 'danger');
    assert.equal(s.title, '2 of 3 checks found problems');
    assert.match(s.message, /^3 problems in total/);
  });
});

describe('import wizard', () => {
  const row = (n: number, status: ImportRowResult['status'], action: ImportRowResult['action'] = 'create'): ImportRowResult => ({
    rowNumber: n,
    rowNumbers: [n],
    key: `r${n}`,
    data: {},
    status,
    action,
    messages: [],
  });
  const preview = (rows: ImportRowResult[], kind: ImportPreviewResult['kind'] = 'ledgers'): ImportPreviewResult => ({
    kind,
    fileName: 'x.csv',
    sheet: null,
    headerRow: 1,
    mappedColumns: [],
    unmappedHeaders: [],
    rows,
    summary: {
      total: rows.length,
      ok: rows.filter((r) => r.status === 'ok').length,
      warning: rows.filter((r) => r.status === 'warning').length,
      error: rows.filter((r) => r.status === 'error').length,
      duplicate: rows.filter((r) => r.status === 'duplicate').length,
      willCreate: rows.filter((r) => r.status !== 'error' && r.action === 'create').length,
      willUpdate: rows.filter((r) => r.status !== 'error' && r.action === 'update').length,
      willSkip: rows.filter((r) => r.action === 'skip').length,
    },
  });

  it('accepts xlsx/csv and explains old or foreign formats', () => {
    assert.equal(spreadsheetFileProblem('Ledgers.XLSX'), null);
    assert.equal(spreadsheetFileProblem('a.csv'), null);
    assert.match(spreadsheetFileProblem('old.xls') ?? '', /Save As/);
    assert.equal(xmlFileProblem('Master.xml'), null);
    assert.match(xmlFileProblem('Company.900') ?? '', /Export/);
  });

  it('filters rows and labels their status and action', () => {
    const rows = [row(2, 'ok'), row(3, 'error', 'none'), row(4, 'duplicate', 'skip'), row(5, 'warning')];
    assert.deepEqual(
      filterRows(rows, 'problems').map((r) => r.rowNumber),
      [3, 4, 5],
    );
    assert.deepEqual(
      filterRows(rows, 'error').map((r) => r.rowNumber),
      [3],
    );
    assert.equal(statusBadge('duplicate').label, 'Exists');
    assert.equal(actionText(rows[1]), 'Not imported');
    assert.equal(actionText(rows[2]), 'Skipped (already exists)');
    assert.equal(previewSummaryText(preview(rows)), '4 records read · 2 to create · 1 already exists · 1 to check · 1 with errors');
  });

  it('blocks all-or-nothing with errors, an empty run, and unacknowledged voucher warnings', () => {
    const withError = preview([row(2, 'ok'), row(3, 'error', 'none')]);
    assert.match(commitBlockReason(withError, { skipInvalid: false }) ?? '', /1 record has errors/);
    assert.equal(commitBlockReason(withError, { skipInvalid: true }), null);
    const dupes = preview([row(2, 'duplicate', 'skip')]);
    assert.match(commitBlockReason(dupes, {}) ?? '', /Update existing/);
    const vouchers = preview([row(2, 'warning')], 'sales_invoices');
    assert.match(commitBlockReason(vouchers, {}) ?? '', /needs checking/);
    assert.equal(commitBlockReason(vouchers, { acknowledgeWarnings: true }), null);
    assert.equal(commitBlockReason(preview([row(2, 'warning')]), {}), null); // masters: warnings are informational
  });

  it('describes the result', () => {
    const r = commitResultText({ kind: 'ledgers', total: 5, created: 3, updated: 0, skipped: 0, failed: 2, rows: [] });
    assert.deepEqual(r, { tone: 'warning', title: 'Imported 3 of 5 records', message: '3 created · 2 not imported because of errors' });
  });
});

describe('XML data import wizard', () => {
  const p = (over: Partial<XmlPreviewResult> = {}): XmlPreviewResult => ({
    fileName: 'Master.xml',
    encoding: 'utf-16le',
    companyName: 'Shree',
    counts: { GROUP: 3, LEDGER: 14, COSTCATEGORY: 0, COSTCENTRE: 1, CURRENCY: 1, UNIT: 4, GODOWN: 2, STOCKGROUP: 1, STOCKCATEGORY: 0, STOCKITEM: 2, VOUCHERTYPE: 1, VOUCHER: 11 },
    unsupported: [],
    vouchersByType: [],
    dateRange: { from: '2026-04-03', to: '2026-05-15' },
    samples: { groups: [], ledgers: [], stockItems: [], vouchers: [] },
    existing: { groups: 1, ledgers: 3, stockItems: 0, units: 1, godowns: 1 },
    issues: [
      { severity: 'error', code: 'unbalanced', message: 'x' },
      { severity: 'info', code: 'unsupported', message: 'y' },
    ],
    ...over,
  });

  it('lists what is in the file, skipping empty kinds, with existing counts', () => {
    const rows = xmlCountRows(p());
    assert.equal(rows.length, 10); // 12 kinds − cost categories − stock categories
    assert.deepEqual(rows[1], { key: 'LEDGER', label: 'Ledgers', count: 14, existing: 3 });
    assert.equal(rows.at(-1)?.existing, null);
    assert.deepEqual(issueCounts(p().issues), { error: 1, warning: 0, info: 1 });
  });

  it('validates the options against the file', () => {
    assert.equal(xmlOptionsProblem(p(), { masters: true, vouchers: true, onDuplicate: 'skip' }), null);
    assert.match(xmlOptionsProblem(p(), { masters: false, vouchers: false, onDuplicate: 'skip' }) ?? '', /masters, vouchers or both/);
    const noVch = p({ counts: { ...p().counts, VOUCHER: 0 } });
    assert.match(xmlOptionsProblem(noVch, { vouchers: true, onDuplicate: 'skip' }) ?? '', /no vouchers/);
    assert.match(xmlOptionsProblem(p(), { vouchers: true, from: '2026-05-01', to: '2026-04-01', onDuplicate: 'skip' }) ?? '', /after/);
  });

  it('progress and result summary', () => {
    assert.equal(progressPercent(null), null);
    assert.equal(progressPercent({ running: true, phase: 'vouchers', done: 250, total: 1000, message: '' }), 25);
    const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
    const res: XmlImportResult = {
      masters: { groups: { ...counts, created: 2 }, ledgers: { ...counts, created: 11, skipped: 2 }, costCategories: counts, costCentres: counts, units: counts, godowns: counts, stockGroups: counts, stockCategories: counts, stockItems: counts, voucherTypes: counts },
      vouchers: { created: 10, updated: 0, skipped: 0, failed: 1 },
      issues: [{ severity: 'error', code: 'unbalanced', message: 'x' }],
      batchId: 1,
      stopped: false,
      durationMs: 80,
    };
    const s = xmlResultSummary(res);
    assert.equal(s.tone, 'warning');
    assert.deepEqual(s.lines, ['Masters: 13 created, 0 updated, 2 already existed.', 'Vouchers: 10 created, 0 updated, 0 skipped (already here — see the notes), 1 not imported.']);
    assert.equal(xmlResultSummary({ ...res, stopped: true }).tone, 'danger');
  });
});

describe('restore wizard steps', () => {
  it('moves choose → check → restore → done', async () => {
    const { restoreStep, restoreChoiceProblem } = await import('./backupView.ts');
    assert.equal(restoreStep({ hasFile: false, verified: false, restored: false }), 'choose');
    assert.equal(restoreStep({ hasFile: true, verified: false, restored: false }), 'check');
    assert.equal(restoreStep({ hasFile: true, verified: true, restored: false }), 'restore');
    assert.equal(restoreStep({ hasFile: true, verified: true, restored: true }), 'done');
    const target = { id: 'a', name: 'Alpha', disabledReason: null, sameCompany: true, securityEnabled: true };
    assert.equal(restoreChoiceProblem({ mode: 'new', target: null, ownerPassword: '' }), null);
    assert.match(restoreChoiceProblem({ mode: 'replace', target: null, ownerPassword: '' }) ?? '', /Choose the company/);
    assert.match(restoreChoiceProblem({ mode: 'replace', target, ownerPassword: '' }) ?? '', /owner password/);
    assert.equal(restoreChoiceProblem({ mode: 'replace', target, ownerPassword: 'x' }), null);
    assert.match(restoreChoiceProblem({ mode: 'replace', target: { ...target, disabledReason: 'Open now' }, ownerPassword: 'x' }) ?? '', /cannot be replaced/);
  });
});

describe('busy company: Excel / XML data import offer "Wait and retry" (follow-up)', () => {
  const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  it('ImportScreen: preview and import retry while busy; the banner offers the button', () => {
    const src = read('ImportScreen.tsx');
    assert.match(src, /isBusyConflict\(err\)\) setError\(\{ title: 'Another task is running in this company', message: busyText\(err\), retry: \(\) => void runPreview\(f, k, update, true\) \}\)/);
    assert.match(src, /retry: \(\) => void runCommit\(true\)/);
    assert.match(src, /retryWhileBusy\(fn, \{ cancelled: \(\) => closed\.current \}\)/);
    assert.match(src, /Wait and retry/);
  });
  it('XmlImportScreen: the import retries while busy', () => {
    const src = read('XmlImportScreen.tsx');
    assert.match(src, /retry: \(\) => void startImport\(true\)/);
    assert.match(src, /retryWhileBusy\(call, \{ cancelled: \(\) => closed\.current \}\)/);
  });
  it('BackupScreen: an F12 folder not approved on this computer is confirmed through the folder dialog', () => {
    const src = read('BackupScreen.tsx');
    assert.match(src, /native\('dialog\.chooseFolder', \{ title: 'Confirm the backup folder', defaultPath: unapproved \}\)/);
    assert.match(src, /approve\.mutate\(\{ folder: picked\.path \}\)/);
  });
});
