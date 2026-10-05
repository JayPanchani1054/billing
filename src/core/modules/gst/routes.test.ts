/**
 * GST routes through the real dispatcher: wiring, permissions (gst.view / gst.file), validation,
 * audit of exports, periods list, and companies without GST.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ApiResult } from '../../../shared/api.ts';
import type {
  GstDocEvent,
  GstExceptionsResult,
  GstJsonFile,
  GstPeriodsResult,
  Gstr1SectionResult,
  Gstr1Summary,
  Gstr3bSummary,
  Gstr9Summary,
} from '../../../shared/types/gst-returns.ts';
import { writeSetting } from '../company/service.ts';
import { gstRoutes } from './routes.ts';
import { aprilDataset, setupParties, type Dataset } from './testkit.ts';

const code = (r: ApiResult<unknown>): string | null => (r.ok ? null : r.error.code);

describe('GST routes', () => {
  let ds: Dataset;
  before(() => {
    ds = aprilDataset();
  });
  after(() => ds.t.close());

  it('every route is registered with the right access level', () => {
    const access = Object.fromEntries(Object.entries(gstRoutes).map(([k, r]) => [k, r.access]));
    assert.deepEqual(access, {
      'gst.periods': 'gst.view',
      'gst.gstr1.summary': 'gst.view',
      'gst.gstr1.section': 'gst.view',
      'gst.gstr1.json': 'gst.file',
      'gst.gstr3b.summary': 'gst.view',
      'gst.gstr3b.saveAdjustments': 'gst.file',
      'gst.gstr3b.json': 'gst.file',
      'gst.hsnSummary': 'gst.view',
      'gst.register': 'gst.view',
      'gst.itc': 'gst.view',
      'gst.exceptions': 'gst.view',
      'gst.einvoice.pending': 'gst.view',
      'gst.einvoice.json': 'gst.file',
      'gst.einvoice.importResponse': 'gst.file',
      'gst.einvoice.markCancelled': 'gst.file',
      'gst.ewaybill.pending': 'gst.view',
      'gst.ewaybill.json': 'gst.file',
      'gst.ewaybill.update': 'gst.file',
      'gst.docEvents': 'gst.view',
      'gst.gstr9.summary': 'gst.view',
    });
    const writes = Object.entries(gstRoutes).filter(([, r]) => r.transactional !== false).map(([k]) => k);
    assert.deepEqual(writes.sort(), ['gst.einvoice.importResponse', 'gst.einvoice.markCancelled', 'gst.ewaybill.update', 'gst.gstr3b.saveAdjustments']);
  });

  it('periods: months from the books beginning with document counts, newest first', async () => {
    const p = await ds.t.callOk<GstPeriodsResult>(gstRoutes, 'gst.periods');
    assert.deepEqual(p.periods.map((x) => [x.key, x.outwardCount, x.inwardCount, x.isCurrent]), [
      ['052026', 0, 0, true],
      ['042026', 17, 9, false],
    ]);
    assert.deepEqual([p.filingFrequency, p.current, p.suggested], ['monthly', '052026', '042026']);
  });

  it('periods for a quarterly filer include quarters', async () => {
    const { t } = setupParties({ today: '2026-05-10' });
    writeSetting(t.db, 'config', { gst: { filingFrequency: 'quarterly' } }, t.clock.now());
    const p = await t.callOk<GstPeriodsResult>(gstRoutes, 'gst.periods');
    assert.deepEqual(p.periods.map((x) => x.key), ['2026-27-Q1', '052026', '042026']);
    assert.deepEqual([p.current, p.suggested, p.periods[0].fp, p.periods[0].label], ['2026-27-Q1', '2025-26-Q4', '062026', 'Q1 (Apr–Jun) 2026-27']);
    t.close();
  });

  it('read routes work for Data Entry and Auditor roles; file routes need gst.file', async () => {
    const dataEntry = ds.t.sessionAs({ role: 'Data Entry' });
    const auditor = ds.t.sessionAs({ role: 'Auditor' });
    const s = await ds.t.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period: '042026' }, { session: dataEntry });
    assert.equal(s.sections[0].count, 3);
    const sec = await ds.t.callOk<Gstr1SectionResult>(gstRoutes, 'gst.gstr1.section', { period: '042026', section: 'cdnur' }, { session: auditor });
    assert.deepEqual(sec.rows.map((r) => r.number), ['CN-2']);
    assert.equal(code(await ds.t.call(gstRoutes, 'gst.gstr1.json', { period: '042026' }, { session: dataEntry })), 'FORBIDDEN');
    assert.equal(code(await ds.t.call(gstRoutes, 'gst.gstr3b.json', { period: '042026' }, { session: auditor })), 'FORBIDDEN');
    assert.equal(code(await ds.t.call(gstRoutes, 'gst.gstr3b.saveAdjustments', { period: '042026', values: {} }, { session: dataEntry })), 'FORBIDDEN');
    assert.equal(code(await ds.t.call(gstRoutes, 'gst.einvoice.json', { voucherIds: [ds.V['S-1']] }, { session: auditor })), 'FORBIDDEN');
    assert.equal(code(await ds.t.call(gstRoutes, 'gst.ewaybill.update', { voucherId: ds.V['S-1'], ewayBillNo: '391000000001', date: '2026-04-02' }, { session: dataEntry })), 'FORBIDDEN');
    const noGst = ds.t.sessionAs({ permissions: ['vouchers.view', 'reports.view'] });
    assert.equal(code(await ds.t.call(gstRoutes, 'gst.periods', {}, { session: noGst })), 'FORBIDDEN');
    assert.equal(code(await ds.t.call(gstRoutes, 'gst.gstr9.summary', { fy: '2026-27' }, { session: noGst })), 'FORBIDDEN');
  });

  it('exports return the file and write an audit entry; 3B summary counts uncertain transactions', async () => {
    const before = Number(ds.t.db.value("SELECT COUNT(*) FROM audit_log WHERE action = 'export' AND entity_type = 'gst_return'"));
    const g1 = await ds.t.callOk<GstJsonFile>(gstRoutes, 'gst.gstr1.json', { period: '042026' });
    assert.match(g1.fileName, /^GSTR1_27AAPFU0939F1ZV_042026\.json$/);
    const g3 = await ds.t.callOk<GstJsonFile>(gstRoutes, 'gst.gstr3b.json', { period: '042026' });
    assert.equal((JSON.parse(g3.json) as { ret_period: string }).ret_period, '042026');
    const labels = ds.t.db.all<{ entity_label: string }>("SELECT entity_label FROM audit_log WHERE action = 'export' AND entity_type = 'gst_return' ORDER BY id").map((r) => r.entity_label);
    assert.equal(labels.length - before, 2);
    assert.deepEqual(labels.slice(-2), ['GSTR-1 Apr 2026 (GSTR1_27AAPFU0939F1ZV_042026.json)', 'GSTR-3B Apr 2026 (GSTR3B_27AAPFU0939F1ZV_042026.json)']);
    const s = await ds.t.callOk<Gstr3bSummary>(gstRoutes, 'gst.gstr3b.summary', { period: '042026' });
    assert.deepEqual(s.issueCount, { errors: 2, warnings: 2 });
    const saved = await ds.t.callOk<Gstr3bSummary>(gstRoutes, 'gst.gstr3b.saveAdjustments', { period: '042026', values: { interest: { igst: 500 } } });
    assert.equal(saved.interest.igst, 500);
    assert.equal(saved.adjustmentsUpdatedAt !== null, true);
  });

  it('validates inputs with accountant-friendly messages', async () => {
    const r1 = await ds.t.call(gstRoutes, 'gst.gstr1.json', { from: '2026-04-01', to: '2026-04-30' });
    assert.equal(code(r1), 'VALIDATION');
    const r2 = await ds.t.call(gstRoutes, 'gst.register', { from: '2026-04-30', to: '2026-04-01', kind: 'sales' });
    assert.equal(code(r2), 'VALIDATION');
    assert.equal(r2.ok ? '' : r2.error.message, 'The To date is before the From date');
    const r3 = await ds.t.call(gstRoutes, 'gst.gstr1.section', { period: '042026', section: 'b2z' });
    assert.equal(code(r3), 'VALIDATION');
    const r4 = await ds.t.call(gstRoutes, 'gst.gstr1.summary', {});
    assert.match(r4.ok ? '' : r4.error.message, /Choose a return period/);
    const r5 = await ds.t.call(gstRoutes, 'gst.gstr9.summary', { fy: '2026-28' });
    assert.match(r5.ok ? '' : r5.error.message, /not a financial year/);
  });

  it('remaining read routes respond', async () => {
    const ex = await ds.t.callOk<GstExceptionsResult>(gstRoutes, 'gst.exceptions', { from: '2026-04-01', to: '2026-04-30' });
    assert.equal(ex.counts.errors, 2);
    for (const [name, input] of [
      ['gst.hsnSummary', { from: '2026-04-01', to: '2026-04-30', direction: 'outward' }],
      ['gst.register', { from: '2026-04-01', to: '2026-04-30', kind: 'purchase' }],
      ['gst.itc', { from: '2026-04-01', to: '2026-04-30' }],
      ['gst.einvoice.pending', { from: '2026-04-01', to: '2026-04-30' }],
      ['gst.ewaybill.pending', { from: '2026-04-01', to: '2026-04-30' }],
    ] as const) {
      assert.equal(code(await ds.t.call(gstRoutes, name, input)), null, name);
    }
    const g9 = await ds.t.callOk<Gstr9Summary>(gstRoutes, 'gst.gstr9.summary', { fy: '2026-27' });
    assert.equal(g9.months.length, 12);
    const ev = await ds.t.callOk<GstDocEvent[]>(gstRoutes, 'gst.docEvents', { voucherId: ds.V['S-1'] });
    assert.deepEqual(ev, []);
  });

  it('companies without GST get a clear business-rule error', async () => {
    const { t } = setupParties({ gst: false });
    const r = await t.call(gstRoutes, 'gst.gstr1.summary', { period: '042026' });
    assert.equal(code(r), 'BUSINESS_RULE');
    assert.match(r.ok ? '' : r.error.message, /GST is turned off/);
    t.close();
  });
});
