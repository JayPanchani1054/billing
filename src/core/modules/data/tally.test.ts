/**
 * Tally XML migration: parsing helpers, preview (no writes) and the import of the hand-written
 * "Shree Ganesh Appliances" export (tallyFixture.ts — every figure there is hand-verified).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TallyImportResult, TallyProgress } from '../../../shared/types/data.ts';
import type { TrialBalanceResult } from '../../../shared/types/reports.ts';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { reportsRoutes } from '../reports/routes.ts';
import { dataRoutes } from './routes.ts';
import { ACME_GSTIN, DELHI_GSTIN, SUPREME_GSTIN, tallyFixtureBytes, tallyFixtureXml, utf16le } from './tallyFixture.ts';
import { importTally, previewTally } from './tallyImport.ts';
import { creditDays, ourAmount, parseTallyFile, tallyAmount, tallyDate, tallyQty, tallyRate } from './tallyParse.ts';
import { verifyData } from './verify.ts';
import { saveVoucher } from '../vouchers/service.ts';
import { setPeriodLock } from '../company/service.ts';

let t: TestCompany;
beforeEach(() => {
  t = createTestCompany({ today: '2026-10-05', booksFrom: '2026-04-01', name: 'Shree Ganesh Appliances' });
});
afterEach(() => t.close());

const FILE = 'Master.xml';

async function runImport(opts: Partial<{ masters: boolean; vouchers: boolean; from: string; to: string; onDuplicate: 'skip' | 'update' }> = {}, bytes = tallyFixtureBytes()): Promise<TallyImportResult> {
  return importTally(t.ctx, { fileName: FILE, bytes, options: { masters: true, vouchers: true, onDuplicate: 'skip', ...opts } });
}

const ledgerId = (name: string): number => {
  const id = t.db.value<number>('SELECT id FROM ledgers WHERE name = :name', { name });
  assert.ok(id, `ledger ${name} missing`);
  return id;
};

/** Closing balance in the books (opening + entries that count in the books), paise Dr +. */
const closing = (name: string): number =>
  t.db.value<number>(
    `SELECT l.opening_balance + COALESCE((SELECT SUM(le.amount) FROM ledger_entries le
              WHERE le.ledger_id = l.id AND le.affects_books = 1 AND (le.is_post_dated = 0 OR le.date <= '2026-10-05')), 0)
       FROM ledgers l WHERE l.name = :name`,
    { name },
  ) ?? NaN;

const pendingBills = (name: string): Record<string, number> => {
  const out: Record<string, number> = {};
  const id = ledgerId(name);
  for (const r of t.db.all<{ bill: string; amount: number }>(`SELECT bill_name AS bill, amount FROM opening_bills WHERE ledger_id = :id`, { id })) {
    out[r.bill] = (out[r.bill] ?? 0) + r.amount;
  }
  for (const r of t.db.all<{ bill: string; amount: number }>(`SELECT bill_name AS bill, amount FROM bill_allocations WHERE ledger_id = :id AND affects_books = 1`, { id })) {
    out[r.bill] = (out[r.bill] ?? 0) + r.amount;
  }
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
};

const stockQty = (item: string): number =>
  t.db.value<number>(
    `SELECT COALESCE((SELECT SUM(qty) FROM stock_openings WHERE item_id = i.id), 0)
          + COALESCE((SELECT SUM(qty) FROM inventory_entries WHERE item_id = i.id AND affects_stock = 1), 0)
       FROM stock_items i WHERE i.name = :item`,
    { item },
  ) ?? NaN;

