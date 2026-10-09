/**
 * A full financial year (FY 2026-27) of a Maharashtra (27) trader, entered ONLY through
 * runtime.dispatch — the same routes the renderer calls. Used by business-year.test.ts.
 *
 * Company: Sahyadri Trading Co (regular GST, 27), books from 1-Apr-2026, security on (Owner logs in),
 * inventory integrated, bill-wise, cost centres, two godowns, batches, tracking numbers.
 *
 * Opening balances (1-Apr-2026), paise in comments as rupees:
 *   HDFC Bank Dr 8,00,000 · Cash Dr 50,000 · Furniture Dr 3,00,000
 *   Mumbai Retail Mart Dr 1,18,000 (bill OB-M1) · Pune Wholesale Cr 2,36,000 (bill OB-P1)
 *   Opening stock (items): Utensils 200 × 500 = 1,00,000 · Rice 300 × 1,500 = 4,50,000
 *     · Cigars 50 × 2,000 = 1,00,000 · Mixers 100 × 2,500 = 2,50,000 · Tonic batch B1 100 × 200 = 20,000
 *     → 9,20,000
 *   Partners' Capital Cr = 8,00,000 + 50,000 + 3,00,000 + 1,18,000 − 2,36,000 + 9,20,000 = 19,52,000
 *   so Σ ledger openings + opening stock = 0 (no "difference in opening balances").
 */
import assert from 'node:assert/strict';
import type { VoucherInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { makeGstin, testPan } from '../fixtures.ts';
import { FY_MONTHS, P, type E2E } from './harness.ts';

export const COMPANY_STATE = '27';
export const BOOKS_FROM = '2026-04-01';
export const FY_END = '2027-03-31';
export const OWNER = { username: 'owner', displayName: 'Anil Deshmukh', password: 'Sahyadri#2026' };

export interface World {
  e: E2E;
  companyId: string;
  /** Group ids by reserved code. */
  G: Record<string, number>;
  /** Ledger ids by short name. */
  L: Record<string, number>;
  /** Stock item ids by short name. */
  I: Record<string, number>;
  /** Godown ids. */
  GD: Record<string, number>;
  /** Cost centre ids. */
  CC: Record<string, number>;
  /** Voucher type ids by base type. */
  VT: Record<string, number>;
  /** Saved vouchers by short name. */
  V: Record<string, VoucherSaveResult & { input: VoucherInput }>;
  /** Count of voucher saves (creates) performed. */
  created: number;
  /** Confirm-level warnings acknowledged during the run, by voucher name (for the report). */
  acknowledged: Record<string, string[]>;
  /**
   * The scenario's OWN expectation of pending bills, kept independently of the app:
   * key `${ledgerKey}|${billName}` → signed paise (Dr +, Cr −) still pending.
   */
  bills: Record<string, number>;
}

/** Save a voucher through preview + save, acknowledging only 'confirm' warnings; block warnings fail. */
export async function post(w: World, name: string, input: VoucherInput): Promise<VoucherSaveResult & { input: VoucherInput }> {
  const preview = await w.e.call<{ warnings: Array<{ code: string; level: string; message: string }>; entries: Array<{ amount: number }> }>(
    'vouchers.preview',
    input,
  );
  const blocking = preview.warnings.filter((x) => x.level === 'block');
  assert.deepEqual(blocking, [], `${name}: blocking warnings`);
  assert.equal(
    preview.entries.reduce((a, x) => a + x.amount, 0),
    0,
    `${name}: preview entries must sum to 0`,
  );
  const confirm = preview.warnings.filter((x) => x.level === 'confirm');
  if (confirm.length) w.acknowledged[name] = confirm.map((x) => `${x.code}: ${x.message}`);
  const res = await w.e.call<VoucherSaveResult>('vouchers.save', { ...input, acknowledgeWarnings: confirm.length > 0 || undefined });
  const out = { ...res, input };
  assert.ok(!(name in w.V), `duplicate voucher name ${name}`);
  w.V[name] = out;
  if (!input.id) w.created++;
  return out;
}

async function ledger(w: World, key: string, input: Record<string, unknown>): Promise<number> {
  const d = await w.e.call<{ id: number }>('accounts.ledger.save', input);
  w.L[key] = d.id;
  return d.id;
}

async function item(w: World, key: string, input: Record<string, unknown>): Promise<number> {
  const d = await w.e.call<{ item: { id: number } }>('inventory.item.save', input);
  w.I[key] = d.item.id;
  return d.item.id;
}

export async function createCompany(e: E2E): Promise<World> {
  const state = await e.call<{ companies: Array<{ id: string }>; session: { username: string; isOwner: boolean } | null }>(
    'app.company.create',
    {
      name: 'Sahyadri Trading Co',
      address: '12 Laxmi Road, Shaniwar Peth',
      stateCode: COMPANY_STATE,
      pincode: '411030',
      gstRegistrationType: 'regular',
      gstin: makeGstin(COMPANY_STATE, testPan(100)),
      booksFrom: BOOKS_FROM,
      owner: OWNER,
    },
  );
  assert.equal(state.session?.username, OWNER.username, 'owner is logged in on creation');
  assert.equal(state.session?.isOwner, true);
  const w: World = { e, companyId: state.companies[0].id, G: {}, L: {}, I: {}, GD: {}, CC: {}, VT: {}, V: {}, created: 0, acknowledged: {}, bills: {} };

  await e.call('company.features.save', {
    inventory: true,
    integrateInventory: true,
    billWise: true,
    costCentres: true,
    multipleGodowns: true,
    batches: true,
    trackingNumbers: true,
  });
  await e.call('company.config.save', {
    gst: { lutNumber: 'AD270326001234X', lutValidFrom: '2026-04-01', lutValidTo: '2027-03-31' },
  });

  const groups = await e.call<{ rows: Array<{ id: number; reservedCode: string | null }> }>('accounts.group.list', {});
  for (const g of groups.rows) if (g.reservedCode) w.G[g.reservedCode] = g.id;
  const ledgers = await e.call<{ rows: Array<{ id: number; reservedCode: string | null }> }>('accounts.ledger.list', {});
  for (const l of ledgers.rows) if (l.reservedCode) w.L[l.reservedCode] = l.id;
  const types = await e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {});
  for (const t of types.rows) if (t.isPredefined) w.VT[t.baseType] = t.id;
  return w;
}

