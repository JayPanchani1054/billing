import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  AuditEntityHistory,
  AuditEntryDetail,
  AuditExportResult,
  AuditFacets,
  AuditListResult,
  AuditVerifyReport,
} from '../../../shared/types/security.ts';
import type { AuditEntry, Session } from '../../api/context.ts';
import { setStrictRouteInput } from '../../api/dispatch.ts';
import { appendAudit } from '../../lib/audit.ts';
import { parseCsv } from '../../lib/csv.ts';
import { LEGACY_XML_DATA_KIND } from '../../lib/legacyNames.ts';
import { decodeText } from '../../lib/text.ts';
import { readXlsx } from '../../lib/xlsx.ts';
import { readZip } from '../../lib/zip.ts';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { entityTypeLabel, entityTypesMatching, localDayStartIso } from './auditlog.ts';
import { securityRoutes as R } from './routes.ts';

const HOUR = 3_600_000;

/** A secured company whose edit log holds a known sequence (fixture seeding writes no audit rows). */
function seeded(): { t: TestCompany; ravi: Session; sita: Session } {
  const t = createTestCompany({ security: true, today: '2026-04-15' });
  assert.equal(t.db.value<number>('SELECT COUNT(*) FROM audit_log'), 0);
  const ravi = t.sessionAs({ role: 'Accountant', username: 'ravi', userId: 2 });
  const sita = t.sessionAs({ role: 'Data Entry', username: 'sita', userId: 3 });
  const add = (e: AuditEntry, s: Session) => appendAudit(t.db, e, s, t.clock.now());

  // 15-Apr 10:00 IST onwards (fixed clock 04:30Z), one hour apart.
  add({ action: 'create', entityType: 'ledger', entityId: 10, entityGuid: 'g-10', entityLabel: 'Acme Traders', after: { name: 'Acme Traders', gstin: null, openingBalance: 0 } }, ravi); // #1
  t.clock.advance(HOUR);
  add({ action: 'alter', entityType: 'ledger', entityId: 10, entityGuid: 'g-10', entityLabel: 'Acme Traders', before: { name: 'Acme Traders', gstin: null, openingBalance: 0, updated_at: 'a' }, after: { name: 'Acme Traders', gstin: '27AAPFU0939F1ZV', openingBalance: 500000, updated_at: 'b' } }, ravi); // #2
  t.clock.advance(HOUR);
  add({ action: 'create', entityType: 'voucher', entityId: 1, entityGuid: 'v-1', entityLabel: 'Sales 1 — 100% paid', after: { number: '1', lines: [{ ledgerId: 10, amount: 118000 }, { ledgerId: 20, amount: -118000 }] } }, sita); // #3
  t.clock.setToday('2026-04-16');
  add({ action: 'alter', entityType: 'voucher', entityId: 1, entityGuid: 'v-1', entityLabel: 'Sales 1 — 100% paid', before: { number: '1', lines: [{ ledgerId: 10, amount: 118000 }, { ledgerId: 20, amount: -118000 }] }, after: { number: '1', narration: 'Corrected', lines: [{ ledgerId: 10, amount: 236000 }, { ledgerId: 20, amount: -236000 }] } }, ravi); // #4
  t.clock.advance(HOUR);
  add({ action: 'delete', entityType: 'ledger', entityId: 10, entityGuid: 'g-10', entityLabel: 'Acme Traders', before: { name: 'Acme Traders' } }, ravi); // #5
  t.clock.setToday('2026-04-17');
  add({ action: 'login_failed', entityType: 'user', entityId: 3, entityLabel: 'sita', after: { reason: 'wrong_password', attempts: 2 } }, sita); // #6 (user_id recorded for the test)
  add({ action: 'create', entityType: 'ledger', entityId: 10, entityGuid: 'g-10b', entityLabel: '=HYPERLINK("http://evil.example","Click")', after: { name: '=HYPERLINK("http://evil.example","Click")' } }, sita); // #7 (id 10 reused)
  return { t, ravi, sita };
}