describe('tally: value parsers', () => {
  it('amounts: Tally negative = Debit; ours is Dr +', () => {
    assert.equal(tallyAmount('-25000.00'), -25_000_00);
    assert.equal(ourAmount('-25000.00'), 25_000_00); // Dr ₹25,000
    assert.equal(ourAmount('233000.00'), -2_33_000_00); // Cr ₹2,33,000
    assert.equal(ourAmount('₹ 1,250.50 Dr'), 1_250_50);
    assert.equal(ourAmount('$ 10.00 = -₹ 800.00'), 800_00); // forex: the rupee part counts
    assert.equal(ourAmount('0'), 0);
    assert.equal(ourAmount(''), null);
    assert.equal(ourAmount('abc'), null);
  });

  it('quantities, rates, dates and credit periods', () => {
    assert.deepEqual(tallyQty(' 10 Nos'), { qty: 10, unit: 'Nos' });
    assert.deepEqual(tallyQty('2.500 Kg'), { qty: 2.5, unit: 'Kg' });
    assert.deepEqual(tallyQty('60 Nos = 5 Box'), { qty: 60, unit: 'Nos' });
    assert.deepEqual(tallyRate('2950.50/Nos'), { rate: 2950.5, per: 'Nos' });
    assert.deepEqual(tallyRate('$ 1.20 = ₹ 100.00/Nos'), { rate: 100, per: 'Nos' });
    assert.equal(tallyDate('20260405'), '2026-04-05');
    assert.equal(tallyDate('20260231'), null);
    assert.equal(creditDays('30 Days'), 30);
    assert.equal(creditDays('soon'), null);
  });
});

describe('tally: reading the file', () => {
  it('decodes UTF-16LE without a BOM (as Tally writes it) and finds every object', () => {
    const f = parseTallyFile(tallyFixtureBytes());
    assert.equal(f.encoding, 'utf-16le');
    assert.equal(f.companyName, 'Shree Ganesh Appliances');
    assert.equal(f.counts.LEDGER, 14);
    assert.equal(f.counts.VOUCHER, 11);
    assert.equal(f.counts.STOCKITEM, 2);
    const acme = f.ledgers.find((l) => l.name === 'Acme Traders');
    assert.equal(acme?.gstin, ACME_GSTIN);
  });

  it('reads the same export saved as UTF-8 too', () => {
    const f = parseTallyFile(new TextEncoder().encode(tallyFixtureXml()));
    assert.equal(f.encoding, 'utf-8');
    assert.equal(f.counts.VOUCHER, 11);
  });

  it('refuses a file that is not a Tally export, with directions', () => {
    assert.throws(
      () => parseTallyFile(utf16le('<html><body>hello</body></html>')),
      (e: unknown) => e instanceof AppError && /Gateway/.test(e.message),
    );
    assert.throws(() => parseTallyFile(new Uint8Array()), AppError);
  });
});

describe('data.tally.preview', () => {
  it('counts objects, voucher types, the date range and issues — and writes nothing', () => {
    const ledgersBefore = t.db.value<number>('SELECT COUNT(*) FROM ledgers');
    const auditBefore = t.db.value<number>('SELECT COUNT(*) FROM audit_log');
    const p = previewTally(t.ctx, { fileName: FILE, bytes: tallyFixtureBytes() });
    assert.equal(p.encoding, 'utf-16le');
    assert.equal(p.companyName, 'Shree Ganesh Appliances');
    assert.equal(p.counts.GROUP, 3);
    assert.equal(p.counts.UNIT, 4);
    assert.deepEqual(p.dateRange, { from: '2026-04-03', to: '2026-05-15' });
    const sales = p.vouchersByType.find((v) => v.voucherType === 'Sales');
    assert.deepEqual(sales, { voucherType: 'Sales', baseType: 'sales', count: 3 });
    assert.equal(p.vouchersByType.find((v) => v.voucherType === 'GST Sales')?.baseType, 'sales');
    assert.deepEqual(p.unsupported, [{ type: 'BUDGET', count: 1 }]);
    const bad = p.issues.find((i) => i.code === 'unbalanced');
    assert.equal(bad?.severity, 'error');
    assert.match(bad?.object ?? '', /J-BAD/);
    assert.match(bad?.message ?? '', /10\.00/); // Dr 100 vs Cr 90
    // Cash, Profit & Loss A/c and the Sundry Debtors group exist already (predefined).
    assert.ok(p.existing.ledgers >= 2);
    assert.ok(p.samples.ledgers.length > 0);
    assert.ok(p.samples.vouchers.length > 0);
    assert.equal(t.db.value('SELECT COUNT(*) FROM ledgers'), ledgersBefore);
    assert.equal(t.db.value('SELECT COUNT(*) FROM import_batches'), 0);
    assert.equal(t.db.value('SELECT COUNT(*) FROM audit_log'), auditBefore);
  });

  it('runs through the dispatcher and needs data.import', async () => {
    const ok = await t.call(dataRoutes, 'data.tally.preview', { fileName: FILE, bytes: tallyFixtureBytes() });
    assert.equal(ok.ok, true);
    const denied = await t.call(dataRoutes, 'data.tally.preview', { fileName: FILE, bytes: tallyFixtureBytes() }, { session: t.sessionAs({ permissions: ['masters.view'] }) });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN');
  });
});