export async function createMasters(w: World): Promise<void> {
  const { e, G } = w;
  // ── Godowns & cost centres ──
  const godowns = await e.call<{ rows: Array<{ id: number; name: string }> }>('inventory.godown.list', {});
  w.GD.main = godowns.rows[0].id;
  w.GD.pune = (await e.call<{ id: number }>('inventory.godown.save', { name: 'Pune Warehouse', address: 'Hadapsar, Pune' })).id;
  const cats = await e.call<{ rows: Array<{ id: number }> }>('accounts.costCategory.list', {});
  w.CC.mumbai = (await e.call<{ id: number }>('accounts.costCentre.save', { name: 'Mumbai Branch', categoryId: cats.rows[0].id })).id;
  w.CC.pune = (await e.call<{ id: number }>('accounts.costCentre.save', { name: 'Pune Branch', categoryId: cats.rows[0].id })).id;

  // ── Capital, assets, bank, cash ──
  await e.call('accounts.ledger.save', { id: w.L.CASH, openingBalance: P(50_000) });
  await ledger(w, 'capital', { name: "Partners' Capital", groupId: G.CAPITAL_ACCOUNT, openingBalance: -P(19_52_000) });
  await ledger(w, 'bank', {
    name: 'HDFC Bank Current A/c',
    groupId: G.BANK_ACCOUNTS,
    openingBalance: P(8_00_000),
    bankAccountNo: '50200012345678',
    bankIfsc: 'HDFC0000123',
    bankName: 'HDFC Bank',
  });
  await ledger(w, 'furniture', { name: 'Furniture & Fixtures', groupId: G.FIXED_ASSETS, openingBalance: P(3_00_000) });
  await ledger(w, 'machinery', {
    name: 'Plant & Machinery',
    groupId: G.FIXED_ASSETS,
    gstApplicable: true,
    gstRate: 18,
    hsnSac: '8422',
    gstSupplyType: 'goods',
    itcEligibility: 'capital_goods',
  });

  // ── Customers ──
  await ledger(w, 'mumbai', {
    name: 'Mumbai Retail Mart',
    groupId: G.SUNDRY_DEBTORS,
    gstin: makeGstin('27', testPan(1)),
    registrationType: 'regular',
    address: 'Dadar West, Mumbai',
    pincode: '400028',
    defaultCreditDays: 30,
    openingBalance: P(1_18_000),
    openingBills: [{ billName: 'OB-M1', billDate: '2026-03-15', amount: P(1_18_000) }],
  });
  await ledger(w, 'blr', {
    name: 'Bengaluru Electronics',
    groupId: G.SUNDRY_DEBTORS,
    gstin: makeGstin('29', testPan(2)),
    registrationType: 'regular',
    address: 'Koramangala, Bengaluru',
    pincode: '560034',
    defaultCreditDays: 45,
  });
  await ledger(w, 'sez', {
    name: 'Gandhinagar SEZ Tech Pvt Ltd',
    groupId: G.SUNDRY_DEBTORS,
    gstin: makeGstin('24', testPan(3)),
    registrationType: 'sez',
    address: 'GIFT City SEZ, Gandhinagar',
    pincode: '382355',
  });
  await ledger(w, 'dubai', {
    name: 'Dubai Global Trading LLC',
    groupId: G.SUNDRY_DEBTORS,
    registrationType: 'overseas',
    country: 'United Arab Emirates',
    address: 'Deira, Dubai',
  });
  await ledger(w, 'walkin', { name: 'Walk-in Customers', groupId: G.SUNDRY_DEBTORS, stateCode: '27', registrationType: 'unregistered' });
  await ledger(w, 'delhiCust', {
    name: 'Rajesh Gupta (Delhi)',
    groupId: G.SUNDRY_DEBTORS,
    stateCode: '07',
    registrationType: 'unregistered',
    address: 'Karol Bagh, New Delhi',
    pincode: '110005',
  });

  // ── Suppliers ──
  await ledger(w, 'pune', {
    name: 'Pune Wholesale Suppliers',
    groupId: G.SUNDRY_CREDITORS,
    gstin: makeGstin('27', testPan(4)),
    registrationType: 'regular',
    defaultCreditDays: 30,
    openingBalance: -P(2_36_000),
    openingBills: [{ billName: 'OB-P1', billDate: '2026-03-20', amount: -P(2_36_000) }],
  });
  await ledger(w, 'delhi', {
    name: 'Delhi Appliances Co',
    groupId: G.SUNDRY_CREDITORS,
    gstin: makeGstin('07', testPan(5)),
    registrationType: 'regular',
    defaultCreditDays: 45,
  });
  await ledger(w, 'gta', {
    name: 'Speedy Roadways (GTA)',
    groupId: G.SUNDRY_CREDITORS,
    gstin: makeGstin('27', testPan(6)),
    registrationType: 'regular',
  });
  await ledger(w, 'machineVendor', {
    name: 'Mumbai Machines Ltd',
    groupId: G.SUNDRY_CREDITORS,
    gstin: makeGstin('27', testPan(7)),
    registrationType: 'regular',
  });
  await ledger(w, 'composition', {
    name: 'Nashik Kirana Supplier',
    groupId: G.SUNDRY_CREDITORS,
    gstin: makeGstin('27', testPan(8)),
    registrationType: 'composition',
  });
  await ledger(w, 'cloudsoft', {
    name: 'CloudSoft Inc (USA)',
    groupId: G.SUNDRY_CREDITORS,
    registrationType: 'overseas',
    country: 'United States of America',
  });
  await ledger(w, 'caterer', {
    name: 'Hotel Annapurna Caterers',
    groupId: G.SUNDRY_CREDITORS,
    gstin: makeGstin('27', testPan(9)),
    registrationType: 'regular',
  });

  // ── Income / expense / liability ledgers ──
  await ledger(w, 'gtaFreight', {
    name: 'Freight Inward (GTA)',
    groupId: G.DIRECT_EXPENSES,
    gstApplicable: true,
    gstRate: 5,
    hsnSac: '996511',
    gstSupplyType: 'services',
    isReverseCharge: true,
    itcEligibility: 'input_services',
  });
  await ledger(w, 'software', {
    name: 'Software Subscription',
    groupId: G.INDIRECT_EXPENSES,
    gstApplicable: true,
    gstRate: 18,
    hsnSac: '998315',
    gstSupplyType: 'services',
    itcEligibility: 'input_services',
  });
  await ledger(w, 'staffWelfare', {
    name: 'Staff Welfare (Food)',
    groupId: G.INDIRECT_EXPENSES,
    gstApplicable: true,
    gstRate: 5,
    hsnSac: '996331',
    gstSupplyType: 'services',
    itcEligibility: 'ineligible',
  });
  await ledger(w, 'rent', { name: 'Office Rent', groupId: G.INDIRECT_EXPENSES, costCentresApplicable: true });
  await ledger(w, 'salaries', { name: 'Salaries', groupId: G.INDIRECT_EXPENSES, costCentresApplicable: true });
  await ledger(w, 'depreciation', { name: 'Depreciation', groupId: G.INDIRECT_EXPENSES });
  await ledger(w, 'auditFees', { name: 'Audit Fees', groupId: G.INDIRECT_EXPENSES });
  await ledger(w, 'bankCharges', { name: 'Bank Charges', groupId: G.INDIRECT_EXPENSES });
  await ledger(w, 'interestIncome', { name: 'Interest on FD', groupId: G.INDIRECT_INCOMES });
  await ledger(w, 'auditProvision', { name: 'Provision for Audit Fees', groupId: G.PROVISIONS });

  // ── Stock items (opening stock at 1-Apr-2026) ──
  const units = await e.call<{ rows: Array<{ id: number; symbol: string }> }>('inventory.unit.list', {});
  const unit = (s: string): number => units.rows.find((u) => u.symbol === s)!.id;
  newBill(w, 'mumbai', 'OB-M1', P(1_18_000));
  newBill(w, 'pune', 'OB-P1', -P(2_36_000));

  await item(w, 'utensil', {
    name: 'Steel Utensil Set',
    unitId: unit('Nos'),
    gstApplicable: true,
    hsnSac: '7323',
    taxability: 'taxable',
    gstRate: 18,
    openings: [{ godownId: w.GD.main, qty: 200, rate: 500 }],
  });
  await item(w, 'rice', {
    name: 'Basmati Rice 25kg Bag',
    unitId: unit('Nos'),
    gstApplicable: true,
    hsnSac: '1006',
    taxability: 'taxable',
    gstRate: 5,
    openings: [{ godownId: w.GD.main, qty: 300, rate: 1500 }],
  });
  await item(w, 'cigar', {
    name: 'Premium Cigar Box',
    unitId: unit('Box'),
    gstApplicable: true,
    hsnSac: '2402',
    taxability: 'taxable',
    gstRate: 40,
    openings: [{ godownId: w.GD.main, qty: 50, rate: 2000 }],
  });
  await item(w, 'mixer', {
    name: 'Mixer Grinder 750W',
    unitId: unit('Nos'),
    gstApplicable: true,
    hsnSac: '8509',
    taxability: 'taxable',
    gstRate: 18,
    openings: [{ godownId: w.GD.main, qty: 100, rate: 2500 }],
  });
  await item(w, 'tonic', {
    name: 'Herbal Tonic 500ml',
    unitId: unit('Nos'),
    maintainBatches: true,
    gstApplicable: true,
    hsnSac: '3004',
    taxability: 'taxable',
    gstRate: 5,
    openings: [{ godownId: w.GD.main, batchName: 'B1', qty: 100, rate: 200 }],
  });
}

