/**
 * Performance with every voucher hook on (final wave). A company with every feature switched on (bill-
 * wise, cost centres, multi-currency, cheque printing, integrated inventory, godowns, orders, tracking,
 * manufacturing, job work, POS, GST, TDS, TCS), 2,000 ledgers, 1,000 items and 60,000 vouchers (the
 * dashboard perf builder) plus a few hundred real feature vouchers (TDS journals, cheque payments,
 * export invoices in USD, Material Out challans) posted through saveVoucher.
 *
 * The deterministic part of the budget — what a loaded CI machine cannot make flaky — is the SQL a
 * voucher save runs (the app never runs ANALYZE, so SQLite's plans depend on the schema only):
 *   - every statement of a save / alter / cancel / delete reaches the rows of its own voucher, party,
 *     bank, item or period through an index — no scan of a table that grows with the books, and a
 *     statement keyed by `voucher_id = :x` really looks the voucher up (not, say, every TDS line of the
 *     section or every bill of the party: two hooks did that before this test);
 *   - the number of statements per save stays small, and only a Manufacturing Journal / Material Out
 *     values stock (one replay of its own items, for the cost estimate);
 *   - five more hook paths are plan-checked the same way (a debit note reversing a bill's TDS, a receipt
 *     settling a USD bill, an invoice converted from a quotation, reverse charge, a bill of entry);
 *   - report routes and drill-downs run a bounded number of statements (ITC-04 ran two per challan line).
 * Wall times are logged and checked against generous bounds (targets on a developer machine: save
 * ≤ 50 ms p95, reports ≤ 1 s cold, drill-downs ≤ 150 ms).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { routes } from '../../api/routes.ts';
import { createTestCompany, makeGstin, testPan, type TestCompany } from '../../testing/fixtures.ts';
import { allPlanProblems, queryPlan, recordSql, type SqlRecorder } from '../../testing/sqlPlans.ts';
import { saveCurrency, saveExchangeRate } from '../accounts/currencies.ts';
import { saveBook } from '../cheques/books.ts';
import { bulkBusiness } from '../dashboard/testkit.ts';
import { saveBudget } from '../documents/budgets.ts';
import { draftVoucher } from '../documents/quotations.ts';
import { stockReplayCount } from '../inventory/index.ts';
import { saveGodown } from '../inventory/masters.ts';
import { saveBom } from '../mfg/bom.ts';
import { saveLedgerDetails } from '../tds/masters.ts';
import { getVoucher } from './queries.ts';
import { cancelVoucher, deleteVoucher, saveVoucher } from './service.ts';

// ───────────────────────────── The company ─────────────────────────────

const ALL_FEATURES = {
  billWise: true,
  costCentres: true,
  multiCurrency: true,
  chequePrinting: true,
  inventory: true,
  integrateInventory: true,
  multipleGodowns: true,
  orderProcessing: true,
  trackingNumbers: true,
  manufacturing: true,
  jobWork: true,
  pos: true,
  gst: true,
  tds: true,
  tcs: true,
} as const;

interface Books {
  t: TestCompany;
  rec: SqlRecorder;
  /** Voucher inputs by kind, dated on the working date. */
  kinds: Array<[string, VoucherInput]>;
  /**
   * More hook paths, each a fresh input per call (unique numbers, a new quotation to convert): a debit
   * note reversing a bill's TDS, a receipt settling a USD bill (realised gain), an invoice converted from
   * a quotation (documents link), a reverse-charge purchase and an import with a bill of entry.
   */
  hookPaths: Array<[string, () => VoucherInput]>;
  debtors: number[];
  others: number[];
  usd: number;
}

const TODAY = '2026-10-08';
const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)];