describe('data.tally.import: masters', () => {
  it('creates groups, parties, banks, tax ledgers, units, godowns and items in dependency order', async () => {
    const r = await runImport({ vouchers: false });
    assert.equal(r.stopped, false);
    assert.equal(r.vouchers.created, 0);
    // Custom sub-group under the predefined Sundry Debtors; a new primary expense group.
    assert.equal(
      t.db.value(`SELECT p.name FROM groups g JOIN groups p ON p.id = g.parent_id WHERE g.name = 'Mumbai Debtors'`),
      'Sundry Debtors',
    );
    assert.equal(t.db.value(`SELECT parent_id FROM groups WHERE name = 'Branch Expenses'`), null);
    // Party with GSTIN, address, contact details, credit days and bill-wise opening bills.
    const acme = t.db.get<Record<string, unknown>>(
      `SELECT l.gstin, l.state_code, l.pan, l.pincode, l.mobile, l.email, l.contact_person, l.maintain_bill_wise, l.default_credit_days,
              l.opening_balance, g.name AS grp
         FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.name = 'Acme Traders'`,
    );
    assert.deepEqual(acme, {
      gstin: ACME_GSTIN,
      state_code: '27',
      pan: 'AAFCA4321B',
      pincode: '411001',
      mobile: '9876543210',
      email: 'accounts@acme.example',
      contact_person: 'Ravi Kumar',
      maintain_bill_wise: 1,
      default_credit_days: 30,
      opening_balance: 25_000_00, // Tally -25000.00 = Dr
      grp: 'Mumbai Debtors',
    });
    assert.deepEqual(
      t.db.all(`SELECT bill_name, bill_date, amount FROM opening_bills WHERE ledger_id = :id ORDER BY bill_name`, { id: ledgerId('Acme Traders') }),
      [
        { bill_name: 'INV-0911', bill_date: '2026-02-10', amount: 10_000_00 },
        { bill_name: 'INV-0950', bill_date: '2026-03-05', amount: 15_000_00 },
      ],
    );
    // GSTIN from LEDGSTREGDETAILS.LIST; another state's party.
    assert.equal(t.db.value(`SELECT gstin FROM ledgers WHERE name = 'Supreme Suppliers'`), SUPREME_GSTIN);
    assert.deepEqual(t.db.get(`SELECT gstin, state_code FROM ledgers WHERE name = 'Delhi Distributors'`), { gstin: DELHI_GSTIN, state_code: '07' });
    // Bank details.
    assert.deepEqual(t.db.get(`SELECT bank_account_no, bank_ifsc, bank_branch, opening_balance FROM ledgers WHERE name = 'HDFC Bank'`), {
      bank_account_no: '50100012345678',
      bank_ifsc: 'HDFC0000001',
      bank_branch: 'MG Road',
      opening_balance: 1_50_000_00,
    });
    // GST duty ledgers.
    assert.deepEqual(
      t.db.all(`SELECT name, tax_type, gst_duty_head FROM ledgers WHERE name IN ('CGST','SGST','IGST') ORDER BY name`),
      [
        { name: 'CGST', tax_type: 'GST', gst_duty_head: 'CGST' },
        { name: 'IGST', tax_type: 'GST', gst_duty_head: 'IGST' },
        { name: 'SGST', tax_type: 'GST', gst_duty_head: 'SGST' },
      ],
    );
    // Items with GST and opening stock: Mixer 10 × 2,400 = 24,000; Rice 40 × 1,100 = 44,000.
    assert.deepEqual(
      t.db.all(
        `SELECT i.name, i.gst_rate, i.hsn_sac, u.symbol, SUM(o.qty) AS qty, SUM(o.value) AS value
           FROM stock_items i JOIN units u ON u.id = i.unit_id JOIN stock_openings o ON o.item_id = i.id GROUP BY i.id ORDER BY i.name`,
      ),
      [
        { name: 'Mixer Grinder 750W', gst_rate: 18, hsn_sac: '8509', symbol: 'Nos', qty: 10, value: 24_000_00 },
        { name: 'Rice Bag 25kg', gst_rate: 5, hsn_sac: '1006', symbol: 'Nos', qty: 40, value: 44_000_00 },
      ],
    );
    assert.equal(t.db.value(`SELECT g.name FROM stock_openings o JOIN godowns g ON g.id = o.godown_id JOIN stock_items i ON i.id = o.item_id WHERE i.name = 'Rice Bag 25kg'`), 'Bhiwandi Warehouse');
  });

  it("maps Tally's Cash and Profit & Loss A/c to the reserved ledgers (no duplicates)", async () => {
    await runImport({ vouchers: false });
    assert.equal(t.db.value(`SELECT COUNT(*) FROM ledgers WHERE name LIKE 'Cash%'`), 1);
    assert.equal(t.db.value(`SELECT opening_balance FROM ledgers WHERE id = :id`, { id: t.ids.ledgers.CASH }), 20_000_00);
    assert.equal(t.db.value(`SELECT COUNT(*) FROM ledgers WHERE name LIKE 'Profit%'`), 1);
  });

  it('openings agree: Σ ledgers = −opening stock (no "difference in opening balances")', async () => {
    await runImport({ vouchers: false });
    // 20,000 + 1,50,000 + 25,000 − 30,000 − 2,33,000 = −68,000; stock 24,000 + 44,000 = 68,000.
    assert.equal(t.db.value('SELECT SUM(opening_balance) FROM ledgers'), -68_000_00);
    assert.equal(t.db.value('SELECT SUM(value) FROM stock_openings'), 68_000_00);
  });
});