// ───────────────────────────── The year ─────────────────────────────

type Line = { itemId: number; qty: number; rate: number; godownId?: number; batchName?: string; trackingRef?: string; isConsumption?: boolean };

const day = (ym: string, d: number): string => `${ym}-${String(d).padStart(2, '0')}`;

function inv(w: World, base: string, date: string, partyKey: string, items: Line[], over: Partial<VoucherInput> = {}): VoucherInput {
  return { voucherTypeId: w.VT[base], date, mode: 'item_invoice', partyLedgerId: w.L[partyKey], items, ...over };
}

function acc(w: World, base: string, date: string, partyKey: string, lines: Array<{ ledgerKey: string; amount: number }>, over: Partial<VoucherInput> = {}): VoucherInput {
  return {
    voucherTypeId: w.VT[base],
    date,
    mode: 'accounting_invoice',
    partyLedgerId: w.L[partyKey],
    ledgers: lines.map((l) => ({ ledgerId: w.L[l.ledgerKey], amount: l.amount })),
    ...over,
  };
}

function led(w: World, base: string, date: string, ledgers: VoucherInput['ledgers'], over: Partial<VoucherInput> = {}): VoucherInput {
  return { voucherTypeId: w.VT[base], date, mode: 'ledger', ledgers, ...over };
}

/** Record a new bill in the scenario's own expectation (Dr + for receivables, Cr − for payables). */
function newBill(w: World, partyKey: string, billName: string, signed: number): void {
  const k = `${partyKey}|${billName}`;
  w.bills[k] = (w.bills[k] ?? 0) + signed;
}

/** Receipt (bank) from a customer settling `amount` of a bill. */
async function receiptAgainst(w: World, name: string, date: string, partyKey: string, billName: string, amount: number, ref: string): Promise<void> {
  await post(
    w,
    name,
    led(w, 'receipt', date, [
      { ledgerId: w.L.bank, amount, instrument: { type: 'neft', number: ref } },
      { ledgerId: w.L[partyKey], amount: -amount, billAllocations: [{ refType: 'against', billName, amount }] },
    ]),
  );
  w.bills[`${partyKey}|${billName}`] -= amount;
}

/** Payment (bank) to a supplier settling `amount` of a bill. */
async function paymentAgainst(w: World, name: string, date: string, partyKey: string, billName: string, amount: number, ref: string): Promise<void> {
  await post(
    w,
    name,
    led(w, 'payment', date, [
      { ledgerId: w.L[partyKey], amount, billAllocations: [{ refType: 'against', billName, amount }] },
      { ledgerId: w.L.bank, amount: -amount, instrument: { type: 'neft', number: ref } },
    ]),
  );
  w.bills[`${partyKey}|${billName}`] += amount;
}

const pendingOf = (w: World, partyKey: string, billName: string): number => w.bills[`${partyKey}|${billName}`] ?? 0;

/**
 * Twelve routine vouchers a month (144 in the year) — invoice values worked out once:
 *   Purchase Pune (intra):  Rice 100 × 1,400 = 1,40,000 @5% → C 3,500 + S 3,500;
 *                           Utensils 60 × 480 = 28,800 @18% → C 2,592 + S 2,592          → 1,80,984.00
 *   Purchase Delhi (inter): Mixers 30 × 2,300 = 69,000 @18% → I 12,420;
 *                           Cigars 15 × 1,900 = 28,500 @40% → I 11,400                    → 1,21,320.00
 *   Sale Mumbai (intra):    Rice 90 × 1,800 = 1,62,000 @5% → C 4,050 + S 4,050;
 *                           Utensils 40 × 750 = 30,000 @18% → C 2,700 + S 2,700           → 2,05,500.00
 *   Sale Bengaluru (inter): Mixers 25 × 3,200 = 80,000 @18% → I 14,400;
 *                           Cigars 12 × 3,000 = 36,000 @40% → I 14,400                    → 1,44,800.00
 *   Cash sale (B2CS):       Utensils 6 × 800 = 4,800 @18% → C 432 + S 432;
 *                           Tonic 10 × 300 = 3,000 @5% → C 75 + S 75                       →     8,814.00
 *   Receipts/payments settle bills; rent 30,000 (cost centres 18,000 / 12,000), salaries 60,000
 *   (36,000 / 24,000), cash deposited 8,000.
 */
