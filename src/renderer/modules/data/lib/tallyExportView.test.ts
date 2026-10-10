import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openingsDate, openingsNote, tallyExportProblem, tallyExportSummary, tallyImportSteps } from './tallyExportView.ts';

describe('tallyExportView', () => {
  it('says what is missing before exporting', () => {
    assert.equal(tallyExportProblem({ masters: false, vouchers: false, from: null, to: null }), 'Tick masters, vouchers or both.');
    assert.equal(tallyExportProblem({ masters: true, vouchers: false, from: null, to: null }), null); // masters need no period
    assert.equal(tallyExportProblem({ masters: false, vouchers: true, from: '2026-04-01', to: null }), 'Enter both dates of the period.');
    assert.equal(tallyExportProblem({ masters: true, vouchers: true, from: '2026-05-01', to: '2026-04-01' }), 'The “from” date is after the “to” date.');
    assert.equal(tallyExportProblem({ masters: true, vouchers: true, from: '2026-04-01', to: '2027-03-31' }), null);
  });

  it('summarises non-zero masters, vouchers and what was left out', () => {
    const rows = tallyExportSummary(
      {
        masters: { groups: 2, ledgers: 1250, units: 0, godowns: 1, stockGroups: 0, stockCategories: 0, stockItems: 40, costCategories: 0, costCentres: 3, voucherTypes: 0 },
        vouchers: 12345,
        skipped: [{ reason: 'Quotations and proforma invoices (Tally has no such voucher type)', count: 4 }],
      },
      true,
    );
    assert.deepEqual(
      rows.map((r) => [r.label, r.value]),
      [
        ['Groups (your own)', '2'],
        ['Ledgers', '1,250'],
        ['Cost centres', '3'],
        ['Godowns', '1'],
        ['Stock items', '40'],
        ['Vouchers', '12,345'],
        ['Not exported: Quotations and proforma invoices (Tally has no such voucher type)', '4'],
      ],
    );
    assert.deepEqual(tallyExportSummary({ masters: null, vouchers: 0, skipped: [] }, false), []);
  });

  it('openings: the period start when later vouchers go with the masters, else the books beginning', () => {
    const c = { masters: true, vouchers: true, from: '2026-04-01', to: '2027-03-31' };
    assert.equal(openingsDate(c, '2024-04-01'), '2026-04-01');
    assert.match(openingsNote(c, '2024-04-01') ?? '', /as on 01-Apr-2026 \(the start of the period\)/);
    assert.equal(openingsDate({ ...c, vouchers: false }, '2024-04-01'), '2024-04-01');
    assert.equal(openingsDate({ ...c, from: '2024-04-01' }, '2024-04-01'), '2024-04-01');
    assert.match(openingsNote({ ...c, from: '2023-04-01' }, '2024-04-01') ?? '', /books beginning \(01-Apr-2024\)/);
    assert.equal(openingsDate({ ...c, masters: false }, '2024-04-01'), null);
    const rows = tallyExportSummary({ masters: null, vouchers: 3, skipped: [], openingsAsOf: '2026-10-01' }, true);
    assert.deepEqual(rows[0], { key: 'openings', label: 'Opening balances as on', value: '01-Oct-2026' });
    assert.match(tallyImportSteps(true, '2026-10-01').join(' '), /books beginning on 01-Oct-2026/);
  });

  it('import steps mention extracting only for the ZIP', () => {
    assert.match(tallyImportSteps(true)[0], /Extract/);
    assert.doesNotMatch(tallyImportSteps(false).join(' '), /Extract/);
    assert.match(tallyImportSteps(false).join(' '), /Import › Masters/);
  });
});