describe('data.tally.import: vouchers', () => {
  it('imports every voucher as recorded; the books balance (Σ entries = 0, TB agrees)', async () => {
    const r = await runImport();
    assert.equal(r.vouchers.created, 10); // 11 − J-BAD
    assert.equal(r.vouchers.failed, 1);
    assert.ok(r.issues.some((i) => i.code === 'unbalanced' && /J-BAD/.test(i.object ?? '')));
    assert.equal(t.db.value(`SELECT COUNT(*) FROM vouchers WHERE number = 'J-BAD'`), 0);
    assert.equal(t.db.value('SELECT SUM(amount) FROM ledger_entries'), 0);
    assert.equal(t.db.value('SELECT COUNT(*) FROM (SELECT voucher_id FROM ledger_entries GROUP BY voucher_id HAVING SUM(amount) <> 0)'), 0);
    // Hand-verified closings (fixture header):
    assert.equal(closing('Acme Traders'), 11_963_00); // 25,000 + 10,445 − 20,000 − 3,482
    assert.equal(closing('Supreme Suppliers'), -23_100_00); // −30,000 + 30,000 − 23,100
    assert.equal(closing('Delhi Distributors'), 13_125_00);
    assert.equal(closing('Cash'), 15_000_00); // 20,000 − 5,000
    assert.equal(closing('HDFC Bank'), 1_45_000_00); // 1,50,000 + 20,000 − 30,000 + 5,000
    assert.equal(closing('Sales GST 18%'), -5_901_00); // −8,851.50 + 2,950.50
    assert.equal(closing('CGST'), 18_91); // −796.64 + 550 + 265.55
    assert.equal(closing('Round Off'), 18); // −0.22 + 0.40
    assert.equal(closing('Office Rent'), 12_000_00);
    assert.equal(closing('Capital - Ramesh Patil'), -2_45_000_00); // −2,33,000 − 12,000
    // TB: Σ closing of all ledgers + opening stock = 0.
    const sumClosing = t.db.value<number>(
      `SELECT SUM(opening_balance) + (SELECT SUM(amount) FROM ledger_entries WHERE affects_books = 1) FROM ledgers`,
    );
    assert.equal(sumClosing, -68_000_00);
    const tb = await t.callOk<TrialBalanceResult>(reportsRoutes, 'reports.trialBalance', { from: '2026-04-01', to: '2027-03-31' });
    assert.equal(tb.openingDifference, 0);
    assert.equal(tb.balanced, true);
    assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
  });

  it('pending bills and stock quantities come out right', async () => {
    await runImport();
    // Acme: INV-0911 10,000 − 10,000 = 0; INV-0950 15,000 − 3,482 = 11,518; S-1 10,445 − 10,000 = 445.
    assert.deepEqual(pendingBills('Acme Traders'), { 'INV-0950': 11_518_00, 'S-1': 445_00 });
    assert.deepEqual(pendingBills('Supreme Suppliers'), { 'SS/2026/501': -23_100_00 });
    assert.deepEqual(pendingBills('Delhi Distributors'), { 'GS-1': 13_125_00 });
    // Mixer 10 − 3 + 1 = 8 (the optional S-3 does not move stock); Rice 40 + 20 − 10 = 50.
    assert.equal(stockQty('Mixer Grinder 750W'), 8);
    assert.equal(stockQty('Rice Bag 25kg'), 50);
  });

  it('keeps GST exactly as recorded (never recomputed) and derives gst_lines from the duty ledgers', async () => {
    await runImport();
    const id = t.db.value<number>(`SELECT id FROM vouchers WHERE number = 'S-1'`);
    // 8,851.50 × 9% = 796.635 → Tally recorded 796.64 for each head.
    assert.deepEqual(t.db.get(`SELECT hsn_sac, rate, taxable_value, cgst, sgst, igst FROM gst_lines WHERE voucher_id = :id`, { id }), {
      hsn_sac: '8509',
      rate: 18,
      taxable_value: 8_851_50,
      cgst: 796_64,
      sgst: 796_64,
      igst: 0,
    });
    assert.equal(t.db.value(`SELECT amount FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :l`, { id, l: ledgerId('Round Off') }), -22);
    const gs = t.db.get<{ igst: number; place_of_supply: string }>(
      `SELECT g.igst, v.place_of_supply FROM gst_lines g JOIN vouchers v ON v.id = g.voucher_id WHERE v.number = 'GS-1'`,
    );
    assert.deepEqual(gs, { igst: 625_00, place_of_supply: '07' }); // 12,500 × 5%
  });

  it('preserves numbers, references, instruments, cost centres; marks the source; optional and cancelled stay out of the books', async () => {
    await runImport();
    const p1 = t.db.get<{ reference_no: string; meta: string }>(`SELECT reference_no, meta FROM vouchers WHERE number = 'P-1'`);
    assert.equal(p1?.reference_no, 'SS/2026/501');
    const meta = JSON.parse(p1?.meta ?? '{}');
    assert.equal(meta.source, 'tally');
    assert.equal(typeof meta.importBatchId, 'number');
    assert.deepEqual(
      t.db.get(`SELECT instrument_type, instrument_no FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id WHERE v.number = 'R-1' AND le.instrument_no IS NOT NULL`),
      { instrument_type: 'cheque', instrument_no: '123456' },
    );
    assert.deepEqual(t.db.get(`SELECT c.name, a.amount FROM cost_allocations a JOIN cost_centres c ON c.id = a.cost_centre_id`), { name: 'Mumbai Branch', amount: 12_000_00 });
    assert.deepEqual(t.db.get(`SELECT is_optional, affects_books, affects_stock FROM vouchers WHERE number = 'S-3'`), { is_optional: 1, affects_books: 0, affects_stock: 0 });
    assert.deepEqual(t.db.get(`SELECT is_cancelled, affects_books FROM vouchers WHERE number = 'S-4'`), { is_cancelled: 1, affects_books: 0 });
    assert.equal(t.db.value(`SELECT COUNT(*) FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id WHERE v.number = 'S-4'`), 0);
  });

  it('writes one "import" audit entry and an import batch; the edit log stays valid', async () => {
    const before = t.db.value<number>('SELECT COUNT(*) FROM audit_log') ?? 0;
    const r = await runImport();
    assert.equal(t.db.value('SELECT COUNT(*) FROM audit_log') as number, before + 1);
    assert.equal(t.db.value(`SELECT action FROM audit_log ORDER BY id DESC LIMIT 1`), 'import');
    assert.equal(t.db.value('SELECT kind FROM import_batches WHERE id = :id', { id: r.batchId }), 'tally_xml');
    assert.equal(verifyData(t.ctx).checks.find((c) => c.name === 'audit_chain')?.ok, true);
  });

  it('importing the same file again skips what exists (no duplicate vouchers)', async () => {
    await runImport();
    const r2 = await runImport();
    assert.equal(r2.vouchers.created, 0);
    assert.equal(r2.vouchers.skipped, 10);
    assert.equal(t.db.value('SELECT COUNT(*) FROM vouchers'), 10);
    assert.equal(closing('Acme Traders'), 11_963_00);
  });

  it('a date range limits the vouchers (April only)', async () => {
    const r = await runImport({ from: '2026-04-01', to: '2026-04-30' });
    assert.equal(r.vouchers.created, 7); // P-1, S-1, GS-1, R-1, PY-1, C-1, J-1
    assert.equal(t.db.value(`SELECT MAX(date) FROM vouchers`), '2026-04-30');
  });

  it('vouchers without their masters are reported, not half-imported', async () => {
    const r = await runImport({ masters: false });
    assert.ok(r.vouchers.failed > 0);
    assert.ok(r.issues.some((i) => i.severity === 'error'));
    assert.equal(t.db.value('SELECT COUNT(*) FROM (SELECT voucher_id FROM ledger_entries GROUP BY voucher_id HAVING SUM(amount) <> 0)'), 0);
  });

  it('the data check passes on the imported books', async () => {
    await runImport();
    const v = verifyData(t.ctx);
    assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.ok)));
  });

  it('runs through the dispatcher (async, non-transactional) and needs data.import', async () => {
    const input = { fileName: FILE, bytes: tallyFixtureBytes(), options: { vouchers: true, onDuplicate: 'skip' } };
    const denied = await t.call(dataRoutes, 'data.tally.import', input, { session: t.sessionAs({ permissions: ['masters.view'] }) });
    assert.equal(denied.ok, false);
    const r = await t.callOk<TallyImportResult>(dataRoutes, 'data.tally.import', input);
    assert.equal(r.vouchers.created, 10);
    const prog = await t.callOk<TallyProgress>(dataRoutes, 'data.tally.progress');
    assert.equal(prog.running, false);
    assert.equal(prog.phase, 'done');
  });
});