export async function postRoutineMonth(w: World, m: number): Promise<void> {
  const ym = FY_MONTHS[m];
  const n = m + 1;
  const prev = m > 0 ? FY_MONTHS[m - 1] : null;

  await post(
    w,
    `rent-${n}`,
    led(w, 'payment', day(ym, 1), [
      {
        ledgerId: w.L.rent,
        amount: P(30_000),
        costAllocations: [
          { costCentreId: w.CC.mumbai, amount: P(18_000) },
          { costCentreId: w.CC.pune, amount: P(12_000) },
        ],
      },
      { ledgerId: w.L.bank, amount: -P(30_000), instrument: { type: 'cheque', number: String(700100 + n) } },
    ]),
  );

  const pw = `PW/${n}`;
  await post(
    w,
    `pur-pune-${n}`,
    inv(w, 'purchase', day(ym, 3), 'pune', [
      { itemId: w.I.rice, qty: 100, rate: 1400 },
      { itemId: w.I.utensil, qty: 60, rate: 480 },
    ], { referenceNo: pw, referenceDate: day(ym, 3) }),
  );
  newBill(w, 'pune', pw, -P(1_80_984));

  const da = `DA-${n}`;
  await post(
    w,
    `pur-delhi-${n}`,
    inv(w, 'purchase', day(ym, 6), 'delhi', [
      { itemId: w.I.mixer, qty: 30, rate: 2300 },
      { itemId: w.I.cigar, qty: 15, rate: 1900 },
    ], { referenceNo: da, referenceDate: day(ym, 5) }),
  );
  newBill(w, 'delhi', da, -P(1_21_320));

  const sm = await post(
    w,
    `sale-mumbai-${n}`,
    inv(w, 'sales', day(ym, 10), 'mumbai', [
      { itemId: w.I.rice, qty: 90, rate: 1800 },
      { itemId: w.I.utensil, qty: 40, rate: 750 },
    ]),
  );
  assert.equal(sm.totals.grandTotal, P(2_05_500), `sale-mumbai-${n} total`);
  newBill(w, 'mumbai', sm.number!, P(2_05_500));

  const sb = await post(
    w,
    `sale-blr-${n}`,
    inv(w, 'sales', day(ym, 14), 'blr', [
      { itemId: w.I.mixer, qty: 25, rate: 3200 },
      { itemId: w.I.cigar, qty: 12, rate: 3000 },
    ]),
  );
  assert.equal(sb.totals.grandTotal, P(1_44_800), `sale-blr-${n} total`);
  newBill(w, 'blr', sb.number!, P(1_44_800));

  const tonicBatch = m < 10 ? 'B1' : 'B2';
  const cs = await post(
    w,
    `sale-cash-${n}`,
    inv(w, 'sales', day(ym, 18), 'CASH', [
      { itemId: w.I.utensil, qty: 6, rate: 800 },
      { itemId: w.I.tonic, qty: 10, rate: 300, batchName: tonicBatch },
    ]),
  );
  assert.equal(cs.totals.grandTotal, P(8_814), `sale-cash-${n} total`);

  await post(
    w,
    `contra-${n}`,
    led(w, 'contra', day(ym, 19), [
      { ledgerId: w.L.bank, amount: P(8_000), instrument: { type: 'cash' } },
      { ledgerId: w.L.CASH, amount: -P(8_000) },
    ]),
  );

  // Mumbai pays the previous month's bill (April: the opening bill) in full, whatever is still pending.
  const mBill = prev ? w.V[`sale-mumbai-${m}`].number! : 'OB-M1';
  await receiptAgainst(w, `rcpt-mumbai-${n}`, day(ym, 20), 'mumbai', mBill, pendingOf(w, 'mumbai', mBill), `UTRMUM${n}`);

  // We pay Pune's previous bill (April: the opening bill).
  const pBill = prev ? `PW/${m}` : 'OB-P1';
  await paymentAgainst(w, `pay-pune-${n}`, day(ym, 22), 'pune', pBill, -pendingOf(w, 'pune', pBill), `UTRPUN${n}`);

  // Bengaluru pays this month's bill (what is pending after any credit note).
  await receiptAgainst(w, `rcpt-blr-${n}`, day(ym, 25), 'blr', sb.number!, pendingOf(w, 'blr', sb.number!), `UTRBLR${n}`);

  // We pay Delhi this month's bill.
  await paymentAgainst(w, `pay-delhi-${n}`, day(ym, 26), 'delhi', da, -pendingOf(w, 'delhi', da), `UTRDEL${n}`);

  await post(
    w,
    `salary-${n}`,
    led(w, 'payment', day(ym, 28), [
      {
        ledgerId: w.L.salaries,
        amount: P(60_000),
        costAllocations: [
          { costCentreId: w.CC.mumbai, amount: P(36_000) },
          { costCentreId: w.CC.pune, amount: P(24_000) },
        ],
      },
      { ledgerId: w.L.bank, amount: -P(60_000), instrument: { type: 'neft', number: `SAL${n}` } },
    ]),
  );
}

const ON_ACCOUNT = '*on account*';