const list = (t: TestCompany, input: object = {}) => t.callOk<AuditListResult>(R, 'security.audit.list', input);
const ids = (r: AuditListResult) => r.rows.map((x) => x.id);

describe('edit log: list', () => {
  it('lists newest first with readable summaries and total', async () => {
    const { t } = seeded();
    const r = await list(t);
    assert.equal(r.total, 7);
    assert.deepEqual(ids(r), [7, 6, 5, 4, 3, 2, 1]);
    const byId = new Map(r.rows.map((x) => [x.id, x]));
    assert.equal(byId.get(1)?.summary, 'Created ledger');
    assert.equal(byId.get(2)?.summary, 'Changed 2 fields: gstin, openingBalance', 'updated_at ignored');
    // Stored JSON is canonical (keys sorted), so paths come in alphabetical key order.
    assert.equal(byId.get(4)?.summary, 'Changed 3 fields: lines[0].amount, lines[1].amount, narration');
    assert.equal(byId.get(5)?.summary, 'Deleted ledger');
    assert.equal(byId.get(6)?.summary, 'Failed login: wrong password (attempt 2)');
    assert.equal(byId.get(3)?.entityTypeLabel, 'Voucher');
    assert.equal(byId.get(3)?.username, 'sita');
    t.close();
  });

  it('filters by action(s), user, record and search (wildcards literal)', async () => {
    const { t } = seeded();
    assert.deepEqual(ids(await list(t, { actions: ['alter'] })), [4, 2]);
    assert.deepEqual(ids(await list(t, { actions: ['create', 'delete'] })), [7, 5, 3, 1]);
    assert.deepEqual(ids(await list(t, { userId: 3 })), [7, 6, 3]);
    assert.deepEqual(ids(await list(t, { entityType: 'voucher', entityId: 1 })), [4, 3]);
    assert.deepEqual(ids(await list(t, { entityType: 'ledger' })), [7, 5, 2, 1]);
    assert.deepEqual(ids(await list(t, { search: 'acme' })), [5, 2, 1]);
    assert.deepEqual(ids(await list(t, { search: '100%' })), [4, 3], "'%' matches itself only");
    assert.deepEqual(ids(await list(t, { search: '_' })), [6], "'_' matches login_failed only");
    assert.deepEqual(ids(await list(t, { search: 'RAVI' })), [5, 4, 2, 1], 'username, case-insensitive');
    t.close();
  });

  it('filters by local calendar dates (inclusive) and pages with a stable total', async () => {
    const { t } = seeded();
    assert.deepEqual(ids(await list(t, { from: '2026-04-16', to: '2026-04-16' })), [5, 4]);
    assert.deepEqual(ids(await list(t, { from: '2026-04-16' })), [7, 6, 5, 4]);
    assert.deepEqual(ids(await list(t, { to: '2026-04-15' })), [3, 2, 1]);
    // Local midnight boundaries: an entry exactly at local midnight of the 16th belongs to the 16th.
    appendAudit(t.db, { action: 'settings', entityType: 'company_config', entityLabel: 'Configuration (F12)' }, null, new Date(localDayStartIso('2026-04-16'))); // #8
    assert.deepEqual(ids(await list(t, { from: '2026-04-16', to: '2026-04-16' })), [8, 5, 4]);
    assert.deepEqual(ids(await list(t, { to: '2026-04-15' })), [3, 2, 1]);

    const p1 = await list(t, { limit: 3, offset: 0 });
    const p2 = await list(t, { limit: 3, offset: 3 });
    const p3 = await list(t, { limit: 3, offset: 6, order: 'desc' });
    assert.equal(p1.total, 8);
    assert.deepEqual([...ids(p1), ...ids(p2), ...ids(p3)], [8, 7, 6, 5, 4, 3, 2, 1]);
    assert.deepEqual(ids(await list(t, { limit: 2, order: 'asc' })), [1, 2]);

    const bad = await t.call(R, 'security.audit.list', { limit: 501 });
    assert.equal(bad.ok ? null : bad.error.code, 'VALIDATION');
    const backwards = await t.call(R, 'security.audit.list', { from: '2026-04-17', to: '2026-04-16' });
    assert.equal(backwards.ok ? null : backwards.error.code, 'BUSINESS_RULE');

    // A misspelt filter (`action` for `actions`) is refused — even with lenient (production) route input —
    // instead of returning the unfiltered edit log.
    setStrictRouteInput(false);
    try {
      const typo = await t.call(R, 'security.audit.list', { entityType: 'voucher', action: 'delete' });
      assert.deepEqual(typo.ok ? null : typo.error.details, [{ path: 'action', message: 'Unknown field "action" — did you mean "actions"?' }]);
      const exp = await t.call(R, 'security.audit.export', { format: 'csv', user: 1 });
      assert.equal(exp.ok ? null : exp.error.code, 'VALIDATION');
    } finally {
      setStrictRouteInput(true);
    }
    t.close();
  });

  it('offers filter facets (record types, users, actions, span)', async () => {
    const { t } = seeded();
    const f = await t.callOk<AuditFacets>(R, 'security.audit.facets');
    assert.deepEqual(f.entityTypes.map((e) => `${e.label}:${e.count}`), ['Ledger:4', 'User:1', 'Voucher:2']);
    assert.deepEqual(f.users.map((u) => `${u.username}:${u.count}`), ['ravi:4', 'sita:3']);
    assert.equal(f.actions.find((a) => a.value === 'create')?.count, 3);
    assert.ok(f.firstTs && f.lastTs && f.firstTs < f.lastTs);
    t.close();
  });
});

