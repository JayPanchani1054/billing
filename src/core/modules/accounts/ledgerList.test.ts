import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { ChartNode } from '../../../shared/types/accounts.ts';
import { createTestCompany, makeGstin, testPan, type TestCompany } from '../../testing/fixtures.ts';
import { chartOfAccounts } from './chart.ts';
import { saveGroup } from './groups.ts';
import { ledgerPicker, listLedgers, saveLedger } from './ledgers.ts';
import { postRaw } from './testkit.ts';

describe('ledger list', () => {
  let t: TestCompany;
  let acme: number;
  let beta: number;
  let hdfc: number;
  let westGroup: number;
  before(() => {
    t = createTestCompany();
    westGroup = saveGroup(t.ctx, { name: 'West Zone', parentId: t.ids.groups.SUNDRY_DEBTORS }).id;
    acme = saveLedger(t.ctx, { name: 'Acme Traders', alias: 'ACM', groupId: westGroup, gstin: makeGstin('27'), openingBalance: 50000 }).id;
    beta = saveLedger(t.ctx, { name: 'Beta Stores', groupId: t.ids.groups.SUNDRY_DEBTORS }).id;
    saveLedger(t.ctx, { name: 'Gamma 100% Supplies', groupId: t.ids.groups.SUNDRY_CREDITORS });
    hdfc = saveLedger(t.ctx, { name: 'HDFC Bank', groupId: t.ids.groups.BANK_ACCOUNTS }).id;
    saveLedger(t.ctx, { id: beta, isActive: false });
    postRaw(t, { date: '2026-04-02', lines: [[acme, 10000], [t.ids.ledgers.SALES, -10000]] });
    postRaw(t, { date: '2026-04-10', lines: [[hdfc, 25000], [acme, -25000]] });
  });
  after(() => t.close());

  it('searches name, alias and GSTIN (LIKE wildcards are literal)', () => {
    assert.deepEqual(
      listLedgers(t.db, { search: 'acm' }, t.today).rows.map((r) => r.name),
      ['Acme Traders'],
    );
    assert.deepEqual(
      listLedgers(t.db, { search: makeGstin('27').slice(2, 8) }, t.today).rows.map((r) => r.name),
      ['Acme Traders'],
    );
    assert.deepEqual(
      listLedgers(t.db, { search: '100%' }, t.today).rows.map((r) => r.name),
      ['Gamma 100% Supplies'],
    );
    assert.equal(listLedgers(t.db, { search: '%' }, t.today).total, 1);
  });

  it('filters by class, by group (with or without sub-groups) and by active state', () => {
    const debtors = listLedgers(t.db, { classes: ['debtor'] }, t.today);
    assert.deepEqual(
      debtors.rows.map((r) => r.name),
      ['Acme Traders', 'Beta Stores'],
    );
    assert.deepEqual(
      listLedgers(t.db, { classes: ['debtor'], activeOnly: true }, t.today).rows.map((r) => r.name),
      ['Acme Traders'],
    );
    assert.deepEqual(
      listLedgers(t.db, { classes: ['cash_bank'] }, t.today).rows.map((r) => r.name),
      ['Cash', 'HDFC Bank'],
    );
    assert.deepEqual(
      listLedgers(t.db, { groupIds: [t.ids.groups.SUNDRY_DEBTORS] }, t.today).rows.map((r) => r.name),
      ['Acme Traders', 'Beta Stores'],
    );
    assert.deepEqual(
      listLedgers(t.db, { groupIds: [t.ids.groups.SUNDRY_DEBTORS], includeSubgroups: false }, t.today).rows.map((r) => r.name),
      ['Beta Stores'],
    );
    // Class AND group: creditors inside Sundry Debtors → nothing.
    assert.deepEqual(listLedgers(t.db, { groupIds: [t.ids.groups.SUNDRY_DEBTORS], classes: ['creditor'] }, t.today), { rows: [], total: 0 });
    const row = debtors.rows[0];
    assert.equal(row.groupName, 'West Zone');
    assert.equal(row.primaryGroupCode, 'CURRENT_ASSETS');
    assert.deepEqual(row.classes, ['party', 'debtor', 'asset']);
    assert.equal(row.closingBalance, undefined);
  });

  it('pages with limit/offset and returns the total', () => {
    const all = listLedgers(t.db, {}, t.today);
    const page = listLedgers(t.db, { limit: 2, offset: 2 }, t.today);
    assert.equal(page.total, all.total);
    assert.deepEqual(
      page.rows.map((r) => r.id),
      all.rows.slice(2, 4).map((r) => r.id),
    );
  });

  it('adds closing balances as of a date', () => {
    const now = listLedgers(t.db, { classes: ['debtor'], withBalance: true }, t.today);
    // Acme: 500.00 opening + 100.00 − 250.00 = 350.00 Dr
    assert.equal(now.rows.find((r) => r.id === acme)?.closingBalance, 35000);
    const early = listLedgers(t.db, { classes: ['debtor'], withBalance: true, asOf: '2026-04-05' }, t.today);
    assert.equal(early.rows.find((r) => r.id === acme)?.closingBalance, 60000);
  });

  it('picker: compact rows with balances, active ledgers only unless asked', () => {
    const rows = ledgerPicker(t.db, { classes: ['party'] }, t.today);
    assert.deepEqual(
      rows.map((r) => r.name),
      ['Acme Traders', 'Gamma 100% Supplies'],
    );
    const a = rows[0];
    assert.deepEqual(
      { balance: a.balance, gstin: a.gstin, stateCode: a.stateCode, groupName: a.groupName, alias: a.alias, billWise: a.billWise },
      { balance: 35000, gstin: makeGstin('27'), stateCode: '27', groupName: 'West Zone', alias: 'ACM', billWise: true },
    );
    assert.equal(ledgerPicker(t.db, { classes: ['party'], includeInactive: true }, t.today).length, 3);
    assert.deepEqual(
      ledgerPicker(t.db, { classes: ['bank'] }, t.today).map((r) => [r.name, r.balance]),
      [['HDFC Bank', 25000]],
    );
    assert.equal(ledgerPicker(t.db, { classes: ['bank'], asOf: '2026-04-05' }, t.today)[0].balance, 0);
  });
});