/**
 * Special transactions, posted around the routine month (`phase` 'before' = before that month's routine
 * vouchers, 'after' = after them). Values (rupees):
 *  May  CN-Mumbai (sales return of April invoice): Rice 10 × 1,800 = 18,000 + C 450 + S 450 = 18,900
 *       GTA freight SR/1 (RCM, 5%): 20,000 → party 20,000; Dr Input C 500 / S 500, Cr RCM C 500 / S 500
 *  Jun  Capital goods (Plant & Machinery) 5,00,000 + C 45,000 + S 45,000 = 5,90,000; paid 2,00,000
 *       GTA SR/1 paid 20,000
 *  Jul  B2CL to Rajesh Gupta (DL, unregistered): Mixers 40 × 3,000 = 1,20,000 + I 21,600 = 1,41,600 (paid)
 *       Debit note to Pune (purchase return of PW/4): Utensils 5 × 480 = 2,400 + C 216 + S 216 = 2,832
 *  Aug  Export under LUT to Dubai: Rice 50 × 2,000 = 1,00,000 (tax 0); GTA SR/2 20,000
 *  Sep  Composition supplier: Rice 20 × 1,450 = 29,000 (no tax), paid in cash; SEZ under LUT: Mixers
 *       10 × 3,100 = 31,000; Dubai pays 1,00,000
 *  Oct  Tonic batch B2 from Pune: 100 × 210 = 21,000 + C 525 + S 525 = 22,050
 *       Import of services CloudSoft: 1,00,000; RCM IGST 18,000 (Dr Input IGST / Cr RCM IGST); paid 1,00,000
 *       CN-Bengaluru (sales return of Oct invoice): Mixers 2 × 3,200 = 6,400 + I 1,152 = 7,552 (new ref)
 *  Nov  Export with payment of IGST: Utensils 20 × 900 = 18,000 + I 3,240 = 21,240; GTA SR/3 20,000;
 *       stock journal: Rice 50 Main → Pune Warehouse
 *  Dec  Staff welfare (food, ITC blocked u/s 17(5)): 10,000 + C 250 + S 250 = 10,500, all to expense
 *       Optional sale (Mumbai, Rice 5 × 1,800), cancelled sale (Bengaluru, Mixer 1 × 3,200),
 *       Bengaluru advance 50,000 (ADV-BE-1), post-dated (due) on-account receipt 15,000 dated 31-Dec
 *  Jan  Delivery note to Mumbai: Utensils 20 (no books); SEZ with payment: Utensils 10 × 760 = 7,600 + I 1,368 = 8,968
 *  Feb  Invoice for the delivery note: Utensils 20 × 760 = 15,200 + C 1,368 + S 1,368 = 17,936 (no stock move)
 *       B2CS credit sale to Walk-in Customers: Rice 4 × 1,900 = 7,600 + C 190 + S 190 = 7,980; GTA SR/4 20,000
 *  Mar  Interest on FD 4,500 received; Mumbai on-account 10,000; depreciation Furniture 30,000, P&M 50,000;
 *       provision for audit fees 25,000; physical stock: Utensils counted 3 short in Main Location;
 *       post-dated cheque to Delhi dated 10-Apr-2027 (NOT yet in the books), 10,000 on account
 */