describe('edit log: XML data entries recorded before the rename', () => {
  it('labels the legacy entity type exactly like the current one, without rewriting the row', async () => {
    const t = createTestCompany({ security: true, today: '2026-04-15' });
    const s = t.sessionAs({ role: 'Accountant', username: 'ravi', userId: 2 });
    appendAudit(t.db, { action: 'export', entityType: LEGACY_XML_DATA_KIND, entityLabel: 'masters', after: { masters: 3 } }, s, t.clock.now());
    appendAudit(t.db, { action: 'export', entityType: 'xml_data', entityLabel: 'masters', after: { masters: 3 } }, s, t.clock.now());
    assert.notEqual(LEGACY_XML_DATA_KIND, 'xml_data');
    assert.equal(entityTypeLabel(LEGACY_XML_DATA_KIND), 'XML data');
    assert.equal(entityTypeLabel('xml_data'), 'XML data');
    const r = await list(t);
    assert.deepEqual(r.rows.map((x) => x.entityTypeLabel), ['XML data', 'XML data']);
    // The append-only row keeps what was recorded; only its label is shared.
    assert.equal(t.db.value(`SELECT COUNT(*) FROM audit_log WHERE entity_type = :k`, { k: LEGACY_XML_DATA_KIND }), 1);
    // One record type in the filter list (counts added up), and filtering by it finds both rows.
    const f = await t.callOk<{ entityTypes: Array<{ value: string; label: string; count: number }> }>(R, 'security.audit.facets', {});
    assert.deepEqual(
      f.entityTypes.filter((e) => e.label === 'XML data').map((e) => [e.value, e.count]),
      [['xml_data', 2]],
    );
    assert.equal((await list(t, { entityType: 'xml_data' })).total, 2);
    assert.equal((await list(t, { entityType: LEGACY_XML_DATA_KIND })).total, 1, 'the stored value itself still filters exactly');
    assert.deepEqual(entityTypesMatching('xml_data'), ['xml_data', LEGACY_XML_DATA_KIND]);
    assert.deepEqual(entityTypesMatching('voucher'), ['voucher']);
    t.close();
  });
});

