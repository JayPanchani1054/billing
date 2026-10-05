import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createTestCompany, makeGstin, type TestCompany } from '../../testing/fixtures.ts';
import {
  BOOKS_FILTER,
  closingBalances,
  groupBalances,
  groupChain,
  groupCodeSet,
  groupDescendantIds,
  ledgerBalance,
  ledgerClass,
  ledgerClassNames,
  loadGroupTree,
  primaryGroup,
} from './books.ts';
import { saveGroup } from './groups.ts';
import { postRaw } from './testkit.ts';

describe('BOOKS_FILTER', () => {
  it('builds the books condition with and without an alias', () => {
    assert.equal(BOOKS_FILTER(), 'affects_books = 1 AND (is_post_dated = 0 OR date <= :today)');
    assert.equal(BOOKS_FILTER('le'), 'le.affects_books = 1 AND (le.is_post_dated = 0 OR le.date <= :today)');
  });

  it('rejects an alias that is not a plain identifier', () => {
    assert.throws(() => BOOKS_FILTER('le; DROP TABLE x'), /invalid table alias/);
  });
});

describe('group helpers', () => {
  let t: TestCompany;
  before(() => {
    t = createTestCompany();
  });
  after(() => t.close());

  it('groupChain runs from the primary group to the leaf; primaryGroup and groupCodeSet follow it', () => {
    const chain = groupChain(t.db, t.ids.groups.SUNDRY_DEBTORS);
    assert.deepEqual(
      chain.map((g) => g.name),
      ['Current Assets', 'Sundry Debtors'],
    );
    assert.equal(primaryGroup(t.db, t.ids.groups.BANK_OD).reservedCode, 'LOANS_LIABILITY');
    assert.deepEqual([...groupCodeSet(t.db, t.ids.groups.DUTIES_TAXES)].sort(), ['CURRENT_LIABILITIES', 'DUTIES_TAXES']);
    assert.throws(() => groupChain(t.db, 99_999), /Group not found/);
  });

  it('groupDescendantIds includes the group itself and nested custom sub-groups', () => {
    const region = saveGroup(t.ctx, { name: 'Debtors - West', parentId: t.ids.groups.SUNDRY_DEBTORS });
    const city = saveGroup(t.ctx, { name: 'Debtors - Pune', parentId: region.id });
    const ids = groupDescendantIds(t.db, t.ids.groups.CURRENT_ASSETS);
    for (const id of [t.ids.groups.CURRENT_ASSETS, t.ids.groups.SUNDRY_DEBTORS, t.ids.groups.BANK_ACCOUNTS, region.id, city.id]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    assert.ok(!ids.includes(t.ids.groups.FIXED_ASSETS));
    assert.deepEqual(groupDescendantIds(t.db, 99_999), []);
    // Ledgers under a nested custom group are still debtors.
    const l = t.addLedger({ name: 'Pune Customer', group: 'SUNDRY_DEBTORS', columns: { group_id: city.id } });
    const c = ledgerClass(t.db, l);
    assert.equal(c.isDebtor, true);
    assert.equal(c.isParty, true);
    assert.equal(c.primaryCode, 'CURRENT_ASSETS');
  });

  it('ledgerClass classifies cash, bank, bank OD, parties, taxes, sales, purchase and expenses', () => {
    const bank = t.addLedger({ name: 'HDFC Bank', group: 'BANK_ACCOUNTS' });
    const od = t.addLedger({ name: 'SBI OD', group: 'BANK_OD' });
    const supplier = t.addLedger({ name: 'Supplier One', group: 'SUNDRY_CREDITORS' });
    const cash = ledgerClass(t.db, t.ids.ledgers.CASH);
    assert.deepEqual([cash.isCash, cash.isBank, cash.isCashOrBank, cash.nature], [true, false, true, 'assets']);
    const b = ledgerClass(t.db, bank);
    assert.deepEqual([b.isBank, b.isBankOd, b.isCashOrBank], [true, false, true]);
    const o = ledgerClass(t.db, od);
    assert.deepEqual([o.isBank, o.isBankOd, o.nature, o.primaryCode], [true, true, 'liabilities', 'LOANS_LIABILITY']);
    const s = ledgerClass(t.db, supplier);
    assert.deepEqual([s.isCreditor, s.isDebtor, s.isParty], [true, false, true]);
    assert.equal(ledgerClass(t.db, t.ids.ledgers.OUTPUT_IGST).isDutyTax, true);
    const sales = ledgerClass(t.db, t.ids.ledgers.SALES);
    assert.deepEqual([sales.isSales, sales.isIncome, sales.affectsGrossProfit], [true, true, true]);
    const purchase = ledgerClass(t.db, t.ids.ledgers.PURCHASE);
    assert.deepEqual([purchase.isPurchase, purchase.isExpense, purchase.affectsGrossProfit], [true, true, true]);
    const roundOff = ledgerClass(t.db, t.ids.ledgers.ROUND_OFF);
    assert.deepEqual([roundOff.isExpense, roundOff.affectsGrossProfit, roundOff.isPurchase], [true, false, false]);
    assert.deepEqual(ledgerClassNames(o), ['bank', 'cash_bank', 'liability']);
    assert.deepEqual(ledgerClassNames(cash), ['cash', 'cash_bank', 'asset']);
    assert.throws(() => ledgerClass(t.db, 99_999), /Ledger not found/);
  });

  it('loadGroupTree lists every group with parents before children', () => {
    const tree = loadGroupTree(t.db);
    const seen = new Set<number>();
    for (const id of tree.order) {
      const n = tree.byId.get(id);
      assert.ok(n);
      if (n.parentId !== null) assert.ok(seen.has(n.parentId), `${n.name} listed before its parent`);
      seen.add(id);
    }
    assert.equal(tree.rootIds.length, 15);
    assert.equal(tree.byId.get(t.ids.groups.CASH_IN_HAND)?.depth, 1);
    assert.deepEqual(tree.byId.get(t.ids.groups.CASH_IN_HAND)?.path, ['Current Assets', 'Cash-in-Hand']);
  });
});

describe('balances with the books filter', () => {
  // Books begin 01-Apr-2026, working date 15-Apr-2026.
  let t: TestCompany;
  let party: number;
  let bank: number;
  let capital: number;
  before(() => {
    t = createTestCompany({ today: '2026-04-15' });
    t.db.run('UPDATE ledgers SET opening_balance = 1000000 WHERE id = :id', { id: t.ids.ledgers.CASH }); // ₹10,000 Dr
    capital = t.addLedger({ name: 'Proprietor Capital', group: 'CAPITAL_ACCOUNT', openingBalance: -1000000 });
    party = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', gstin: makeGstin('29') });
    bank = t.addLedger({ name: 'HDFC Bank', group: 'BANK_ACCOUNTS' });
    const L = t.ids.ledgers;
    // 1. Sales 02-Apr: Dr party 1180.00 / Cr Sales 1000.00 / Cr Output IGST 180.00
    postRaw(t, { date: '2026-04-02', baseType: 'sales', lines: [[party, 118000], [L.SALES, -100000], [L.OUTPUT_IGST, -18000]] });
    // 2. Receipt 05-Apr: Dr bank 500.00 / Cr party 500.00
    postRaw(t, { date: '2026-04-05', baseType: 'receipt', lines: [[bank, 50000], [party, -50000]] });
    // 3. Optional voucher (excluded)
    postRaw(t, { date: '2026-04-10', optional: true, lines: [[bank, 999], [party, -999]] });
    // 4. Cancelled voucher (excluded)
    postRaw(t, { date: '2026-04-11', cancelled: true, lines: [[L.CASH, 777], [L.SALES, -777]] });
    // 5. Contra 12-Apr: Dr bank 2000.00 / Cr cash 2000.00
    postRaw(t, { date: '2026-04-12', baseType: 'contra', lines: [[bank, 200000], [L.CASH, -200000]] });
    // 6. Post-dated receipt 20-Apr (excluded until the working date reaches it)
    postRaw(t, { date: '2026-04-20', postDated: true, baseType: 'receipt', lines: [[bank, 30000], [party, -30000]] });
  });
  after(() => t.close());

  it('ledgerBalance: opening + Dr − Cr, excluding optional, cancelled and future post-dated vouchers', () => {
    // party: 0 + 1180.00 − 500.00 = 680.00 Dr
    assert.deepEqual(ledgerBalance(t.db, party, { to: '2026-04-30', today: t.today }), { opening: 0, debit: 118000, credit: 50000, closing: 68000 });
    // cash: 10,000.00 opening − 2,000.00 contra = 8,000.00 Dr
    assert.deepEqual(ledgerBalance(t.db, t.ids.ledgers.CASH, { to: '2026-04-15', today: t.today }), { opening: 1000000, debit: 0, credit: 200000, closing: 800000 });
  });

  it('ledgerBalance with a from date carries earlier entries into the opening balance', () => {
    // From 03-Apr: opening 1180.00 (sale on 02-Apr), credit 500.00, closing 680.00
    assert.deepEqual(ledgerBalance(t.db, party, { from: '2026-04-03', to: '2026-04-15', today: t.today }), { opening: 118000, debit: 0, credit: 50000, closing: 68000 });
    // Period ending before the receipt: only the sale.
    assert.deepEqual(ledgerBalance(t.db, party, { from: '2026-04-01', to: '2026-04-04', today: t.today }), { opening: 0, debit: 118000, credit: 0, closing: 118000 });
    // Boundary: an entry dated exactly `from` is in the period, one dated `to` too.
    assert.deepEqual(ledgerBalance(t.db, bank, { from: '2026-04-05', to: '2026-04-12', today: t.today }), { opening: 0, debit: 250000, credit: 0, closing: 250000 });
  });

  it('a post-dated voucher counts once the working date reaches it', () => {
    const later = ledgerBalance(t.db, party, { to: '2026-04-30', today: '2026-04-20' });
    // 680.00 − 300.00 = 380.00 Dr
    assert.equal(later.closing, 38000);
    assert.equal(later.credit, 80000);
  });

  it('closingBalances returns opening + entries for all or selected ledgers', () => {
    const all = closingBalances(t.db, { asOf: '2026-04-15', today: t.today });
    assert.equal(all.get(party), 68000);
    assert.equal(all.get(bank), 250000);
    assert.equal(all.get(capital), -1000000);
    assert.equal(all.get(t.ids.ledgers.ROUND_OFF), 0);
    const some = closingBalances(t.db, { asOf: '2026-04-03', today: t.today, ledgerIds: [party, bank] });
    assert.deepEqual([...some.entries()].sort((a, b) => a[0] - b[0]), [[party, 118000], [bank, 0]].sort((a, b) => a[0] - b[0]));
  });

  it('groupBalances: every group equals the sum of the ledgers below it and the books balance', () => {
    const gb = groupBalances(t.db, { to: '2026-04-15', today: t.today });
    for (const [gid, totals] of gb.groups) {
      let opening = 0;
      let debit = 0;
      let credit = 0;
      let closing = 0;
      for (const l of gb.ledgers.values()) {
        if (gb.tree.byId.get(l.groupId)?.chainIds.includes(gid)) {
          opening += l.opening;
          debit += l.debit;
          credit += l.credit;
          closing += l.closing;
        }
      }
      assert.deepEqual([totals.opening, totals.debit, totals.credit, totals.closing], [opening, debit, credit, closing], `group ${gid}`);
    }
    // Current Assets: party 680 + cash 8,000 + bank 2,500 = 11,180.00 Dr
    assert.equal(gb.groups.get(t.ids.groups.CURRENT_ASSETS)?.closing, 1118000);
    assert.equal(gb.groups.get(t.ids.groups.DUTIES_TAXES)?.closing, -18000);
    assert.equal(gb.groups.get(t.ids.groups.SALES_ACCOUNTS)?.closing, -100000);
    // Trial balance agrees: Σ closing = 0, Dr total = Cr total = 11,180.00
    assert.equal(gb.total.closing, 0);
    assert.equal(gb.total.closingDebit, 1118000);
    assert.equal(gb.total.closingCredit, 1118000);
    const primarySum = gb.tree.rootIds.reduce((s, id) => s + (gb.groups.get(id)?.closing ?? 0), 0);
    assert.equal(primarySum, gb.total.closing);
  });

  it('groupBalances over a period splits opening and period movement', () => {
    const gb = groupBalances(t.db, { from: '2026-04-06', to: '2026-04-15', today: t.today });
    const p = gb.ledgers.get(party);
    assert.deepEqual(p && [p.opening, p.debit, p.credit, p.closing], [68000, 0, 0, 68000]);
    const b = gb.ledgers.get(bank);
    assert.deepEqual(b && [b.opening, b.debit, b.credit, b.closing], [50000, 200000, 0, 250000]);
    // Opening Dr of all ledgers = opening Cr (books balanced at the start of the period).
    assert.equal(gb.total.opening, 0);
    assert.equal(gb.total.debit, gb.total.credit);
  });
});