export async function postSpecials(w: World, m: number, phase: 'before' | 'after'): Promise<void> {
  const ym = FY_MONTHS[m];
  if (phase === 'before') {
    if (m === 1) {
      const orig = w.V['sale-mumbai-1'];
      const cn = await post(
        w,
        'cn-mumbai',
        inv(w, 'credit_note', day(ym, 15), 'mumbai', [{ itemId: w.I.rice, qty: 10, rate: 1800 }], {
          originalInvoiceNo: orig.number!,
          originalInvoiceDate: orig.input.date,
          noteReason: 'Sales return',
          partyBillAllocations: [{ refType: 'against', billName: orig.number!, amount: P(18_900) }],
        }),
      );
      assert.equal(cn.totals.grandTotal, P(18_900));
      w.bills[`mumbai|${orig.number}`] -= P(18_900);
    }
    return;
  }
  const gta = async (k: number, d: string): Promise<void> => {
    const v = await post(w, `gta-${k}`, acc(w, 'purchase', d, 'gta', [{ ledgerKey: 'gtaFreight', amount: P(20_000) }], { referenceNo: `SR/${k}`, referenceDate: d }));
    assert.equal(v.totals.grandTotal, P(20_000), 'GTA under RCM: the transporter is owed the freight only');
    newBill(w, 'gta', `SR/${k}`, -P(20_000));
  };
  switch (m) {
    case 1:
      await gta(1, day(ym, 12));
      break;
    case 2: {
      const cg = await post(
        w,
        'capital-goods',
        acc(w, 'purchase', day(ym, 20), 'machineVendor', [{ ledgerKey: 'machinery', amount: P(5_00_000) }], { referenceNo: 'MML/889', referenceDate: day(ym, 19) }),
      );
      assert.equal(cg.totals.grandTotal, P(5_90_000));
      newBill(w, 'machineVendor', 'MML/889', -P(5_90_000));
      await paymentAgainst(w, 'pay-machine', day(ym, 29), 'machineVendor', 'MML/889', P(2_00_000), 'UTRMML1');
      await paymentAgainst(w, 'pay-gta-1', day(ym, 10), 'gta', 'SR/1', P(20_000), 'UTRGTA1');
      break;
    }
    case 3: {
      const b2cl = await post(w, 'b2cl-delhi', inv(w, 'sales', day(ym, 12), 'delhiCust', [{ itemId: w.I.mixer, qty: 40, rate: 3000 }]));
      assert.equal(b2cl.totals.grandTotal, P(1_41_600));
      newBill(w, 'delhiCust', b2cl.number!, P(1_41_600));
      await receiptAgainst(w, 'rcpt-delhiCust', day(ym, 30), 'delhiCust', b2cl.number!, P(1_41_600), 'UTRRG1');
      const dn = await post(
        w,
        'dn-pune',
        inv(w, 'debit_note', day(ym, 8), 'pune', [{ itemId: w.I.utensil, qty: 5, rate: 480 }], {
          originalInvoiceNo: 'PW/4',
          originalInvoiceDate: day(ym, 3),
          referenceNo: 'DRN-PW4',
          noteReason: 'Purchase return (damaged)',
          partyBillAllocations: [{ refType: 'against', billName: 'PW/4', amount: P(2_832) }],
        }),
      );
      assert.equal(dn.totals.grandTotal, P(2_832));
      w.bills['pune|PW/4'] += P(2_832);
      break;
    }
    case 4: {
      const ex = await post(
        w,
        'export-lut',
        inv(w, 'sales', day(ym, 8), 'dubai', [{ itemId: w.I.rice, qty: 50, rate: 2000 }], {
          exportDetails: { shippingBillNo: '4455667', shippingBillDate: day(ym, 10), portCode: 'INNSA1', currency: 'USD', exchangeRate: 83 },
        }),
      );
      assert.equal(ex.totals.grandTotal, P(1_00_000));
      newBill(w, 'dubai', ex.number!, P(1_00_000));
      await gta(2, day(ym, 12));
      break;
    }
    case 5: {
      await post(
        w,
        'pur-composition',
        inv(w, 'purchase', day(ym, 9), 'composition', [{ itemId: w.I.rice, qty: 20, rate: 1450 }], { referenceNo: 'NK-77', referenceDate: day(ym, 9) }),
      );
      newBill(w, 'composition', 'NK-77', -P(29_000));
      await post(
        w,
        'pay-composition',
        led(w, 'payment', day(ym, 15), [
          { ledgerId: w.L.composition, amount: P(29_000), billAllocations: [{ refType: 'against', billName: 'NK-77', amount: P(29_000) }] },
          { ledgerId: w.L.CASH, amount: -P(29_000) },
        ]),
      );
      w.bills['composition|NK-77'] += P(29_000);
      const sez = await post(w, 'sez-lut', inv(w, 'sales', day(ym, 15), 'sez', [{ itemId: w.I.mixer, qty: 10, rate: 3100 }]));
      assert.equal(sez.totals.grandTotal, P(31_000));
      newBill(w, 'sez', sez.number!, P(31_000));
      await receiptAgainst(w, 'rcpt-dubai', day(ym, 30), 'dubai', w.V['export-lut'].number!, P(1_00_000), 'SWIFT001');
      break;
    }
    case 6: {
      await post(
        w,
        'pur-tonic-b2',
        inv(w, 'purchase', day(ym, 4), 'pune', [{ itemId: w.I.tonic, qty: 100, rate: 210, batchName: 'B2' }], { referenceNo: 'PW/T1', referenceDate: day(ym, 4) }),
      );
      newBill(w, 'pune', 'PW/T1', -P(22_050));
      const imp = await post(
        w,
        'import-services',
        acc(w, 'purchase', day(ym, 5), 'cloudsoft', [{ ledgerKey: 'software', amount: P(1_00_000) }], { referenceNo: 'CS-5521', referenceDate: day(ym, 1) }),
      );
      assert.equal(imp.totals.grandTotal, P(1_00_000), 'import of services: the foreign supplier is owed the value only');
      newBill(w, 'cloudsoft', 'CS-5521', -P(1_00_000));
      await paymentAgainst(w, 'pay-cloudsoft', day(ym, 30), 'cloudsoft', 'CS-5521', P(1_00_000), 'SWIFTOUT1');
      const orig = w.V['sale-blr-7'];
      const cn = await post(
        w,
        'cn-blr',
        inv(w, 'credit_note', day(ym, 28), 'blr', [{ itemId: w.I.mixer, qty: 2, rate: 3200 }], {
          originalInvoiceNo: orig.number!,
          originalInvoiceDate: orig.input.date,
          noteReason: 'Sales return',
        }),
      );
      assert.equal(cn.totals.grandTotal, P(7_552));
      newBill(w, 'blr', cn.number!, -P(7_552));
      break;
    }
    case 7: {
      const ex = await post(
        w,
        'export-wpay',
        inv(w, 'sales', day(ym, 8), 'dubai', [{ itemId: w.I.utensil, qty: 20, rate: 900 }], {
          exportDetails: { withPayment: true, shippingBillNo: '4455999', shippingBillDate: day(ym, 9), portCode: 'INNSA1' },
        }),
      );
      assert.equal(ex.totals.grandTotal, P(21_240));
      newBill(w, 'dubai', ex.number!, P(21_240));
      await gta(3, day(ym, 12));
      await post(w, 'stock-journal', {
        voucherTypeId: w.VT.stock_journal,
        date: day(ym, 1),
        mode: 'inventory',
        narration: 'Transfer of rice to Pune Warehouse',
        items: [
          { itemId: w.I.rice, qty: 50, rate: 1500, godownId: w.GD.main, isConsumption: true },
          { itemId: w.I.rice, qty: 50, rate: 1500, godownId: w.GD.pune },
        ],
      });
      break;
    }
    case 8: {
      const sw = await post(
        w,
        'staff-welfare',
        acc(w, 'purchase', day(ym, 5), 'caterer', [{ ledgerKey: 'staffWelfare', amount: P(10_000) }], { referenceNo: 'HA-301', referenceDate: day(ym, 5) }),
      );
      assert.equal(sw.totals.grandTotal, P(10_500));
      newBill(w, 'caterer', 'HA-301', -P(10_500));
      await post(w, 'optional-sale', inv(w, 'sales', day(ym, 22), 'mumbai', [{ itemId: w.I.rice, qty: 5, rate: 1800 }], { isOptional: true }));
      await post(w, 'cancelled-sale', inv(w, 'sales', day(ym, 23), 'blr', [{ itemId: w.I.mixer, qty: 1, rate: 3200 }]));
      await w.e.call('vouchers.cancel', { id: w.V['cancelled-sale'].id, reason: 'Order cancelled by customer' });
      await post(
        w,
        'advance-blr',
        led(w, 'receipt', day(ym, 28), [
          { ledgerId: w.L.bank, amount: P(50_000), instrument: { type: 'rtgs', number: 'UTRADV1' } },
          { ledgerId: w.L.blr, amount: -P(50_000), billAllocations: [{ refType: 'advance', billName: 'ADV-BE-1', amount: P(50_000) }] },
        ]),
      );
      newBill(w, 'blr', 'ADV-BE-1', -P(50_000));
      await post(
        w,
        'pdc-receipt-due',
        led(
          w,
          'receipt',
          day(ym, 31),
          [
            { ledgerId: w.L.bank, amount: P(15_000), instrument: { type: 'cheque', number: '334455', date: day(ym, 31) } },
            { ledgerId: w.L.blr, amount: -P(15_000), billAllocations: [{ refType: 'on_account', amount: P(15_000) }] },
          ],
          { isPostDated: true },
        ),
      );
      newBill(w, 'blr', ON_ACCOUNT, -P(15_000));
      break;
    }
    case 9: {
      await post(w, 'delivery-note', {
        voucherTypeId: w.VT.delivery_note,
        date: day(ym, 5),
        mode: 'inventory',
        partyLedgerId: w.L.mumbai,
        items: [{ itemId: w.I.utensil, qty: 20, rate: 760 }],
      });
      const sez = await post(
        w,
        'sez-wpay',
        inv(w, 'sales', day(ym, 15), 'sez', [{ itemId: w.I.utensil, qty: 10, rate: 760 }], { exportDetails: { withPayment: true } }),
      );
      assert.equal(sez.totals.grandTotal, P(8_968));
      newBill(w, 'sez', sez.number!, P(8_968));
      break;
    }
    case 10: {
      const dnNo = w.V['delivery-note'].number!;
      const s = await post(w, 'sale-against-dn', inv(w, 'sales', day(ym, 3), 'mumbai', [{ itemId: w.I.utensil, qty: 20, rate: 760, trackingRef: dnNo }]));
      assert.equal(s.totals.grandTotal, P(17_936));
      newBill(w, 'mumbai', s.number!, P(17_936));
      const b2cs = await post(w, 'b2cs-credit', inv(w, 'sales', day(ym, 10), 'walkin', [{ itemId: w.I.rice, qty: 4, rate: 1900 }]));
      assert.equal(b2cs.totals.grandTotal, P(7_980));
      newBill(w, 'walkin', b2cs.number!, P(7_980));
      await gta(4, day(ym, 12));
      break;
    }
    case 11: {
      await post(
        w,
        'interest',
        led(w, 'receipt', day(ym, 15), [
          { ledgerId: w.L.bank, amount: P(4_500), instrument: { type: 'neft', number: 'FDINT1' } },
          { ledgerId: w.L.interestIncome, amount: -P(4_500) },
        ]),
      );
      await post(
        w,
        'mumbai-on-account',
        led(w, 'receipt', day(ym, 28), [
          { ledgerId: w.L.bank, amount: P(10_000), instrument: { type: 'upi', number: 'UPI7788' } },
          { ledgerId: w.L.mumbai, amount: -P(10_000), billAllocations: [{ refType: 'on_account', amount: P(10_000) }] },
        ]),
      );
      newBill(w, 'mumbai', ON_ACCOUNT, -P(10_000));
      await post(
        w,
        'depreciation',
        led(w, 'journal', day(ym, 31), [
          { ledgerId: w.L.depreciation, amount: P(80_000) },
          { ledgerId: w.L.furniture, amount: -P(30_000) },
          { ledgerId: w.L.machinery, amount: -P(50_000) },
        ], { narration: 'Depreciation for FY 2026-27' }),
      );
      await post(
        w,
        'provision',
        led(w, 'journal', day(ym, 31), [
          { ledgerId: w.L.auditFees, amount: P(25_000) },
          { ledgerId: w.L.auditProvision, amount: -P(25_000) },
        ], { narration: 'Provision for statutory audit fees' }),
      );
      const book = await w.e.call<{ qty: number }>('inventory.stockOnHand', { itemId: w.I.utensil, godownId: w.GD.main, asOf: day(ym, 31) });
      await post(w, 'physical-stock', {
        voucherTypeId: w.VT.physical_stock,
        date: day(ym, 31),
        mode: 'inventory',
        items: [{ itemId: w.I.utensil, qty: book.qty - 3, rate: 0, godownId: w.GD.main }],
      });
      await post(
        w,
        'pdc-payment-future',
        led(
          w,
          'payment',
          '2027-04-10',
          [
            { ledgerId: w.L.delhi, amount: P(10_000), billAllocations: [{ refType: 'on_account', amount: P(10_000) }] },
            { ledgerId: w.L.bank, amount: -P(10_000), instrument: { type: 'cheque', number: '700999', date: '2027-04-10' } },
          ],
          { isPostDated: true },
        ),
      );
      break;
    }
  }
}

