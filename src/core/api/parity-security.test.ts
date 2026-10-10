/**
 * Security review of the parity-wave routes (tds, documents, mfg, forex, cheques, attachments, print
 * sharing, POS, XML data export, GST plus): access declarations, permission names and roles, and strict
 * filters. Statically over the real route table, so a route added later is covered too.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from '../../shared/constants.ts';
import { AppError } from '../lib/errors.ts';
import { parse } from '../lib/validate.ts';
import { routes } from './routes.ts';

const PARITY_PREFIXES = ['tds.', 'documents.', 'mfg.', 'forex.', 'cheques.', 'attachments.', 'print.share.', 'pos.', 'data.xmlExport.create'];
const parity = Object.entries(routes).filter(([name]) => PARITY_PREFIXES.some((p) => name.startsWith(p)));

/** Routes whose access is 'authenticated' because the service checks the OWNER's view permission. */
const OWNER_CHECKED = new Set(['attachments.list', 'attachments.counts', 'attachments.read', 'attachments.register']);

/** Report / list filters whose misspelt optional key would silently widen the result. */
const STRICT_FILTERS = [
  'cheques.register',
  'cheques.epayment.list',
  'cheques.payee.list',
  'cheques.book.list',
  'attachments.register',
  'mfg.production.register',
  'mfg.jobWork.pending',
  'mfg.jobWorkOrder.list',
  'mfg.bom.list',
  'mfg.jobWork.alerts',
  'documents.recurring.due',
  'gst.amendments.list',
  'gst.gstr3b.changes',
  'gst.rule37.report',
  'gst.advances.pending',
  'gst.filing.list',
  'tds.lines',
  'tds.return.data',
  'tds.return.export',
  'pos.register',
  'pos.summary',
];

describe('parity-wave routes: access', () => {
  it('are many (the scan is not empty)', () => {
    assert.ok(parity.length > 100, String(parity.length));
  });

  it('declare a real permission; only the owner-checked attachment reads use "authenticated"', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const [name, r] of parity) {
      assert.equal(r.scope, 'company', name);
      if (r.access === 'authenticated') assert.ok(OWNER_CHECKED.has(name), `${name} must declare a permission`);
      else assert.ok(known.has(r.access), `${name}: unknown permission ${r.access}`);
    }
  });

  it('a session with no view rights cannot read attachments through the "authenticated" routes', async () => {
    const { createTestCompany } = await import('../testing/fixtures.ts');
    const t = createTestCompany();
    try {
      const session = t.sessionAs({ permissions: ['company.view'] });
      const ledgerId = t.addLedger({ name: 'Supplier A', group: 'SUNDRY_CREDITORS' });
      const added = await t.call(routes, 'attachments.add', { entityType: 'ledger', entityId: ledgerId, fileName: 'bill.pdf', bytes: new TextEncoder().encode('%PDF-1.7\n') });
      assert.ok(added.ok, added.ok ? '' : added.error.message);
      const inputs: Record<string, unknown> = {
        'attachments.list': { entityType: 'ledger', entityId: ledgerId },
        'attachments.counts': { entityType: 'voucher', ids: [1] },
        'attachments.register': {},
        'attachments.read': { id: (added.data as { id: number }).id },
      };
      for (const [name, input] of Object.entries(inputs)) {
        const r = await t.call(routes, name, input, { session });
        assert.equal(r.ok ? 'ok' : r.error.code, 'FORBIDDEN', name);
      }
    } finally {
      t.close();
    }
  });
});

describe('parity-wave routes: strict filters', () => {
  for (const name of STRICT_FILTERS) {
    it(`${name} rejects an unknown key in production too`, () => {
      const r = (routes as Record<string, { input: Parameters<typeof parse>[0] }>)[name];
      assert.ok(r, name);
      assert.throws(
        () => parse(r.input, { bankLedgerId: 1, asOf: '2026-04-01', from: '2026-04-01', to: '2026-04-30', zzTypo: 1 }, { unknownKeys: 'strip' }),
        (e: unknown) => e instanceof AppError && e.code === 'VALIDATION' && JSON.stringify(e.details).includes('Unknown field'),
      );
    });
  }
});

describe('system roles and the parity-wave permissions', () => {
  const role = (n: string): ReadonlySet<Permission> => {
    const r = SYSTEM_ROLES.find((x) => x.name === n);
    assert.ok(r, n);
    return new Set(r.permissions === 'all' ? PERMISSIONS : r.permissions);
  };
  it('Auditor reads TDS but cannot change masters, file statements or touch attachments', () => {
    const a = role('Auditor');
    assert.ok(a.has('tds.view'));
    for (const p of ['tds.manage', 'tds.file', 'attachments.add', 'attachments.remove', 'vouchers.create', 'masters.alter', 'company.manage'] as const) {
      assert.equal(a.has(p), false, p);
    }
  });
  it('Data Entry may attach but not remove files, and has no TDS / export rights', () => {
    const d = role('Data Entry');
    assert.ok(d.has('attachments.add'));
    for (const p of ['attachments.remove', 'tds.view', 'tds.manage', 'tds.file', 'data.export'] as const) assert.equal(d.has(p), false, p);
  });
  it('Accountant holds every parity permission; only security.manage / data.restore stay with the Owner', () => {
    const acc = role('Accountant');
    for (const p of ['tds.view', 'tds.manage', 'tds.file', 'attachments.add', 'attachments.remove'] as const) assert.ok(acc.has(p), p);
    assert.deepEqual(PERMISSIONS.filter((p) => !acc.has(p)), ['data.restore', 'security.manage'].sort((x, y) => PERMISSIONS.indexOf(x as Permission) - PERMISSIONS.indexOf(y as Permission)));
  });
});