describe('edit log: detail, history, verification', () => {
  it('returns one entry with parsed before/after and a field-level diff', async () => {
    const { t } = seeded();
    const e = await t.callOk<AuditEntryDetail>(R, 'security.audit.get', { id: 4 });
    assert.equal(e.action, 'alter');
    assert.deepEqual(e.changes, [
      { path: 'lines[0].amount', kind: 'changed', before: 118000, after: 236000 },
      { path: 'lines[1].amount', kind: 'changed', before: -118000, after: -236000 },
      { path: 'narration', kind: 'added', before: null, after: 'Corrected' },
    ]);
    assert.equal(e.changesTruncated, false);
    assert.equal((e.after as { narration: string }).narration, 'Corrected');
    assert.match(e.hash, /^[0-9a-f]{64}$/);

    const created = await t.callOk<AuditEntryDetail>(R, 'security.audit.get', { id: 1 });
    assert.deepEqual(created.changes.map((c) => `${c.kind}:${c.path}`), ['added:gstin', 'added:name', 'added:openingBalance']);
    const missing = await t.call(R, 'security.audit.get', { id: 99 });
    assert.equal(missing.ok ? null : missing.error.code, 'NOT_FOUND');
    t.close();
  });

  it('shows the history of one record oldest first, optionally per record guid', async () => {
    const { t } = seeded();
    const h = await t.callOk<AuditEntityHistory>(R, 'security.audit.entityHistory', { entityType: 'ledger', entityId: 10 });
    assert.deepEqual(h.versions.map((v) => `${v.id}:${v.action}`), ['1:create', '2:alter', '5:delete', '7:create']);
    assert.equal(h.entityTypeLabel, 'Ledger');
    assert.equal(h.currentLabel, '=HYPERLINK("http://evil.example","Click")');
    assert.deepEqual(h.versions[1].changes.map((c) => c.path), ['gstin', 'openingBalance']);
    assert.equal(h.truncated, false);
    // The id was reused by a different ledger after deletion: the guid separates them.
    const first = await t.callOk<AuditEntityHistory>(R, 'security.audit.entityHistory', { entityType: 'ledger', entityId: 10, entityGuid: 'g-10' });
    assert.deepEqual(first.versions.map((v) => v.id), [1, 2, 5]);
    const voucher = await t.callOk<AuditEntityHistory>(R, 'security.audit.entityHistory', { entityType: 'voucher', entityId: 1 });
    assert.deepEqual(voucher.versions.map((v) => v.username), ['sita', 'ravi'], 'who changed this invoice');
    t.close();
  });

  it('verifies an intact chain with a plain-language verdict', async () => {
    const { t } = seeded();
    const v = await t.callOk<AuditVerifyReport>(R, 'security.audit.verify');
    assert.equal(v.ok, true);
    assert.equal(v.count, 7);
    assert.equal(v.totalEntries, 7);
    assert.equal(v.lastEntryId, 7);
    assert.match(v.message, /all 7 entries are intact/);
    assert.match(v.detail, /no entry has been altered, inserted or removed in between/);
    assert.equal(v.anchor, undefined, 'no check-point store in the test fixture');
    const empty = createTestCompany({ security: true });
    assert.match((await empty.callOk<AuditVerifyReport>(R, 'security.audit.verify')).message, /empty/);
    empty.close();
    t.close();
  });

  it('reports tampering: an altered entry, and a deleted entry (triggers dropped to simulate raw file edits)', async () => {
    const { t } = seeded();
    t.db.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
    t.db.run(`UPDATE audit_log SET after_json = replace(after_json, '500000', '5000') WHERE id = 2`);
    let v = await t.callOk<AuditVerifyReport>(R, 'security.audit.verify');
    assert.equal(v.ok, false);
    assert.equal(v.brokenAtId, 2);
    assert.equal(v.reason, 'hash_mismatch');
    assert.equal(v.count, 1);
    assert.match(v.message, /tampered with: entry #2 \(15-Apr-2026 \d\d:\d\d\) was changed after it was recorded/);
    assert.match(v.detail, /1 earlier entry is intact/);

    // A fresh copy of the log with one entry removed instead.
    const s = seeded();
    s.t.db.exec('DROP TRIGGER audit_log_no_delete;');
    s.t.db.run('DELETE FROM audit_log WHERE id = 3');
    v = await s.t.callOk<AuditVerifyReport>(R, 'security.audit.verify');
    assert.equal(v.ok, false);
    assert.equal(v.brokenAtId, 4);
    assert.equal(v.reason, 'prev_hash_mismatch');
    assert.match(v.message, /removed, inserted or changed/);
    s.t.close();
    t.close();
  });
});

describe('edit log: export', () => {
  it('exports a readable Excel file; formulas stay inert text; the export is itself logged', async () => {
    const { t } = seeded();
    const out = await t.callOk<AuditExportResult>(R, 'security.audit.export', { format: 'xlsx', from: '2026-04-15', to: '2026-04-17' });
    assert.equal(out.rowCount, 7);
    assert.match(out.fileName, /^Edit log - Test Traders Pvt Ltd - 2026-04-15 to 2026-04-17\.xlsx$/);
    assert.equal(out.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const sheet = readXlsx(out.bytes).sheets[0];
    assert.equal(sheet.name, 'Edit log');
    assert.equal(sheet.rows[0][0], 'Test Traders Pvt Ltd');
    assert.match(String(sheet.rows[3][0]), /Hash chain verified: intact \(7 entries\)/);
    const header = sheet.rows[5];
    assert.deepEqual(header.slice(0, 5), ['Entry #', 'Date', 'Time', 'User', 'Action']);
    const data = sheet.rows.slice(6);
    assert.equal(data.length, 7);
    assert.deepEqual(data[0].slice(0, 2), [1, '2026-04-15']);
    const alter4 = data.find((r) => r[0] === 4);
    assert.match(String(alter4?.[9]), /lines\[0\]\.amount: 118000 → 236000/);
    const evil = data.find((r) => r[0] === 7);
    assert.equal(evil?.[7], '=HYPERLINK("http://evil.example","Click")', 'kept verbatim as text');
    // Text is only ever a shared string — never a formula cell.
    const xml = readZip(out.bytes).readText('xl/worksheets/sheet1.xml');
    assert.doesNotMatch(xml, /<f[ >]/);

    const logged = t.db.get<{ action: string; entity_type: string; entity_label: string; after_json: string }>('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1');
    assert.equal(logged?.action, 'export');
    assert.equal(logged?.entity_type, 'audit_log');
    assert.equal(logged?.entity_label, 'Edit log exported (XLSX, 7 entries)');
    assert.equal(JSON.parse(logged?.after_json ?? '{}').rowCount, 7);
    t.close();
  });

  it('exports CSV with formula injection neutralised and respects filters', async () => {
    const { t } = seeded();
    const out = await t.callOk<AuditExportResult>(R, 'security.audit.export', { format: 'csv', entityType: 'ledger' });
    assert.equal(out.rowCount, 4);
    assert.match(out.fileName, /\.csv$/);
    const { text, bom } = decodeText(out.bytes);
    assert.equal(bom, true, 'BOM so Excel reads UTF-8 (₹, —)');
    const rows = parseCsv(text);
    assert.equal(rows[0][0], 'Entry #');
    assert.equal(rows.length, 5);
    const evil = rows.find((r) => r[0] === '7');
    assert.equal(evil?.[7], `'=HYPERLINK("http://evil.example","Click")`);
    t.close();
  });

  it('requires both audit.view and data.export', async () => {
    const { t } = seeded();
    const viewer = t.sessionAs({ permissions: ['audit.view'] });
    const r = await t.call(R, 'security.audit.export', { format: 'xlsx' }, { session: viewer });
    assert.equal(r.ok ? null : r.error.code, 'FORBIDDEN');
    assert.match(r.ok ? '' : r.error.message, /Export data/);
    const exporter = t.sessionAs({ permissions: ['data.export'] });
    const r2 = await t.call(R, 'security.audit.export', { format: 'xlsx' }, { session: exporter });
    assert.equal(r2.ok ? null : r2.error.code, 'FORBIDDEN');
    // The Auditor role has both.
    const ok = await t.callOk<AuditExportResult>(R, 'security.audit.export', { format: 'csv' }, { session: t.sessionAs({ role: 'Auditor' }) });
    assert.equal(ok.rowCount, 7);
    t.close();
  });
});