/** The whole year: specials and routine vouchers month by month. */
export async function postYear(w: World): Promise<void> {
  for (let m = 0; m < 12; m++) {
    await postSpecials(w, m, 'before');
    await postRoutineMonth(w, m);
    await postSpecials(w, m, 'after');
  }
}

/**
 * Alterations and deletions after the year was entered (as an accountant correcting the books):
 *  - Feb Delhi purchase: Mixers 30 → 32 (+2 × 2,300 = 4,600 + I 828 = 5,428 now pending on DA-11).
 *  - Sep rent: 30,000 → 32,000 (cost centres 19,000 / 13,000).
 *  - Nov cash sale deleted (number gap in the sales series; stock and cash reversed).
 *  - Sep cash deposit (contra) deleted.
 */
export async function alterAndDelete(w: World): Promise<void> {
  type Detail = { input: VoucherInput & { expectedUpdatedAt?: string } };
  const pd = await w.e.call<Detail>('vouchers.get', { id: w.V['pur-delhi-11'].id });
  const altered = { ...pd.input, items: pd.input.items!.map((l) => (l.itemId === w.I.mixer ? { ...l, qty: 32 } : l)) };
  const r1 = await post(w, 'alter-pur-delhi-11', altered);
  assert.equal(r1.totals.grandTotal, P(1_21_320 + 5_428));
  w.bills['delhi|DA-11'] -= P(5_428);

  const rd = await w.e.call<Detail>('vouchers.get', { id: w.V['rent-6'].id });
  const rentLines = rd.input.ledgers!.map((l) =>
    l.ledgerId === w.L.rent
      ? { ...l, amount: P(32_000), costAllocations: [{ costCentreId: w.CC.mumbai, amount: P(19_000) }, { costCentreId: w.CC.pune, amount: P(13_000) }] }
      : { ...l, amount: -P(32_000) },
  );
  await post(w, 'alter-rent-6', { ...rd.input, ledgers: rentLines });

  await w.e.call('vouchers.delete', { id: w.V['sale-cash-8'].id, reason: 'Entered twice' });
  await w.e.call('vouchers.delete', { id: w.V['contra-6'].id, reason: 'Deposit never made' });
}

// ───────────────────────────── Banking ─────────────────────────────

export interface BankStep {
  statementOpening: number;
  statementClosing: number;
  lines: number;
  notPresented: number;
  autoMatched: number;
  withoutCandidates: number;
  chargesVoucherId: number;
}

const ddmmyy = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
const rupees = (p: number): string => (p / 100).toFixed(2);

/**
 * HDFC statement for Apr–Jun 2026, written from the scenario's own bank lines (HDFC NetBanking CSV layout):
 * every bank entry of the quarter (rent cheques clear 2 days late), EXCEPT the 29-Jun payment of
 * 2,00,000 to Mumbai Machines (not yet presented), PLUS bank charges of 590 on 30-Jun that the books do
 * not have yet. Then import → auto-match → create the charges voucher from the line.
 */