describe('ledger picker performance', () => {
  it('returns 10,000 ledgers with balances in under 300 ms', () => {
    const t = createTestCompany();
    const ts = t.clock.now().toISOString();
    t.db.transaction(() => {
      const ids: number[] = [];
      for (let i = 1; i <= 10_000; i++) {
        const group = i % 3 === 0 ? t.ids.groups.SUNDRY_CREDITORS : t.ids.groups.SUNDRY_DEBTORS;
        ids.push(
          t.db.run(
            `INSERT INTO ledgers (guid, name, group_id, opening_balance, gstin, state_code, gst_registration_type, maintain_bill_wise, created_at, updated_at)
             VALUES (:g, :n, :grp, :ob, :gstin, '27', 'regular', 1, :ts, :ts)`,
            { g: randomUUID(), n: `Party ${String(i).padStart(5, '0')}`, grp: group, ob: i * 100, gstin: makeGstin('27', testPan(i)), ts },
          ).lastInsertRowid,
        );
      }
      // 15,000 vouchers / 30,000 entries spread over the parties.
      const vt = t.ids.voucherTypes.journal;
      for (let v = 0; v < 15_000; v++) {
        const vid = t.db.run(
          `INSERT INTO vouchers (guid, voucher_type_id, base_type, date, created_at, updated_at) VALUES (:g, :vt, 'journal', :d, :ts, :ts)`,
          { g: randomUUID(), vt, d: '2026-04-05', ts },
        ).lastInsertRowid;
        const entry = `INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, date) VALUES (:v, :n, :l, :a, '2026-04-05')`;
        t.db.run(entry, { v: vid, n: 1, l: ids[v % 10_000], a: 1000 });
        t.db.run(entry, { v: vid, n: 2, l: t.ids.ledgers.SALES, a: -1000 });
      }
    });
    ledgerPicker(t.db, { classes: ['party'] }, t.today); // warm-up (statement cache)
    const started = performance.now();
    const rows = ledgerPicker(t.db, { classes: ['party'] }, t.today);
    const ms = performance.now() - started;
    assert.equal(rows.length, 10_000);
    // Party 00001: opening 1.00 + two entries of 10.00 (vouchers 0 and 10,000) = 21.00 Dr
    assert.equal(rows[0].name, 'Party 00001');
    assert.equal(rows[0].balance, 100 + 2000);
    assert.ok(ms < 300, `picker took ${ms.toFixed(1)} ms`);
    t.close();
  });
});

