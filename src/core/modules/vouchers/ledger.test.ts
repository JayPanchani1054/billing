/**
 * Ledger-mode vouchers: payment, receipt, contra, journal — type rules, balance, bill-wise and cost centres.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { pendingBills } from './bills.ts';
import { ledgerBalanceAsOf } from './guards.ts';
import { previewVoucher } from './service.ts';
import { bills, entryMap, header, purchaseInput, ruleDetails, save, setupKit, throwsApp, type Kit } from './testkit.ts';

const ledgerVoucher = (k: Kit, base: 'payment' | 'receipt' | 'contra' | 'journal', ledgers: VoucherInput['ledgers'], over: Partial<VoucherInput> = {}): VoucherInput => ({
  voucherTypeId: k.vt[base],
  date: k.t.today,
  mode: 'ledger',
  ledgers,
  ...over,
});

describe('payment & receipt', () => {
  it('payment against two purchase bills plus on account', () => {
    const k = setupKit();
    // P1: rice 10 × ₹80 = 800 + 20 + 20 = ₹840.00; P2: rice 5 × ₹80 = 400 + 10 + 10 = ₹420.00.
    save(k, purchaseInput(k, { referenceNo: 'P1', items: [{ itemId: k.I.rice, qty: 10, rate: 80 }] }));
    save(k, purchaseInput(k, { referenceNo: 'P2', items: [{ itemId: k.I.rice, qty: 5, rate: 80 }] }));
    assert.deepEqual(pendingBills(k.t.db, k.L.supplier, k.t.today, k.t.today).map((b) => [b.billName, b.amount]), [['P1', -84000], ['P2', -42000]]);
    // Pay ₹1,500.00: 840 against P1, 420 against P2, 240 on account.
    const res = save(k, ledgerVoucher(k, 'payment', [
      {
        ledgerId: k.L.supplier,
        amount: 150000,
        billAllocations: [
          { refType: 'against', billName: 'P1', amount: 84000 },
          { refType: 'against', billName: 'P2', amount: 42000 },
          { refType: 'on_account', amount: 24000 },
        ],
      },
      { ledgerId: k.L.bank, amount: -150000, instrument: { type: 'neft', number: 'UTR123' } },
    ]));
    assert.deepEqual(entryMap(k, res.id), { 'Supreme Suppliers': 150000, 'HDFC Bank': -150000 });
    assert.deepEqual(bills(k, res.id).map((b) => [b.ref_type, b.bill_name, b.amount]), [['against', 'P1', 84000], ['against', 'P2', 42000], ['on_account', null, 24000]]);
    assert.deepEqual(pendingBills(k.t.db, k.L.supplier, k.t.today, k.t.today), []);
    const h = header(k, res.id);
    assert.equal(h.party_ledger_id, k.L.supplier, 'payment party inferred from the debited ledger');
    assert.equal(h.total_amount, 150000);
    const roles = k.t.db.all<{ role: string }>('SELECT role FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no', { id: res.id }).map((r) => r.role);
    assert.deepEqual(roles, ['party', 'cash_bank']);
    // Supplier: −840 − 420 + 1,500 = ₹240.00 Dr (the on-account advance).
    assert.equal(ledgerBalanceAsOf(k.t.db, k.L.supplier, k.t.today, k.t.today, null), 24000);
    k.t.close();
  });

  it('receipt with a cheque instrument; bill-wise default is on account', () => {
    const k = setupKit();
    const res = save(k, ledgerVoucher(k, 'receipt', [
      { ledgerId: k.L.bank, amount: 50000, instrument: { type: 'cheque', number: '123456', date: '2026-04-14', bankName: 'SBI', favouring: 'Test Traders' } },
      { ledgerId: k.L.acme, amount: -50000, narration: 'Advance' },
    ]));
    const le = k.t.db.get<Record<string, unknown>>('SELECT * FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :l', { id: res.id, l: k.L.bank });
    assert.deepEqual(
      [le?.instrument_type, le?.instrument_no, le?.instrument_date, le?.bank_name, le?.favouring, le?.role],
      ['cheque', '123456', '2026-04-14', 'SBI', 'Test Traders', 'cash_bank'],
    );
    assert.deepEqual(bills(k, res.id).map((b) => [b.ref_type, b.bill_name, b.amount]), [['on_account', null, -50000]]);
    assert.equal(header(k, res.id).party_ledger_id, k.L.acme);
    k.t.close();
  });

  it('payment must credit a cash/bank ledger; receipt must debit one', () => {
    const k = setupKit();
    throwsApp(
      () => save(k, ledgerVoucher(k, 'payment', [{ ledgerId: k.L.rent, amount: 1000 }, { ledgerId: k.L.capital, amount: -1000 }])),
      'BUSINESS_RULE',
      /must credit at least one Cash or Bank ledger/,
    );
    throwsApp(
      () => save(k, ledgerVoucher(k, 'receipt', [{ ledgerId: k.L.bank, amount: -1000 }, { ledgerId: k.L.acme, amount: 1000 }])),
      'BUSINESS_RULE',
      /must debit at least one Cash or Bank ledger/,
    );
    k.t.close();
  });

  it('post-dated payment is excluded from balances until its date', () => {
    const k = setupKit();
    const res = save(k, ledgerVoucher(k, 'payment', [{ ledgerId: k.L.rent, amount: 25000 }, { ledgerId: k.L.bank, amount: -25000 }], { date: '2026-05-10', isPostDated: true }));
    assert.equal(header(k, res.id).is_post_dated, 1);
    assert.equal(k.t.db.value('SELECT MIN(is_post_dated) FROM ledger_entries WHERE voucher_id = :id', { id: res.id }), 1);
    // As of 10-May (in the future relative to today 15-Apr) the books filter excludes it…
    assert.equal(ledgerBalanceAsOf(k.t.db, k.L.rent, '2026-05-31', k.t.today, null), 0);
    // …and includes it once today reaches its date.
    assert.equal(ledgerBalanceAsOf(k.t.db, k.L.rent, '2026-05-31', '2026-05-10', null), 25000);
    k.t.close();
  });
});

describe('contra & journal', () => {
  it('contra cash → bank', () => {
    const k = setupKit();
    save(k, ledgerVoucher(k, 'receipt', [{ ledgerId: k.L.cash, amount: 20000 }, { ledgerId: k.L.capital, amount: -20000 }]));
    const res = save(k, ledgerVoucher(k, 'contra', [{ ledgerId: k.L.bank, amount: 10000 }, { ledgerId: k.L.cash, amount: -10000 }], { narration: 'Cash deposited' }));
    assert.deepEqual(entryMap(k, res.id), { 'HDFC Bank': 10000, Cash: -10000 });
    assert.equal(header(k, res.id).party_ledger_id, null);
    assert.equal(res.warnings.length, 0, 'cash stays positive');
    k.t.close();
  });

  it('contra with a non-cash ledger is rejected', () => {
    const k = setupKit();
    throwsApp(
      () => save(k, ledgerVoucher(k, 'contra', [{ ledgerId: k.L.bank, amount: 10000 }, { ledgerId: k.L.capital, amount: -10000 }])),
      'BUSINESS_RULE',
      /Owner Capital is not a Cash or Bank ledger/,
    );
    k.t.close();
  });

  it('unbalanced journal is rejected with Dr and Cr totals', () => {
    const k = setupKit();
    const err = throwsApp(
      () => save(k, ledgerVoucher(k, 'journal', [{ ledgerId: k.L.rent, amount: 1000 }, { ledgerId: k.L.capital, amount: -900 }])),
      'BUSINESS_RULE',
      /Voucher is not balanced: Dr ₹ 10\.00 ≠ Cr ₹ 9\.00 \(difference ₹ 1\.00 Dr\)/,
    );
    const d = ruleDetails(err);
    assert.ok(d.warnings.some((w) => w.code === 'unbalanced' && w.blocking));
    // Preview never throws for rule violations: it reports them.
    const p = previewVoucher(k.t.ctx, ledgerVoucher(k, 'journal', [{ ledgerId: k.L.rent, amount: 1000 }, { ledgerId: k.L.capital, amount: -900 }]));
    assert.deepEqual([p.totals.debit, p.totals.credit], [1000, 900]);
    assert.ok(p.warnings.some((w) => w.code === 'unbalanced'));
    k.t.close();
  });

  it('journal cannot use cash or bank ledgers', () => {
    const k = setupKit();
    throwsApp(
      () => save(k, ledgerVoucher(k, 'journal', [{ ledgerId: k.L.rent, amount: 1000 }, { ledgerId: k.L.cash, amount: -1000 }])),
      'BUSINESS_RULE',
      /Cash cannot be used in a Journal|Cash is a Cash\/Bank ledger/,
    );
    k.t.close();
  });

  it('balanced journal posts as entered; zero-value vouchers are rejected', () => {
    const k = setupKit();
    const res = save(k, ledgerVoucher(k, 'journal', [{ ledgerId: k.L.rent, amount: 120000 }, { ledgerId: k.L.capital, amount: -120000 }]));
    assert.deepEqual(entryMap(k, res.id), { 'Office Rent': 120000, 'Owner Capital': -120000 });
    assert.equal(header(k, res.id).total_amount, 120000);
    throwsApp(() => save(k, ledgerVoucher(k, 'journal', [{ ledgerId: k.L.rent, amount: 0 }])), 'BUSINESS_RULE', /no value/);
    k.t.close();
  });

  it('memorandum vouchers never affect the books', () => {
    const k = setupKit();
    const res = save(k, {
      voucherTypeId: k.vt.memorandum,
      date: k.t.today,
      mode: 'ledger',
      ledgers: [{ ledgerId: k.L.rent, amount: 5000 }, { ledgerId: k.L.cash, amount: -5000 }],
    });
    assert.equal(header(k, res.id).affects_books, 0);
    assert.equal(k.t.db.value('SELECT MAX(affects_books) FROM ledger_entries WHERE voucher_id = :id', { id: res.id }), 0);
    assert.equal(res.warnings.length, 0, 'no cash guard for a memorandum');
    k.t.close();
  });
});

describe('bill-wise rules', () => {
  it('allocations must add up to the ledger amount', () => {
    const k = setupKit();
    save(k, purchaseInput(k, { referenceNo: 'P1' }));
    throwsApp(
      () =>
        save(k, ledgerVoucher(k, 'payment', [
          { ledgerId: k.L.supplier, amount: 10000, billAllocations: [{ refType: 'against', billName: 'P1', amount: 9000 }] },
          { ledgerId: k.L.bank, amount: -10000 },
        ])),
      'BUSINESS_RULE',
      /Bill-wise details of Supreme Suppliers total ₹ 90\.00 but its amount is ₹ 100\.00/,
    );
    k.t.close();
  });

  it('against an unknown bill is rejected; over-settling needs confirmation', () => {
    const k = setupKit();
    save(k, purchaseInput(k, { referenceNo: 'P1' })); // ₹1,680.00 Cr
    throwsApp(
      () =>
        save(k, ledgerVoucher(k, 'payment', [
          { ledgerId: k.L.supplier, amount: 10000, billAllocations: [{ refType: 'against', billName: 'NOPE', amount: 10000 }] },
          { ledgerId: k.L.bank, amount: -10000 },
        ])),
      'BUSINESS_RULE',
      /Bill NOPE is not pending/,
    );
    const over: VoucherInput = ledgerVoucher(k, 'payment', [
      { ledgerId: k.L.supplier, amount: 200000, billAllocations: [{ refType: 'against', billName: 'P1', amount: 200000 }] },
      { ledgerId: k.L.bank, amount: -200000 },
    ]);
    const err = throwsApp(() => save(k, { ...over, acknowledgeWarnings: false }), 'BUSINESS_RULE', /Please confirm/);
    assert.ok(ruleDetails(err).warnings.some((w) => w.code === 'bill_over_settled'));
    save(k, over);
    assert.deepEqual(pendingBills(k.t.db, k.L.supplier, k.t.today, k.t.today).map((b) => [b.billName, b.amount]), [['P1', 32000]]);
    k.t.close();
  });

  it('invoice party allocations override the default new reference', () => {
    const k = setupKit();
    // ₹1,180.00: ₹1,000.00 new ref INV-A (60 days) + ₹180.00 against an opening advance.
    const party = k.t.addLedger({
      name: 'Opening Customer',
      group: 'SUNDRY_DEBTORS',
      stateCode: '27',
      openingBills: [{ name: 'ADV-1', date: '2026-03-20', amount: -18000 }],
      openingBalance: -18000,
    });
    const res = save(k, {
      voucherTypeId: k.vt.sales,
      date: k.t.today,
      mode: 'item_invoice',
      partyLedgerId: party,
      items: [{ itemId: k.I.mixer, qty: 5, rate: 200 }],
      partyBillAllocations: [
        { refType: 'new', billName: 'INV-A', amount: 100000, creditDays: 60 },
        { refType: 'against', billName: 'ADV-1', amount: 18000 },
      ],
    });
    assert.deepEqual(
      bills(k, res.id).map((b) => [b.ref_type, b.bill_name, b.amount, b.due_date]),
      [['new', 'INV-A', 100000, '2026-06-14'], ['against', 'ADV-1', 18000, null]],
    );
    assert.deepEqual(pendingBills(k.t.db, party, k.t.today, k.t.today).map((b) => [b.billName, b.amount, b.source]), [['INV-A', 100000, 'voucher']]);
    k.t.close();
  });

  it('bill-wise details are ignored when the feature is off', () => {
    const k = setupKit({ features: { billWise: false } });
    const res = save(k, ledgerVoucher(k, 'receipt', [{ ledgerId: k.L.bank, amount: 1000 }, { ledgerId: k.L.acme, amount: -1000, billAllocations: [{ refType: 'against', billName: 'X', amount: 1000 }] }]));
    assert.equal(bills(k, res.id).length, 0);
    k.t.close();
  });
});

describe('cost centres', () => {
  it('allocations are stored signed and must total the ledger amount', () => {
    const k = setupKit({ features: { costCentres: true } });
    const ts = k.t.clock.now().toISOString();
    const centre = (name: string): number =>
      k.t.db.run('INSERT INTO cost_centres (guid, name, category_id, created_at, updated_at) VALUES (:g, :n, :c, :ts, :ts)', {
        g: name,
        n: name,
        c: k.t.ids.costCategoryId,
        ts,
      }).lastInsertRowid;
    const mumbai = centre('Mumbai Branch');
    const pune = centre('Pune Branch');
    const travel = k.t.addLedger({ name: 'Travel', group: 'INDIRECT_EXPENSES', costCentres: true });
    const res = save(k, ledgerVoucher(k, 'payment', [
      { ledgerId: travel, amount: 30000, costAllocations: [{ costCentreId: mumbai, amount: 20000 }, { costCentreId: pune, amount: 10000 }] },
      { ledgerId: k.L.bank, amount: -30000 },
    ]));
    const rows = k.t.db.all<{ cost_centre_id: number; amount: number }>('SELECT cost_centre_id, amount FROM cost_allocations WHERE voucher_id = :id ORDER BY id', { id: res.id });
    assert.deepEqual(rows.map((r) => [r.cost_centre_id, r.amount]), [[mumbai, 20000], [pune, 10000]]);
    const refund = save(k, ledgerVoucher(k, 'receipt', [
      { ledgerId: k.L.bank, amount: 5000 },
      { ledgerId: travel, amount: -5000, costAllocations: [{ costCentreId: pune, amount: 5000 }] },
    ]));
    assert.equal(k.t.db.value('SELECT amount FROM cost_allocations WHERE voucher_id = :id', { id: refund.id }), -5000);
    throwsApp(
      () =>
        save(k, ledgerVoucher(k, 'payment', [
          { ledgerId: travel, amount: 30000, costAllocations: [{ costCentreId: mumbai, amount: 1000 }] },
          { ledgerId: k.L.bank, amount: -30000 },
        ])),
      'BUSINESS_RULE',
      /Cost centre allocations of Travel total ₹ 10\.00/,
    );
    k.t.close();
  });
});