function buildBooks(): Books {
  const t = createTestCompany({ today: TODAY, booksFrom: '2025-04-01', features: ALL_FEATURES });
  const L = t.ids.ledgers;
  const vt = t.ids.voucherTypes;
  const debtors: number[] = [];
  const creditors: number[] = [];
  const others: number[] = [];
  for (let i = 0; i < 1_000; i++) debtors.push(t.addLedger({ name: `Customer ${i}`, group: 'SUNDRY_DEBTORS', gstin: makeGstin('27', testPan(100 + i)), creditDays: 30 }));
  for (let i = 0; i < 600; i++) creditors.push(t.addLedger({ name: `Supplier ${i}`, group: 'SUNDRY_CREDITORS', gstin: makeGstin(i % 3 ? '27' : '29', testPan(2_000 + i)), creditDays: 45 }));
  for (let i = 0; i < 400; i++) others.push(t.addLedger({ name: `Expense ${i}`, group: i % 2 ? 'INDIRECT_EXPENSES' : 'DIRECT_EXPENSES' }));
  const items: number[] = [];
  for (let i = 0; i < 1_000; i++) items.push(t.addStockItem({ name: `Item ${i}`, gstRate: 18, hsnSac: '8471', openingQty: 10_000, openingRate: 100 }));
  const bank = t.addLedger({ name: 'State Bank', group: 'BANK_ACCOUNTS', bank: { accountNo: '1234567890', ifsc: 'SBIN0000001' } });
  bulkBusiness(t, 60_000, {
    debtors,
    creditors,
    items,
    bank,
    ledgers: { sales: L.SALES, purchase: L.PURCHASE, outCgst: L.OUTPUT_CGST, outSgst: L.OUTPUT_SGST, inCgst: L.INPUT_CGST, inSgst: L.INPUT_SGST },
  });

  // Feature masters.
  const natureId = (where: string): number => {
    const id = t.db.value<number>(`SELECT id FROM tds_natures WHERE ${where} ORDER BY id LIMIT 1`);
    assert.ok(id, where);
    return id;
  };
  const contractExp = t.addLedger({ name: 'Contract Charges', group: 'DIRECT_EXPENSES' });
  saveLedgerDetails(t.ctx, { ledgerId: contractExp, applicable: true, natureId: natureId("kind = 'tds' AND section = '194C'") });
  for (const c of creditors.slice(0, 300)) saveLedgerDetails(t.ctx, { ledgerId: c, applicable: true, deducteeType: 'company' });
  const scrapSales = t.addLedger({ name: 'Sale of Scrap', group: 'SALES_ACCOUNTS', gstRate: 18, hsnSac: '7204', supplyType: 'goods' });
  saveLedgerDetails(t.ctx, { ledgerId: scrapSales, applicable: true, natureId: natureId("kind = 'tcs' AND name = 'Sale of scrap'") });
  saveLedgerDetails(t.ctx, { ledgerId: debtors[9], applicable: true, deducteeType: 'company' });
  const usd = saveCurrency(t.ctx, { symbol: '$', formalName: 'US Dollar', isoCode: 'USD', decimalPlaces: 2 }).id;
  saveExchangeRate(t.ctx, { currencyId: usd, date: '2025-04-01', standard: 83, selling: 83.5, buying: 82.5 });
  const usCustomer = t.addLedger({ name: 'Acme Inc (USA)', group: 'SUNDRY_DEBTORS', registrationType: 'overseas', billWise: true, columns: { currency_id: usd, country: 'United States', state_code: null } });
  const exportSales = t.addLedger({ name: 'Export Sales', group: 'SALES_ACCOUNTS', gstApplicable: true, gstRate: 18, hsnSac: '998314', supplyType: 'services' });
  saveBook(t.ctx, { bankLedgerId: bank, fromNo: 100_001, toNo: 109_999 });
  const jobWorker = t.addLedger({ name: 'Ravi Fabricators', group: 'SUNDRY_CREDITORS', gstin: makeGstin('29', testPan(9_999)) });
  const jwGodown = saveGodown(t.ctx, { name: 'Ravi (JW)', thirdPartyKind: 'ours_with_party', partyLedgerId: jobWorker }).id;
  const typeId = (name: string): number => {
    const id = t.db.value<number>('SELECT id FROM voucher_types WHERE name = :name', { name });
    assert.ok(id, name);
    return id;
  };
  const bom = saveBom(t.ctx, { itemId: items[500], name: 'Std', outputQty: 1, isDefault: true, lines: [{ kind: 'component', itemId: items[501], qty: 2 }, { kind: 'component', itemId: items[502], qty: 1 }] });
  const cashMode = t.db.value<number>("SELECT id FROM pos_tender_modes WHERE kind = 'cash' ORDER BY id LIMIT 1");
  assert.ok(cashMode);
  saveBudget(t.ctx, {
    name: 'FY 2026-27',
    from: '2026-04-01',
    to: '2027-03-31',
    lines: [
      { kind: 'group', refId: t.ids.groups.INDIRECT_EXPENSES, basis: 'net_transactions', amount: 1_00_00_000 },
      { kind: 'group', refId: t.ids.groups.SUNDRY_DEBTORS, basis: 'closing_balance', amount: 1_00_00_000 },
      ...others.slice(0, 200).map((id) => ({ kind: 'ledger' as const, refId: id, basis: 'net_transactions' as const, amount: 10_000 })),
      { kind: 'ledger', refId: L.SALES, basis: 'net_transactions', amount: -1_00_00_000 },
    ],
  });

  const save = (input: VoucherInput) => saveVoucher(t.ctx, { acknowledgeWarnings: true, ...input });
  const materialOut = (date: string, itemId: number): VoucherInput => ({
    voucherTypeId: typeId('Material Out'),
    date,
    mode: 'inventory',
    partyLedgerId: jobWorker,
    stockJournal: { thirdPartyGodownId: jwGodown, process: 'Fabrication', lines: [{ role: 'transfer', itemId, qty: 2, rate: 100, goodsType: 'inputs' }] },
  });
  const exportInvoice = (date: string, amount: number): VoucherInput => ({
    voucherTypeId: vt.sales,
    date,
    mode: 'accounting_invoice',
    partyLedgerId: usCustomer,
    forex: { currencyId: usd, rate: 83 },
    ledgers: [{ ledgerId: exportSales, amount }],
  });
  // Real feature vouchers, so the derived tables (tds_lines, cheque leaves, forex columns, stock journal
  // details) have rows of their own.
  for (let i = 0; i < 300; i++) {
    const date = `2026-0${4 + (i % 5)}-${String(1 + (i % 28)).padStart(2, '0')}`;
    save({ voucherTypeId: vt.journal, date, mode: 'ledger', ledgers: [{ ledgerId: contractExp, amount: 5_000_000 + i }, { ledgerId: creditors[i], amount: -(5_000_000 + i) }] });
    save({ voucherTypeId: vt.payment, date, mode: 'ledger', ledgers: [{ ledgerId: others[i % 400], amount: 10_000 + i }, { ledgerId: bank, amount: -(10_000 + i), instrument: { type: 'cheque' } }] });
    if (i % 3 === 0) save(exportInvoice(date, 10_000 + i));
    if (i % 3 === 1) save(materialOut(date, items[i]));
  }

  const kinds: Array<[string, VoucherInput]> = [
    ['sales invoice', { voucherTypeId: vt.sales, date: TODAY, mode: 'item_invoice', partyLedgerId: debtors[5], items: [{ itemId: items[1], qty: 2, rate: 200 }, { itemId: items[2], qty: 1, rate: 300 }] }],
    ['purchase invoice', { voucherTypeId: vt.purchase, date: TODAY, mode: 'item_invoice', partyLedgerId: creditors[7], referenceNo: 'PX-1', items: [{ itemId: items[3], qty: 5, rate: 100 }] }],
    ['receipt', { voucherTypeId: vt.receipt, date: TODAY, mode: 'ledger', ledgers: [{ ledgerId: bank, amount: 1_000 }, { ledgerId: debtors[0], amount: -1_000 }] }],
    ['cheque payment', { voucherTypeId: vt.payment, date: TODAY, mode: 'ledger', ledgers: [{ ledgerId: creditors[3], amount: 1_000 }, { ledgerId: bank, amount: -1_000, instrument: { type: 'cheque' } }] }],
    ['TDS journal', { voucherTypeId: vt.journal, date: TODAY, mode: 'ledger', ledgers: [{ ledgerId: contractExp, amount: 5_000_000 }, { ledgerId: creditors[1], amount: -5_000_000 }] }],
    ['TCS sale', { voucherTypeId: vt.sales, date: TODAY, mode: 'accounting_invoice', partyLedgerId: debtors[9], ledgers: [{ ledgerId: scrapSales, amount: 100_000_00 }] }],
    ['export invoice (USD)', exportInvoice(TODAY, 10_000)],
    ['Material Out', materialOut(TODAY, items[9])],
    [
      'Manufacturing Journal',
      {
        voucherTypeId: typeId('Manufacturing Journal'),
        date: TODAY,
        mode: 'inventory',
        stockJournal: { bomId: bom.id, lines: [{ role: 'product', itemId: items[500], qty: 1 }, { role: 'component', itemId: items[501], qty: 2 }, { role: 'component', itemId: items[502], qty: 1 }] },
      },
    ],
    ['POS bill', { voucherTypeId: typeId('POS Sales'), date: TODAY, mode: 'item_invoice', partyLedgerId: L.CASH, items: [{ itemId: items[7], qty: 1, rate: 100 }], posBill: { tenders: [{ modeId: cashMode, amount: 11_800 }] } }],
    [
      'advance receipt (GST)',
      {
        voucherTypeId: vt.receipt,
        date: TODAY,
        mode: 'ledger',
        ledgers: [{ ledgerId: bank, amount: 118_000 }, { ledgerId: debtors[11], amount: -118_000, billAllocations: [{ refType: 'advance', billName: 'ADV-1', amount: 118_000 }] }],
        gstDetails: { advance: { supplyType: 'goods', rate: 18 } },
      },
    ],
    ['quotation', { voucherTypeId: vt.quotation, date: TODAY, mode: 'item_invoice', partyLedgerId: debtors[12], items: [{ itemId: items[13], qty: 1, rate: 100 }], validUntil: '2026-10-30' }],
  ];

  // Documents the extra hook paths settle / reverse / convert.
  save({ voucherTypeId: vt.purchase, date: '2026-09-05', mode: 'accounting_invoice', partyLedgerId: creditors[20], referenceNo: 'SC-1', ledgers: [{ ledgerId: contractExp, amount: 1_00_00_000_00 }] });
  const usBill = save({ voucherTypeId: vt.sales, date: '2026-09-20', mode: 'accounting_invoice', partyLedgerId: usCustomer, placeOfSupply: '96', exportDetails: { withPayment: false }, forex: { currencyId: usd, rate: 83 }, ledgers: [{ ledgerId: exportSales, amount: 0, forexAmount: 100_000 }] });
  const usBillName = t.db.value<string>("SELECT bill_name FROM bill_allocations WHERE voucher_id = :v AND ref_type = 'new'", { v: usBill.id });
  assert.ok(usBillName);
  const gta = t.addLedger({ name: 'GTA Roadways', group: 'SUNDRY_CREDITORS', registrationType: 'unregistered' });
  const freight = t.addLedger({ name: 'Freight Inward', group: 'DIRECT_EXPENSES', gstApplicable: true, gstRate: 5, hsnSac: '996511', supplyType: 'services' });
  const overseas = t.addLedger({ name: 'Shenzhen Tools', group: 'SUNDRY_CREDITORS', registrationType: 'overseas', columns: { country: 'China', state_code: null } });
  let seq = 1_000_000;
  const hookPaths: Array<[string, () => VoucherInput]> = [
    [
      'debit note reversing a bill’s TDS',
      () => ({
        voucherTypeId: vt.debit_note,
        date: TODAY,
        mode: 'accounting_invoice',
        partyLedgerId: creditors[20],
        originalInvoiceNo: 'SC-1',
        originalInvoiceDate: '2026-09-05',
        ledgers: [{ ledgerId: contractExp, amount: 1_000_00 }],
        // ₹1,000 less the TDS reversed on it (194C company 2%: ₹20).
        partyBillAllocations: [{ refType: 'against', billName: 'SC-1', amount: 980_00 }],
      }),
    ],
    [
      'receipt settling a USD bill',
      () => ({
        voucherTypeId: vt.receipt,
        date: TODAY,
        mode: 'ledger',
        ledgers: [
          { ledgerId: bank, amount: 8_450_00 },
          { ledgerId: usCustomer, amount: 0, forexAmount: -100, exchangeRate: 84.5, billAllocations: [{ refType: 'against', billName: usBillName, amount: 0, forexAmount: 100 }] },
        ],
      }),
    ],
    [
      'invoice converted from a quotation',
      () => {
        const q = save({ voucherTypeId: vt.quotation, date: '2026-09-25', mode: 'item_invoice', partyLedgerId: debtors[30], items: [{ itemId: items[20], qty: 1, rate: 100 }], validUntil: '2026-12-30' });
        return draftVoucher(t.ctx, { sourceId: q.id, targetBaseType: 'sales', date: TODAY });
      },
    ],
    ['reverse-charge purchase', () => ({ voucherTypeId: vt.purchase, date: TODAY, mode: 'accounting_invoice', partyLedgerId: gta, referenceNo: `GTA-${seq++}`, reverseCharge: true, ledgers: [{ ledgerId: freight, amount: 10_000_00 }] })],
    [
      'import with a bill of entry',
      () => ({
        voucherTypeId: vt.purchase,
        date: TODAY,
        mode: 'item_invoice',
        partyLedgerId: overseas,
        referenceNo: `SZ-${seq}`,
        items: [{ itemId: items[25], qty: 10, rate: 1000 }],
        gstDetails: { billOfEntry: { number: String(seq++), date: TODAY, portCode: 'INNSA1', assessableValue: 11_000_00, igst: 1_980_00 } },
      }),
    ],
  ];
  return { t, rec: recordSql(t.db), kinds, hookPaths, debtors, others, usd };
}