export async function bankQuarter(w: World): Promise<BankStep> {
  const from = '2026-04-01';
  const to = '2026-06-30';
  type Row = { date: string; narration: string; ref: string; amount: number };
  const rows: Row[] = [];
  let notPresented = 0;
  for (const [name, v] of Object.entries(w.V)) {
    const inp = v.input;
    if (inp.mode !== 'ledger' || inp.date < from || inp.date > to || inp.isOptional || inp.isPostDated) continue;
    const bankLine = inp.ledgers!.find((l) => l.ledgerId === w.L.bank);
    if (!bankLine) continue;
    if (name === 'pay-machine') {
      notPresented += -bankLine.amount;
      continue;
    }
    const isCheque = bankLine.instrument?.type === 'cheque';
    const d = isCheque ? `${inp.date.slice(0, 8)}${String(Number(inp.date.slice(8)) + 2).padStart(2, '0')}` : inp.date;
    const other = inp.ledgers!.find((l) => l.ledgerId !== w.L.bank)!;
    const ledgerName = Object.entries(w.L).find(([, id]) => id === other.ledgerId)![0].toUpperCase();
    const kind = isCheque ? 'CHQ' : (bankLine.instrument?.type ?? 'TRF').toUpperCase();
    rows.push({ date: d, narration: `${kind}-${bankLine.instrument?.number ?? ''}-${ledgerName}`, ref: bankLine.instrument?.number ?? '', amount: bankLine.amount });
  }
  rows.push({ date: to, narration: 'CHRG-SMS AND ACCOUNT CHARGES INCL GST', ref: '', amount: -P(590) });
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const opening = P(8_00_000);
  let bal = opening;
  const csv = ['Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance'];
  for (const r of rows) {
    bal += r.amount;
    csv.push(
      [ddmmyy(r.date), r.narration, r.ref, ddmmyy(r.date), r.amount < 0 ? rupees(-r.amount) : '', r.amount > 0 ? rupees(r.amount) : '', rupees(bal)].join(','),
    );
  }
  const bytes = new TextEncoder().encode(csv.join('\r\n') + '\r\n');
  const preview = await w.e.call<{ mapping: unknown; lines: unknown[]; preset: { id: string } }>('banking.statement.preview', {
    ledgerId: w.L.bank,
    fileName: 'HDFC_Statement_Q1.csv',
    bytes,
  });
  assert.equal(preview.preset.id, 'hdfc', 'HDFC layout recognised');
  assert.equal(preview.lines.length, rows.length, 'every statement row parsed');
  const imp = await w.e.call<{ batchId: number; imported: number; closingBalance: number }>('banking.statement.import', {
    ledgerId: w.L.bank,
    fileName: 'HDFC_Statement_Q1.csv',
    bytes,
    mapping: preview.mapping,
  });
  assert.equal(imp.imported, rows.length);
  assert.equal(imp.closingBalance, bal);
  const am = await w.e.call<{ applied: unknown[]; suggestions: unknown[]; withoutCandidates: number }>('banking.autoMatch', {
    ledgerId: w.L.bank,
    batchId: imp.batchId,
  });
  const unmatched = await w.e.call<{ rows: Array<{ id: number; amount: number; description: string }> }>('banking.statement.lines', {
    ledgerId: w.L.bank,
    from,
    to,
    status: 'unmatched',
  });
  const charges = unmatched.rows.find((r) => /CHRG/.test(r.description));
  assert.ok(charges, 'bank charges line stays unmatched');
  const created = await w.e.call<{ voucherId: number }>('banking.createVoucher', {
    lineId: charges.id,
    kind: 'payment',
    contraLedgerId: w.L.bankCharges,
  });
  w.created++;
  return {
    statementOpening: opening,
    statementClosing: bal,
    lines: rows.length,
    notPresented,
    autoMatched: am.applied.length,
    withoutCandidates: am.withoutCandidates,
    chargesVoucherId: created.voucherId,
  };
}

// ───────────────────────────── GSTR-2B ─────────────────────────────

/** GSTIN of a party ledger (from the master). */
async function gstinOf(w: World, key: string): Promise<string> {
  return (await w.e.call<{ gstin: string }>('accounts.ledger.get', { id: w.L[key] })).gstin;
}

/**
 * GSTR-2B for July 2026 as the portal would generate it (amounts in rupees):
 *   Pune  PW/4    03-07-2026  rt 5: 1,40,000 (C 3,500 S 3,500) · rt 18: 28,800 (C 2,592 S 2,592)  val 1,80,984
 *   Pune  CN DRN-PW4 08-07-2026 rt 18: 2,400 (C 216 S 216)                                       val 2,832
 *   Pune  PW/X9   20-07-2026  rt 18: 10,000 (C 900 S 900) — never booked                         val 11,800
 *   Delhi DA-4    05-07-2026  rt 18: 69,000 (I 12,420) · rt 40: 28,500 (I 11,400)                val 1,21,320
 */
export async function gstr2bJuly(w: World): Promise<Uint8Array> {
  const company = await w.e.call<{ gstin: string }>('company.profile.get');
  const pune = await gstinOf(w, 'pune');
  const delhi = await gstinOf(w, 'delhi');
  const item = (num: number, rt: number, txval: number, igst: number, cgst: number, sgst: number) => ({ num, rt, txval, igst, cgst, sgst, cess: 0 });
  const invc = (inum: string, dt: string, val: number, pos: string, items: unknown[]) => ({
    inum, typ: 'R', dt, val, pos, rev: 'N', itcavl: 'Y', rsn: '', diffprcnt: 1, srctyp: 'Upload', items,
  });
  const json = {
    chksum: 'x',
    data: {
      gstin: company.gstin,
      rtnprd: '072026',
      version: '1.0',
      gendt: '14-08-2026',
      itcsumm: {},
      docdata: {
        b2b: [
          {
            ctin: pune, trdnm: 'Pune Wholesale Suppliers', supprd: '072026', supfildt: '11-08-2026',
            inv: [
              invc('PW/4', '03-07-2026', 180984, '27', [item(1, 5, 140000, 0, 3500, 3500), item(2, 18, 28800, 0, 2592, 2592)]),
              invc('PW/X9', '20-07-2026', 11800, '27', [item(1, 18, 10000, 0, 900, 900)]),
            ],
          },
          {
            ctin: delhi, trdnm: 'Delhi Appliances Co', supprd: '072026', supfildt: '10-08-2026',
            inv: [invc('DA-4', '05-07-2026', 121320, '27', [item(1, 18, 69000, 12420, 0, 0), item(2, 40, 28500, 11400, 0, 0)])],
          },
        ],
        cdnr: [
          {
            ctin: pune, trdnm: 'Pune Wholesale Suppliers', supprd: '072026', supfildt: '11-08-2026',
            nt: [{ ntnum: 'DRN-PW4', typ: 'C', suptyp: 'R', dt: '08-07-2026', val: 2832, pos: '27', rev: 'N', itcavl: 'Y', rsn: '', diffprcnt: 1, srctyp: '', items: [item(1, 18, 2400, 0, 216, 216)] }],
          },
        ],
      },
    },
  };
  return new TextEncoder().encode(JSON.stringify(json));
}

export { FY_MONTHS, ON_ACCOUNT };