/** The fixture's masters plus hand-written vouchers (Accounting Voucher View, amounts negative = Dr). */
function withVouchers(vouchersXml: string): Uint8Array {
  const xml = tallyFixtureXml({ vouchers: false }).replace('</REQUESTDATA>', `${vouchersXml.replace(/\n/g, '\r\n')}\r\n   </REQUESTDATA>`);
  return utf16le(xml);
}

const payment = (guid: string, num: string, date: string, rupees: string): string => `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER REMOTEID="${guid}" VCHTYPE="Payment" ACTION="Create">
      <DATE>${date}</DATE>
      <GUID>${guid}</GUID>
      <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${num}</VOUCHERNUMBER>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>Office Rent</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <AMOUNT>-${rupees}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>Cash</LEDGERNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <AMOUNT>${rupees}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
     </VOUCHER>
    </TALLYMESSAGE>`;

describe('data.tally.import: repeated numbers and existing vouchers', () => {
  it('Tally vouchers sharing a number (different GUIDs) are all imported; a re-import skips them all', async () => {
    // Tally lets Payment vouchers repeat numbers (manual numbering). Three payments, two numbered 7.
    const bytes = withVouchers(payment('g-pay-1', '7', '20260410', '1000.00') + payment('g-pay-2', '7', '20260411', '250.00') + payment('g-pay-3', '8', '20260412', '50.00'));
    const r = await runImport({}, bytes);
    assert.equal(r.vouchers.created, 3, JSON.stringify(r.issues.filter((i) => i.object?.startsWith('VOUCHER'))));
    // Office Rent: 1,000 + 250 + 50 = 1,300 Dr (no opening in the fixture's rent ledger).
    assert.equal(closing('Office Rent'), 1_300_00);
    const again = await runImport({}, bytes);
    assert.equal(again.vouchers.created, 0);
    assert.equal(again.vouchers.skipped, 3);
    assert.equal(t.db.value(`SELECT COUNT(*) FROM vouchers WHERE base_type = 'payment'`), 3);
  });

  it('"update existing" refreshes Tally vouchers but never overwrites a voucher entered in Bahi ERP', async () => {
    await runImport({ vouchers: false });
    const rent = ledgerId('Office Rent');
    const cash = t.db.value<number>(`SELECT id FROM ledgers WHERE reserved_code = 'CASH'`) as number;
    const paymentType = t.db.value<number>(`SELECT id FROM voucher_types WHERE name = 'Payment'`) as number;
    // Entered by hand in Bahi: a Payment on 10-Apr for ₹ 400.
    const own = saveVoucher(t.ctx, {
      voucherTypeId: paymentType,
      mode: 'ledger',
      date: '2026-04-10',
      acknowledgeWarnings: true,
      ledgers: [
        { ledgerId: rent, amount: 400_00 },
        { ledgerId: cash, amount: -400_00 },
      ],
    });
    // (Payment numbering is automatic, so the typed number may be replaced: use what was stored.)
    const ownNo = t.db.value<string>('SELECT number FROM vouchers WHERE id = :id', { id: own.id }) as string;
    assert.ok(ownNo);
    const bytes = withVouchers(payment('g-pay-9', ownNo, '20260410', '1000.00') + payment('g-pay-10', '10', '20260411', '300.00'));
    const skip = await runImport({ masters: false }, bytes);
    assert.equal(skip.vouchers.created, 1);
    assert.equal(skip.vouchers.skipped, 1);
    assert.ok(skip.issues.some((i) => i.code === 'number_exists' && i.severity === 'warning'), 'the skipped number clash is reported');

    const upd = await runImport({ masters: false, onDuplicate: 'update' }, withVouchers(payment('g-pay-9', ownNo, '20260410', '1000.00') + payment('g-pay-10', '10', '20260411', '350.00')));
    assert.equal(upd.vouchers.updated, 1); // only the Tally voucher 10 (300 → 350)
    assert.equal(upd.vouchers.skipped, 1);
    assert.ok(upd.issues.some((i) => i.code === 'number_exists'));
    // The hand-entered voucher is untouched: still ₹ 400 Dr to rent.
    assert.equal(t.db.value('SELECT amount FROM ledger_entries WHERE voucher_id = :id AND ledger_id = :l', { id: own.id, l: rent }), 400_00);
    // Rent = 400 (own) + 350 (Tally 10, updated) = 750 Dr.
    assert.equal(closing('Office Rent'), 750_00);
  });

  it('needs the same rights as entering by hand: back-dated vouchers, and alter rights for "update"', async () => {
    const clerk = t.sessionAs({ permissions: ['data.import', 'masters.view', 'masters.create', 'vouchers.view', 'vouchers.create'] });
    const input = { fileName: FILE, bytes: tallyFixtureBytes(), options: { vouchers: true, onDuplicate: 'skip' } };
    const r1 = await t.call(dataRoutes, 'data.tally.import', input, { session: clerk });
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.match(r1.error.message, /back-dated/);
    const senior = t.sessionAs({ permissions: ['data.import', 'masters.view', 'masters.create', 'vouchers.view', 'vouchers.create', 'vouchers.backdate'] });
    const r2 = await t.call(dataRoutes, 'data.tally.import', { ...input, options: { vouchers: true, onDuplicate: 'update' } }, { session: senior });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.match(r2.error.message, /alter masters/);
    assert.equal(t.db.value('SELECT COUNT(*) FROM vouchers'), 0, 'nothing was written');
    const r3 = await t.call(dataRoutes, 'data.tally.import', input, { session: senior });
    assert.equal(r3.ok, true, JSON.stringify(r3));
  });

  it('a Tally voucher in the locked period is not updated', async () => {
    const bytes = withVouchers(payment('g-pay-20', '20', '20260410', '100.00'));
    await runImport({}, bytes);
    t.db.transaction(() => setPeriodLock(t.ctx, '2026-04-30'));
    const r = await runImport({ masters: false, onDuplicate: 'update' }, withVouchers(payment('g-pay-20', '20', '20260410', '999.00')));
    assert.equal(r.vouchers.updated, 0);
    assert.equal(closing('Office Rent'), 100_00);
  });

  it('imported numbers advance the numbering counter, so the next automatic number follows them', async () => {
    await runImport({}, withVouchers(payment('g-pay-30', '41', '20260410', '10.00') + payment('g-pay-31', '42', '20260411', '10.00')));
    const paymentType = t.db.value<number>(`SELECT id FROM voucher_types WHERE name = 'Payment'`) as number;
    assert.equal(t.db.value(`SELECT last_number FROM voucher_counters WHERE voucher_type_id = :id AND period_key = '2026-27'`, { id: paymentType }), 42);
  });
});