describe('chart of accounts', () => {
  it('nests groups, sub-groups and ledgers with rolled-up closing balances', () => {
    const t = createTestCompany();
    const west = saveGroup(t.ctx, { name: 'West Zone', parentId: t.ids.groups.SUNDRY_DEBTORS });
    const acme = saveLedger(t.ctx, { name: 'Acme Traders', groupId: west.id }).id;
    const zeta = saveLedger(t.ctx, { name: 'Zeta Retail', groupId: t.ids.groups.SUNDRY_DEBTORS }).id;
    saveLedger(t.ctx, { name: 'Old Party', groupId: t.ids.groups.SUNDRY_DEBTORS, isActive: false });
    postRaw(t, { date: '2026-04-02', lines: [[acme, 118000], [t.ids.ledgers.SALES, -100000], [t.ids.ledgers.OUTPUT_IGST, -18000]] });
    postRaw(t, { date: '2026-04-03', lines: [[zeta, 20000], [t.ids.ledgers.SALES, -20000]] });
    postRaw(t, { date: '2026-04-20', lines: [[zeta, 5000], [t.ids.ledgers.SALES, -5000]] });

    const chart = chartOfAccounts(t.db, {}, t.today);
    assert.equal(chart.asOf, '2026-04-15');
    assert.equal(chart.roots.length, 15);
    const find = (nodes: ChartNode[], name: string): ChartNode | undefined => {
      for (const n of nodes) {
        if (n.name === name) return n;
        const hit = find(n.children, name);
        if (hit) return hit;
      }
      return undefined;
    };
    const debtors = find(chart.roots, 'Sundry Debtors');
    assert.ok(debtors);
    // Sub-groups first, then ledgers by name.
    assert.deepEqual(
      debtors.children.map((c) => [c.kind, c.name]),
      [
        ['group', 'West Zone'],
        ['ledger', 'Old Party'],
        ['ledger', 'Zeta Retail'],
      ],
    );
    // 1,180.00 + 200.00 (the 20-Apr sale is after the as-of date)
    assert.equal(debtors.closing, 138000);
    assert.equal(find(chart.roots, 'West Zone')?.closing, 118000);
    assert.equal(find(chart.roots, 'Sales Accounts')?.closing, -120000);
    assert.equal(chart.totalDebit, 138000);
    assert.equal(chart.totalCredit, 138000);

    const later = chartOfAccounts(t.db, { asOf: '2026-04-30', activeOnly: true }, t.today);
    assert.equal(find(later.roots, 'Zeta Retail')?.closing, 25000);
    assert.equal(find(later.roots, 'Old Party'), undefined);
    const groupsOnly = chartOfAccounts(t.db, { includeLedgers: false }, t.today);
    assert.equal(groupsOnly.ledgerCount, 0);
    assert.equal(find(groupsOnly.roots, 'Cash'), undefined);
    assert.equal(find(groupsOnly.roots, 'Sundry Debtors')?.closing, 138000);
    t.close();
  });
});