describe('performance: 60,000 vouchers with every voucher hook on', () => {
  let b: Books;
  before(() => {
    b = buildBooks();
  });
  after(() => b.t.close());

  const save = (input: VoucherInput) => saveVoucher(b.t.ctx, { acknowledgeWarnings: true, ...input });

  it('every statement of a save / alter / cancel / delete is indexed for its own voucher, party, bank or period', () => {
    const { t, rec, kinds, hookPaths } = b;
    const problems: string[] = [];
    const paths: Array<[string, () => VoucherInput]> = [...kinds.map(([label, input]): [string, () => VoucherInput] => [label, () => ({ ...input, date: '2026-10-06' })]), ...hookPaths];
    for (const [label, input] of paths) {
      rec.start();
      t.db.transaction(() => {
        const r = save(input());
        save({ ...getVoucher(t.db, r.id).input, narration: 'altered', acknowledgeWarnings: true });
        const other = save(input());
        cancelVoucher(t.ctx, other.id, 'Entered twice');
        deleteVoucher(t.ctx, r.id);
      });
      problems.push(...allPlanProblems(t.db, rec.stop(), label));
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('save ≤ 50 ms p95 target: few statements per save, no stock valuation except a stock journal’s own items (one replay)', () => {
    const { t, rec, kinds } = b;
    const times: number[] = [];
    const report: string[] = [];
    for (const [label, input] of kinds) {
      t.db.transaction(() => save({ ...input, date: '2026-10-07' })); // warm-up (statement cache)
      const saveMs: number[] = [];
      let saveQ = 0;
      let alterQ = 0;
      let replays = 0;
      for (let i = 0; i < 6; i++) {
        rec.start();
        const r0 = stockReplayCount();
        const t0 = performance.now();
        const r = t.db.transaction(() => save(input));
        saveMs.push(performance.now() - t0);
        replays = Math.max(replays, stockReplayCount() - r0);
        saveQ = Math.max(saveQ, rec.stop().length);
        rec.start();
        const t1 = performance.now();
        t.db.transaction(() => save({ ...getVoucher(t.db, r.id).input, narration: `altered ${i}`, acknowledgeWarnings: true }));
        saveMs.push(performance.now() - t1);
        alterQ = Math.max(alterQ, rec.stop().length);
      }
      times.push(...saveMs);
      report.push(`${label} p95 ${p95(saveMs).toFixed(1)} ms, ${saveQ}/${alterQ} statements, ${replays} replays`);
      // Measured: 23–56 statements per save, 59–91 per alter (the alter re-reads and rewrites the voucher).
      assert.ok(saveQ <= 120, `${label}: ${saveQ} statements per save`);
      assert.ok(alterQ <= 160, `${label}: ${alterQ} statements per alter`);
      // Only the stock journals estimate a cost (their own items, as of the voucher date): one replay.
      assert.equal(replays, label === 'Manufacturing Journal' || label === 'Material Out' ? 1 : 0, `${label}: stock valuation replays per save`);
    }
    console.log(`# saves on 60,000 vouchers, every feature on (p95 / statements save/alter / replays): ${report.join(' · ')}`);
    // About 1–7 ms each on a developer machine; 250 ms only catches a return of per-save table scans.
    assert.ok(p95(times) < 250, `save / alter p95 ${p95(times).toFixed(1)} ms`);
  });

  it('reports: ≤ 1 s cold target, drill-downs ≤ 150 ms target, bounded statements (no N+1)', async () => {
    const { t, rec, debtors, usd } = b;
    const L = t.ids.ledgers;
    const G = t.ids.groups;
    const FY = { from: '2026-04-01', to: '2027-03-31' };
    const aSale = t.db.value<number>("SELECT id FROM vouchers WHERE base_type = 'sales' AND date >= '2026-06-01' ORDER BY id LIMIT 1");
    const anItem = t.db.value<number>("SELECT id FROM stock_items WHERE name = 'Item 1'");
    assert.ok(aSale && anItem);
    // [label, route, input, max statements (measured × ~2), drill-down?]
    const calls: Array<[string, string, unknown, number, boolean]> = [
      ['Day Book (a week)', 'vouchers.list', { from: '2026-10-01', to: TODAY, limit: 200 }, 10, true],
      ['Ledger (a debtor)', 'reports.ledger', { ...FY, ledgerId: debtors[0] }, 20, true],
      ['Go To: ledgers', 'accounts.ledger.list', { search: 'cust', limit: 8, withBalance: true }, 15, true],
      ['Go To: items', 'inventory.item.picker', { search: 'item 9', limit: 8 }, 20, true],
      ['Go To: vouchers', 'vouchers.list', { from: '1900-01-01', to: '2999-12-31', search: '1234', limit: 8, sort: 'date_desc' }, 10, true],
      // Drill-downs from the statements and registers (measured 2–100 ms).
      ['Voucher (open from a report)', 'vouchers.get', { id: aSale }, 20, true],
      ['Group summary (Sundry Debtors, 1,000 ledgers)', 'reports.groupSummary', { ...FY, groupId: G.SUNDRY_DEBTORS }, 12, true],
      ['Monthly summary (Sales)', 'reports.monthlySummary', { ...FY, ledgerId: L.SALES }, 12, true],
      ['Group vouchers (Sundry Debtors)', 'reports.groupVouchers', { ...FY, groupId: G.SUNDRY_DEBTORS, limit: 200 }, 15, true],
      ['Bills of a party', 'outstanding.ledgerBills', { ledgerId: debtors[0], asOf: TODAY }, 20, true],
      ['Stock item vouchers', 'stock.itemVouchers', { ...FY, itemId: anItem }, 30, true],
      // P&L › Sales Accounts › Sales: a drill-down too (measured 110–130 ms for its 30,000 lines).
      ['Ledger (Sales, 30,000 lines)', 'reports.ledger', { ...FY, ledgerId: L.SALES }, 20, true],
      ['Trial Balance', 'reports.trialBalance', { ...FY, mode: 'detailed' }, 40, false],
      ['Balance Sheet', 'reports.balanceSheet', { asOf: TODAY }, 40, false],
      ['Profit & Loss', 'reports.profitLoss', FY, 40, false],
      ['GSTR-1 (month)', 'gst.gstr1.summary', { period: '062026' }, 30, false],
      ['GSTR-3B (month, credit chained from the books beginning)', 'gst.gstr3b.summary', { period: '062026' }, 250, false],
      ['TDS outstanding', 'tds.outstanding', { asOf: TODAY, kind: 'tds' }, 15, false],
      ['TDS return data (26Q Q1)', 'tds.return.data', { form: '26Q', fyStart: 2026, quarter: 1 }, 15, false],
      ['Forex outstanding', 'forex.outstanding', { asOf: TODAY }, 25, false],
      ['Forex revaluation', 'forex.revaluation.report', { asOf: TODAY, rates: [{ currencyId: usd, rate: 85 }] }, 25, false],
      ['ITC-04 (100 challan lines)', 'mfg.itc04.report', { from: '2026-04-01', to: '2026-09-30' }, 25, false],
      ['Pending job work', 'mfg.jobWork.pending', { asOf: TODAY }, 20, false],
      ['Bills pending', 'documents.billsPending', { kind: 'sales', asOf: TODAY }, 10, false],
      ['Budget variance', 'documents.budget.variance', { budgetId: 1 }, 20, false],
    ];
    const report: string[] = [];
    for (const [label, route, input, maxStatements, drill] of calls) {
      rec.start();
      const t0 = performance.now();
      await t.callOk(routes, route, input);
      const ms = performance.now() - t0;
      const n = rec.stop().length;
      report.push(`${label} ${ms.toFixed(0)} ms/${n}`);
      assert.ok(n <= maxStatements, `${label}: ${n} statements (bound ${maxStatements})`);
      // Generous for loaded CI runners; the targets are 1 s cold and 150 ms for a drill-down.
      assert.ok(ms < (drill ? 1_000 : 4_000), `${label} took ${ms.toFixed(0)} ms`);
    }
    console.log(`# reports on 60,000 vouchers, every feature on (cold ms / statements): ${report.join(' · ')}`);
  });
});

// ───────────────────────────── The fixed look-ups, one by one (small companies) ─────────────────────────────

describe('performance: each hook / report look-up fixed in the final wave stays indexed', () => {
  it('TDS journal on a bill booked gross: the bill’s own TDS line and the payable ledger by their indexes (was: every line of the section)', async () => {
    const { setupTds, purchase, save: tdsSave } = await import('../tds/testkit.ts');
    const k = setupTds();
    const bill = tdsSave(k, purchase(k, '2026-06-05', k.L.contractor, k.L.contractExp, 1_00_000_00, 'SC-9', { tds: { overrides: [{ natureId: k.N['194C'], amount: 0, reason: 'deducted later' }] } }));
    assert.ok(bill.id > 0);
    const payable = k.t.db.value<number>(`SELECT id FROM ledgers WHERE name = 'TDS Payable – 194C'`);
    assert.ok(payable);
    const rec = recordSql(k.t.db);
    rec.start();
    const j = tdsSave(k, {
      voucherTypeId: k.vt.journal,
      date: '2026-06-20',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.contractor, amount: 2_000_00, billAllocations: [{ refType: 'against', billName: 'SC-9', amount: 2_000_00 }] },
        { ledgerId: payable, amount: -2_000_00 },
      ],
    });
    const statements = rec.stop();
    assert.ok(statements.some((s) => /FROM tds_lines .*WHERE voucher_id = :v AND kind = 'tds'/.test(s.sql.replace(/\s+/g, ' '))), 'the bill-line look-up ran');
    assert.ok(statements.some((s) => /FROM tds_ledger_details WHERE payable_kind/.test(s.sql)), 'the payable look-up ran');
    assert.deepEqual(allPlanProblems(k.t.db, statements, 'TDS journal'), []);
    assert.equal(k.t.db.value('SELECT bill_voucher_id FROM tds_lines WHERE voucher_id = :id', { id: j.id }), bill.id);

    // The TDS reports read the period through (kind, date) — with and without a kind.
    rec.start();
    const { computation, outstanding } = await import('../tds/reports.ts');
    computation(k.t.db, { from: '2026-06-01', to: '2026-06-30', today: k.t.today });
    computation(k.t.db, { from: '2026-06-01', to: '2026-06-30', kind: 'tds', today: k.t.today });
    outstanding(k.t.db, { asOf: '2026-06-30', kind: 'tds', today: k.t.today });
    const reads = rec.stop().filter((s) => /FROM tds_lines tl/.test(s.sql));
    assert.ok(reads.length >= 2);
    for (const s of reads) assert.deepEqual(allPlanProblems(k.t.db, [s], 'TDS report'), []);
    k.t.close();
  });

  it('cheque payment: the next leaf from the bank’s cheque lines only (was: every entry of the bank ledger)', async () => {
    const { chequeKit } = await import('../cheques/testkit.ts');
    const k = chequeKit();
    saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 1, toNo: 100 });
    k.pay({ amount: 1_000_00 });
    const rec = recordSql(k.t.db);
    rec.start();
    const second = k.pay({ amount: 2_000_00 });
    const statements = rec.stop();
    assert.equal(k.t.db.value("SELECT instrument_no FROM ledger_entries WHERE voucher_id = :id AND instrument_type = 'cheque'", { id: second.id }), '000002');
    assert.ok(statements.some((s) => /idx_le_cheques/.test(s.sql)));
    assert.deepEqual(allPlanProblems(k.t.db, statements, 'cheque payment'), []);
    k.t.close();
  });

  it('forex revaluation report: the posted revaluations drive the join (was: a scan of every voucher)', async () => {
    const { forexCompany } = await import('../forex/testkit.ts');
    const { forexRevaluation } = await import('../forex/reports.ts');
    const f = forexCompany();
    const rec = recordSql(f.t.db);
    rec.start();
    forexRevaluation(f.t.db, f.t.today, { asOf: f.t.today });
    const statements = rec.stop().filter((s) => /forex_revaluations/.test(s.sql));
    assert.equal(statements.length, 1);
    assert.deepEqual(allPlanProblems(f.t.db, statements, 'forex revaluation'), []);
    f.t.close();
  });

  it('deleting a voucher finds its reconciliation decisions and the e-way bill check finds the number by index', () => {
    const t = createTestCompany();
    const plan = (sql: string): string =>
      t.db
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
        .map((r) => r.detail)
        .join(' | ');
    // ON DELETE CASCADE look-up of gstrecon_decisions.voucher_id (migration 241).
    assert.doesNotMatch(plan('DELETE FROM vouchers WHERE id = 1'), /SCAN/);
    assert.match(plan('SELECT id FROM gstrecon_decisions WHERE voucher_id = 1'), /idx_gstrecon_decisions_voucher/);
    assert.match(plan("SELECT id FROM vouchers v WHERE v.eway_bill_no = '391000000001' AND v.id <> 5 LIMIT 1"), /idx_vouchers_eway/);
    t.close();
  });

  it('recording an e-way bill: the "already on another voucher" check runs through idx_vouchers_eway (the real statement)', async () => {
    const { setupParties, insertDoc } = await import('../gst/testkit.ts');
    const { updateEwayBill } = await import('../gst/ewaybill.ts');
    const { t, P } = setupParties({ today: '2026-04-20' });
    const doc = (number: string): number =>
      insertDoc(t, { type: 'sales', number, date: '2026-04-15', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '72081000', qty: 100, rate: 18, taxable: 60_000_00, cgst: 5_400_00, sgst: 5_400_00 }] });
    const first = doc('E-1');
    const second = doc('E-2');
    updateEwayBill(t.ctx, { voucherId: first, ewayBillNo: '391000000001', date: '2026-04-15' });
    const rec = recordSql(t.db);
    rec.start();
    updateEwayBill(t.ctx, { voucherId: second, ewayBillNo: '391000000002', date: '2026-04-15' });
    const statements = rec.stop();
    const check = statements.filter((s) => /WHERE v\.eway_bill_no = :no/.test(s.sql));
    assert.equal(check.length, 1, 'the uniqueness check ran');
    assert.deepEqual(allPlanProblems(t.db, statements, 'e-way bill'), []);
    assert.ok(queryPlan(t.db, check[0]).some((p) => p.includes('idx_vouchers_eway')), queryPlan(t.db, check[0]).join(' | '));
    t.close();
  });

  it('ITC-04 runs the same statements for 4 or 40 challan lines (was: two GST look-ups per line)', async () => {
    const { mfgKit, post } = await import('../mfg/testkit.ts');
    const { itc04 } = await import('../mfg/jobwork.ts');
    const k = mfgKit();
    const send = (n: number, from: number): void => {
      for (let i = 0; i < n; i++) {
        post(k, {
          voucherTypeId: k.VT.materialOut,
          date: `2026-05-${String(1 + ((from + i) % 28)).padStart(2, '0')}`,
          mode: 'inventory',
          partyLedgerId: k.L.ravi,
          stockJournal: { thirdPartyGodownId: k.G.ravi, process: 'Fabrication', lines: [{ role: 'transfer', itemId: i % 2 ? k.I.steel : k.I.paint, qty: 1, goodsType: 'inputs' }] },
        });
      }
    };
    const rec = recordSql(k.t.db);
    const count = (): { lines: number; statements: number } => {
      rec.start();
      const r = itc04(k.t.db, k.t.today, { from: '2026-04-01', to: '2026-09-30' });
      return { lines: r.sent.length, statements: rec.stop().length };
    };
    send(4, 0);
    const few = count();
    send(36, 4);
    const many = count();
    assert.deepEqual([few.lines, many.lines], [4, 40]);
    assert.equal(many.statements, few.statements, `${few.statements} statements for 4 lines, ${many.statements} for 40`);
    k.t.close();
  });
});
