/**
 * EVERY FEATURE ON — a second business year (FY 2026-27) for the cross-feature tie-out
 * (all-features-year.test.ts), entered ONLY through runtime.dispatch like scenario.ts.
 *
 * Company: Godavari Steel Furniture (regular GST, Maharashtra 27), books from 1-Apr-2026, Owner login.
 * F11: inventory (integrated), bill-wise, multiple godowns, manufacturing, job work, POS, multiple
 * currencies, cheque printing, TDS, TCS. A composition dealer (Shirdi Sweets) runs beside it
 * (`createCompositionCompany` / `postCompositionYear`).
 *
 * Openings (1-Apr-2026): HDFC Bank Dr 20,00,000 · Cash Dr 1,00,000 · stock Steel Sheet 1,000 kg × 50 = 50,000
 *   + Paint 100 L × 200 = 20,000 + Seat Cushion 200 × 150 = 30,000 = 1,00,000 → Capital Cr 22,00,000.
 *
 * The year (rupees; every voucher's arithmetic next to it below):
 *  Apr  steel 2,000 kg × 50 + paint 100 L × 210 from Nagpur (1,21,000 + C/S 10,890 each = 1,42,780, PDF attached);
 *       a late Nagpur bill (paint 100 L × 250) entered after the first journal, back-dated before it;
 *       BOM 10 chairs = 50 kg steel + 4 L paint, 5 kg scrap at ₹20; Manufacturing Journal 200 chairs (labour 20,000);
 *       rent journal 60,000 (194I(b) 10% → TDS 6,000, landlord 54,000) made recurring monthly (May–Mar posted
 *       from the due list); quotation 50 chairs × 1,200 → converted into the invoice (70,800); POS day.
 *  May  contract labour Shinde 1,00,000 + 18% (194C 2% = 2,000); professional fees Joshi 60,000 + 18%
 *       (194J(b) 10% = 6,000); advance from Surat 1,18,000 for installation services (IGST 18% on 1,00,000).
 *  Jun  installation invoice to Surat 1,50,000 + IGST 27,000 adjusting the advance; export under LUT to Atlantic
 *       Home Inc 100 chairs × $40 = $4,000 @ ₹83 = 3,32,000; job work order + Material Out 200 kg steel to Ravi.
 *  Jul  Material In 30 chairs (150 kg consumed at Ravi's, job charges 6,000); Ravi's bill 6,000 + IGST 1,080;
 *       Atlantic pays $2,500 @ ₹84.50 (gain 3,750); Kolhapur 60 chairs × 1,200; Surat pays the balance.
 *  Aug  scrap 80 kg × 100 to Bharat (TCS 1% on 9,440 = 94); GTA freight 10,000 under RCM (5%); POS day.
 *  Sep  Manufacturing Journal 100 chairs; Joshi 40,000 + 18% (194J(b) 4,000).
 *  Oct  optional sale (scenario only); open quotation.
 *  Nov  Shinde 50,000 + 18% (194C 1,000) and a debit note of 10,000 against it (TDS 200 reversed).
 *  Dec  POS day; a POS customer (created by mobile) buys partly on credit.
 *  Mar  (also) Bharat returns 10 kg scrap: credit note reversing TCS 12.
 *  Mar  scrap 50 kg × 100 to Bharat (TCS 59); POS day; revaluation of Atlantic's $1,500 at ₹85 (gain 3,000).
 *  Every month: rent cheque 54,000 on the 5th; TDS / TCS challans by the 7th of the next month (March's
 *  deductions stay payable); GST set-off + PMT-06 challan for April–February on the 20th of the next month
 *  (March stays payable). Bank statement Apr–Jun imported, auto-matched → BRS.
 */
import assert from 'node:assert/strict';
import type { InstrumentInput, VoucherInput } from '../../../shared/types/vouchers.ts';
import { makeGstin } from '../fixtures.ts';
import { FY_MONTHS, P, periodKey, type E2E } from './harness.ts';
import { post, type World } from './scenario.ts';

export const AF_BOOKS_FROM = '2026-04-01';
export const AF_FY_END = '2027-03-31';
export const AF_OWNER = { username: 'owner', displayName: 'Meera Kulkarni', password: 'Godavari#2026' };

/** PANs (4th letter: C company, F firm, P individual). */
const PAN = {
  company: 'AAACG1001A',
  nagpur: 'AAACN1234E',
  kolhapur: 'AAAFK3344D',
  surat: 'AAACS6655H',
  bharat: 'AAACB9988M',
  shinde: 'AAKFS5512C',
  joshi: 'AABFJ7711Q',
  patil: 'ACRPP4321K',
  ravi: 'AAAFR2211B',
  gta: 'AAAFG4455T',
};

export interface AfWorld extends World {
  /** TDS / TCS nature ids by short name. */
  NAT: Record<string, number>;
  /** POS context bits. */
  pos: { saleTypeId: number; returnTypeId: number; walkInId: number; cash: number; upi: number; exchange: number };
  /** Classed stock journal types. */
  MJ: { manufacturing: number; materialOut: number; materialIn: number };
  usd: number;
  bomId: number;
  attachmentId: number;
  /** POS bills / returns posted: count and value. */
  posBills: { sales: number; salesValue: number; returns: number; returnValue: number };
  /** Challans posted: TDS / TCS and GST. */
  challans: { tds: number; gst: number };
  /** The cheque left unpresented on the bank statement (voucher name). */
  notPresented: string;
  /** Scenario / budget ids. */
  scenarioId: number;
  budgetId: number;
  quotationOpenId: number;
}

const day = (ym: string, d: number): string => `${ym}-${String(d).padStart(2, '0')}`;
const nextMonth = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

async function ledger(w: AfWorld, key: string, input: Record<string, unknown>): Promise<number> {
  const d = await w.e.call<{ id: number }>('accounts.ledger.save', input);
  w.L[key] = d.id;
  return d.id;
}

export async function createAllFeaturesCompany(e: E2E): Promise<AfWorld> {
  const state = await e.call<{ companies: Array<{ id: string; name: string }>; session: { username: string } | null }>('app.company.create', {
    name: 'Godavari Steel Furniture',
    address: 'Plot 7, MIDC Ambad, Nashik',
    stateCode: '27',
    pincode: '422010',
    gstRegistrationType: 'regular',
    gstin: makeGstin('27', PAN.company),
    pan: PAN.company,
    booksFrom: AF_BOOKS_FROM,
    owner: AF_OWNER,
  });
  assert.equal(state.session?.username, AF_OWNER.username);
  const companyId = state.companies.find((c) => c.name === 'Godavari Steel Furniture')!.id;
  const w: AfWorld = {
    e,
    companyId,
    G: {},
    L: {},
    I: {},
    GD: {},
    CC: {},
    VT: {},
    V: {},
    created: 0,
    acknowledged: {},
    bills: {},
    NAT: {},
    pos: { saleTypeId: 0, returnTypeId: 0, walkInId: 0, cash: 0, upi: 0, exchange: 0 },
    MJ: { manufacturing: 0, materialOut: 0, materialIn: 0 },
    usd: 0,
    bomId: 0,
    attachmentId: 0,
    posBills: { sales: 0, salesValue: 0, returns: 0, returnValue: 0 },
    challans: { tds: 0, gst: 0 },
    notPresented: '',
    scenarioId: 0,
    budgetId: 0,
    quotationOpenId: 0,
  };
  // F11: every feature this company uses.
  await e.call('company.features.save', {
    inventory: true,
    integrateInventory: true,
    billWise: true,
    multipleGodowns: true,
    manufacturing: true,
    jobWork: true,
    pos: true,
    multiCurrency: true,
    chequePrinting: true,
    tds: true,
    tcs: true,
  });
  await e.call('company.config.save', { gst: { lutNumber: 'AD270326009876X', lutValidFrom: '2026-04-01', lutValidTo: '2027-03-31' } });
  await e.call('tds.settings.save', {
    tan: 'NSKG12345A',
    deductorCategory: 'company',
    responsiblePerson: 'Meera Kulkarni',
    responsibleDesignation: 'Director',
    buyer194Q: false,
    roundToRupee: true,
  });

  const groups = await e.call<{ rows: Array<{ id: number; reservedCode: string | null }> }>('accounts.group.list', {});
  for (const g of groups.rows) if (g.reservedCode) w.G[g.reservedCode] = g.id;
  const ledgers = await e.call<{ rows: Array<{ id: number; reservedCode: string | null }> }>('accounts.ledger.list', { limit: 10_000 });
  for (const l of ledgers.rows) if (l.reservedCode) w.L[l.reservedCode] = l.id;
  const types = await e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean; name: string }> }>('accounts.voucherType.list', {});
  for (const t of types.rows) if (t.isPredefined) w.VT[t.baseType] = t.id;
  const byName = (n: string): number => types.rows.find((t) => t.name === n)!.id;
  w.MJ = { manufacturing: byName('Manufacturing Journal'), materialOut: byName('Material Out'), materialIn: byName('Material In') };
  return w;
}

export async function createAllFeaturesMasters(w: AfWorld): Promise<void> {
  const { e, G } = w;
  const godowns = await e.call<{ rows: Array<{ id: number }> }>('inventory.godown.list', {});
  w.GD.main = godowns.rows[0].id;

  await e.call('accounts.ledger.save', { id: w.L.CASH, openingBalance: P(1_00_000) });
  await ledger(w, 'capital', { name: "Promoters' Capital", groupId: G.CAPITAL_ACCOUNT, openingBalance: -P(22_00_000) });
  await ledger(w, 'bank', {
    name: 'HDFC Bank Current A/c',
    groupId: G.BANK_ACCOUNTS,
    openingBalance: P(20_00_000),
    bankAccountNo: '50200099887766',
    bankIfsc: 'HDFC0000456',
    bankName: 'HDFC Bank',
  });

  // ── Parties ──
  await ledger(w, 'nagpur', { name: 'Nagpur Steel Co', groupId: G.SUNDRY_CREDITORS, gstin: makeGstin('27', PAN.nagpur), pan: PAN.nagpur, registrationType: 'regular', defaultCreditDays: 30 });
  await ledger(w, 'shinde', { name: 'Shinde Contractors', groupId: G.SUNDRY_CREDITORS, gstin: makeGstin('27', PAN.shinde), pan: PAN.shinde, registrationType: 'regular' });
  await ledger(w, 'joshi', { name: 'Joshi & Associates', groupId: G.SUNDRY_CREDITORS, gstin: makeGstin('27', PAN.joshi), pan: PAN.joshi, registrationType: 'regular' });
  await ledger(w, 'patil', { name: 'Patil Estates', groupId: G.SUNDRY_CREDITORS, pan: PAN.patil, stateCode: '27', registrationType: 'unregistered', billWise: false });
  await ledger(w, 'ravi', { name: 'Ravi Fabricators', groupId: G.SUNDRY_CREDITORS, gstin: makeGstin('29', PAN.ravi), pan: PAN.ravi, registrationType: 'regular' });
  await ledger(w, 'gta', { name: 'Speedy Roadways (GTA)', groupId: G.SUNDRY_CREDITORS, gstin: makeGstin('27', PAN.gta), pan: PAN.gta, registrationType: 'regular' });
  await ledger(w, 'kolhapur', { name: 'Kolhapur Furniture Mart', groupId: G.SUNDRY_DEBTORS, gstin: makeGstin('27', PAN.kolhapur), registrationType: 'regular', defaultCreditDays: 30 });
  await ledger(w, 'surat', { name: 'Surat Interiors', groupId: G.SUNDRY_DEBTORS, gstin: makeGstin('24', PAN.surat), registrationType: 'regular' });
  await ledger(w, 'bharat', { name: 'Bharat Scrap Traders', groupId: G.SUNDRY_DEBTORS, gstin: makeGstin('27', PAN.bharat), pan: PAN.bharat, registrationType: 'regular' });

  // ── Multi-currency: US Dollar, rates, the overseas customer in USD ──
  w.usd = (await e.call<{ id: number }>('accounts.currency.save', { symbol: '$', formalName: 'US Dollar', isoCode: 'USD', decimalPlaces: 2 })).id;
  await e.call('accounts.exchangeRate.save', { currencyId: w.usd, date: '2026-04-01', standard: 83, selling: 83.4, buying: 82.6 });
  await e.call('accounts.exchangeRate.save', { currencyId: w.usd, date: '2027-03-31', standard: 85, selling: 85.4, buying: 84.6 });
  await ledger(w, 'atlantic', {
    name: 'Atlantic Home Inc',
    groupId: G.SUNDRY_DEBTORS,
    registrationType: 'overseas',
    country: 'United States of America',
    billWise: true,
    currencyId: w.usd,
  });

  // ── Income / expense ──
  await ledger(w, 'scrapSales', { name: 'Scrap Sales', groupId: G.SALES_ACCOUNTS, gstApplicable: true, gstRate: 18, hsnSac: '7204', gstSupplyType: 'goods' });
  await ledger(w, 'installation', { name: 'Installation Services', groupId: G.SALES_ACCOUNTS, gstApplicable: true, gstRate: 18, hsnSac: '995466', gstSupplyType: 'services' });
  await ledger(w, 'contract', { name: 'Contract Labour', groupId: G.DIRECT_EXPENSES, gstApplicable: true, gstRate: 18, hsnSac: '995411', gstSupplyType: 'services', itcEligibility: 'input_services' });
  await ledger(w, 'profFees', { name: 'Professional Fees', groupId: G.INDIRECT_EXPENSES, gstApplicable: true, gstRate: 18, hsnSac: '998221', gstSupplyType: 'services', itcEligibility: 'input_services' });
  await ledger(w, 'jobCharges', { name: 'Job Work Charges', groupId: G.DIRECT_EXPENSES, gstApplicable: true, gstRate: 18, hsnSac: '998898', gstSupplyType: 'services', itcEligibility: 'input_services' });
  await ledger(w, 'freight', { name: 'Freight Inward (GTA)', groupId: G.DIRECT_EXPENSES, gstApplicable: true, gstRate: 5, hsnSac: '996511', gstSupplyType: 'services', isReverseCharge: true, itcEligibility: 'input_services' });
  await ledger(w, 'rent', { name: 'Factory Rent', groupId: G.INDIRECT_EXPENSES });
  await ledger(w, 'labour', { name: 'Labour Charges', groupId: G.DIRECT_EXPENSES });

  // ── TDS / TCS masters ──
  const tdsN = await e.call<Array<{ id: number; section: string; name: string }>>('tds.natures.list', { kind: 'tds' });
  const tcsN = await e.call<Array<{ id: number; section: string; name: string }>>('tds.natures.list', { kind: 'tcs' });
  w.NAT.c194C = tdsN.find((n) => n.section === '194C')!.id;
  w.NAT.j194Jb = tdsN.find((n) => n.section === '194J(b)')!.id;
  w.NAT.i194Ib = tdsN.find((n) => n.section === '194I(b)')!.id;
  w.NAT.scrap = tcsN.find((n) => n.section === '206C(1)' && /scrap/i.test(n.name))!.id;
  await e.call('tds.ledgers.save', { ledgerId: w.L.shinde, applicable: true, deducteeType: 'firm', pan: PAN.shinde });
  await e.call('tds.ledgers.save', { ledgerId: w.L.joshi, applicable: true, deducteeType: 'firm', pan: PAN.joshi });
  await e.call('tds.ledgers.save', { ledgerId: w.L.patil, applicable: true, deducteeType: 'individual', pan: PAN.patil });
  await e.call('tds.ledgers.save', { ledgerId: w.L.bharat, applicable: true, deducteeType: 'company', pan: PAN.bharat });
  // Ravi (job work) and the GTA give s.194C(6) declarations / are below threshold: not deducted.
  await e.call('tds.ledgers.save', { ledgerId: w.L.contract, applicable: true, natureId: w.NAT.c194C });
  await e.call('tds.ledgers.save', { ledgerId: w.L.profFees, applicable: true, natureId: w.NAT.j194Jb });
  await e.call('tds.ledgers.save', { ledgerId: w.L.rent, applicable: true, natureId: w.NAT.i194Ib });
  await e.call('tds.ledgers.save', { ledgerId: w.L.scrapSales, applicable: true, natureId: w.NAT.scrap });

  // ── Stock items ──
  const units = await e.call<{ rows: Array<{ id: number; symbol: string }> }>('inventory.unit.list', {});
  const unit = (s: string): number => {
    const u = units.rows.find((x) => x.symbol === s);
    assert.ok(u, `unit ${s}`);
    return u.id;
  };
  const item = async (key: string, input: Record<string, unknown>): Promise<void> => {
    w.I[key] = (await e.call<{ item: { id: number } }>('inventory.item.save', input)).item.id;
  };
  await item('steel', { name: 'Steel Sheet', unitId: unit('Kg'), gstApplicable: true, taxability: 'taxable', gstRate: 18, hsnSac: '7208', openings: [{ godownId: w.GD.main, qty: 1000, rate: 50 }] });
  await item('paint', { name: 'Enamel Paint', unitId: unit('Ltr'), gstApplicable: true, taxability: 'taxable', gstRate: 18, hsnSac: '3208', openings: [{ godownId: w.GD.main, qty: 100, rate: 200 }] });
  await item('chair', { name: 'Steel Chair', unitId: unit('Nos'), gstApplicable: true, taxability: 'taxable', gstRate: 18, hsnSac: '9401', barcode: '8901234500017', mrp: 2_500_00, sellingPrice: 1_500_00 });
  await item('scrap', { name: 'Scrap Metal', unitId: unit('Kg'), gstApplicable: true, taxability: 'taxable', gstRate: 18, hsnSac: '7204' });
  await item('cushion', { name: 'Seat Cushion', unitId: unit('Nos'), gstApplicable: true, taxability: 'taxable', gstRate: 18, hsnSac: '9404', barcode: '8901234500024', mrp: 399_00, sellingPrice: 300_00, openings: [{ godownId: w.GD.main, qty: 200, rate: 150 }] });

  // ── Job work: Ravi's premises hold OUR goods ──
  w.GD.ravi = (await e.call<{ id: number }>('inventory.godown.save', { name: 'Ravi Fabricators (JW)', thirdPartyKind: 'ours_with_party', partyLedgerId: w.L.ravi })).id;
  // ── BOM: 10 chairs = 50 kg steel + 4 L paint; 5 kg scrap valued at ₹20/kg ──
  w.bomId = (
    await e.call<{ id: number }>('mfg.bom.save', {
      itemId: w.I.chair,
      name: 'Standard',
      outputQty: 10,
      lines: [
        { kind: 'component', itemId: w.I.steel, qty: 50 },
        { kind: 'component', itemId: w.I.paint, qty: 4 },
        { kind: 'scrap', itemId: w.I.scrap, qty: 5, valueBasis: 'rate', valueRate: 20 },
      ],
    })
  ).id;

  // ── POS: UPI on the bank ──
  w.pos.upi = (await e.call<{ id: number }>('pos.tenderMode.save', { name: 'UPI', kind: 'upi', ledgerId: w.L.bank })).id;
  const ctx = await e.call<{ saleVoucherTypeId: number; returnVoucherTypeId: number; walkIn: { id: number } | null; tenderModes: Array<{ id: number; kind: string }> }>('pos.context', {});
  w.pos.saleTypeId = ctx.saleVoucherTypeId;
  w.pos.returnTypeId = ctx.returnVoucherTypeId;
  w.pos.walkInId = ctx.walkIn!.id;
  w.pos.cash = ctx.tenderModes.find((m) => m.kind === 'cash')!.id;
  w.pos.exchange = ctx.tenderModes.find((m) => m.kind === 'exchange')!.id;

  // ── Cheques: a book of leaves for the bank ──
  await e.call('cheques.book.save', { bankLedgerId: w.L.bank, fromNo: 100001, toNo: 100100, digits: 6 });
}

// ───────────────────────────── helpers ─────────────────────────────

function inv(w: AfWorld, base: string, date: string, partyKey: string, items: VoucherInput['items'], over: Partial<VoucherInput> = {}): VoucherInput {
  return { voucherTypeId: w.VT[base], date, mode: 'item_invoice', partyLedgerId: w.L[partyKey], items, ...over };
}
function acc(w: AfWorld, base: string, date: string, partyKey: string, lines: Array<{ ledgerKey: string; amount: number }>, over: Partial<VoucherInput> = {}): VoucherInput {
  return { voucherTypeId: w.VT[base], date, mode: 'accounting_invoice', partyLedgerId: w.L[partyKey], ledgers: lines.map((l) => ({ ledgerId: w.L[l.ledgerKey], amount: l.amount })), ...over };
}
function led(w: AfWorld, base: string, date: string, ledgers: VoucherInput['ledgers'], over: Partial<VoucherInput> = {}): VoucherInput {
  return { voucherTypeId: w.VT[base], date, mode: 'ledger', ledgers, ...over };
}
function newBill(w: AfWorld, partyKey: string, billName: string, signed: number): void {
  const k = `${partyKey}|${billName}`;
  w.bills[k] = (w.bills[k] ?? 0) + signed;
}

/** Pay a supplier's bill from the bank (cheque leaf filled on save, or NEFT). */
async function payBill(w: AfWorld, name: string, date: string, partyKey: string, billName: string, amount: number, instrument: InstrumentInput): Promise<void> {
  await post(
    w,
    name,
    led(w, 'payment', date, [
      { ledgerId: w.L[partyKey], amount, billAllocations: [{ refType: 'against', billName, amount }] },
      { ledgerId: w.L.bank, amount: -amount, instrument },
    ]),
  );
  newBill(w, partyKey, billName, amount);
}
async function receiveBill(w: AfWorld, name: string, date: string, partyKey: string, billName: string, amount: number, ref: string): Promise<void> {
  await post(
    w,
    name,
    led(w, 'receipt', date, [
      { ledgerId: w.L.bank, amount, instrument: { type: 'neft', number: ref } },
      { ledgerId: w.L[partyKey], amount: -amount, billAllocations: [{ refType: 'against', billName, amount }] },
    ]),
  );
  newBill(w, partyKey, billName, -amount);
}

/**
 * One POS day (rates ex-GST, 18%): bill A 2 chairs × 1,500 + 4 cushions × 300 = 4,200 + C/S 378 each = 4,956
 * (UPI 3,000 + cash 1,956, 2,000 tendered → change 44); bill B 1 cushion = 300 + 27 + 27 = 354 cash;
 * return of 1 cushion from A as exchange credit 354, used on bill C (1 cushion, 354).
 */
async function posDay(w: AfWorld, tag: string, date: string): Promise<void> {
  const sale = (items: VoucherInput['items'], posBill: unknown): VoucherInput =>
    ({ voucherTypeId: w.pos.saleTypeId, date, mode: 'item_invoice', partyLedgerId: w.pos.walkInId, placeOfSupply: '27', items, posBill }) as VoucherInput;
  const a = await post(
    w,
    `pos-${tag}-A`,
    sale(
      [
        { itemId: w.I.chair, qty: 2, rate: 1500 },
        { itemId: w.I.cushion, qty: 4, rate: 300 },
      ],
      { tenders: [{ modeId: w.pos.upi, amount: P(3_000), reference: `UPI${tag}` }, { modeId: w.pos.cash, amount: P(1_956) }], cashTendered: P(2_000), counter: 'Counter 1' },
    ),
  );
  assert.equal(a.totals.grandTotal, P(4_956), `pos-${tag}-A total`);
  const b = await post(w, `pos-${tag}-B`, sale([{ itemId: w.I.cushion, qty: 1, rate: 300 }], { tenders: [{ modeId: w.pos.cash, amount: P(354) }] }));
  assert.equal(b.totals.grandTotal, P(354));
  const rc = await w.e.call<{ lines: Array<{ itemId: number; rate: number }>; billNumber: string }>('pos.return.context', { voucherId: a.id, date });
  const ret = await post(w, `pos-${tag}-R`, {
    voucherTypeId: w.pos.returnTypeId,
    date,
    mode: 'item_invoice',
    partyLedgerId: w.pos.walkInId,
    placeOfSupply: '27',
    originalInvoiceNo: rc.billNumber,
    originalInvoiceDate: date,
    noteReason: 'Exchange',
    items: [{ itemId: w.I.cushion, qty: 1, rate: rc.lines.find((l) => l.itemId === w.I.cushion)!.rate }],
    posBill: { tenders: [{ modeId: w.pos.exchange, amount: P(354) }], returnOfId: a.id },
  } as VoucherInput);
  assert.equal(ret.totals.grandTotal, P(354));
  const c = await post(w, `pos-${tag}-C`, sale([{ itemId: w.I.cushion, qty: 1, rate: 300 }], { tenders: [{ modeId: w.pos.exchange, amount: P(354), exchangeVoucherId: ret.id }] }));
  assert.equal(c.totals.grandTotal, P(354));
  w.posBills.sales += 3;
  w.posBills.salesValue += P(4_956 + 354 + 354);
  w.posBills.returns += 1;
  w.posBills.returnValue += P(354);
}

/** TDS / TCS challans for a month's deductions (deposited on the 7th of the next month). */
async function tdsChallans(w: AfWorld, ym: string): Promise<void> {
  const depositDate = day(nextMonth(ym), 7);
  const sets: Array<{ kind: 'tds' | 'tcs'; section: string }> = [
    { kind: 'tds', section: '194I(b)' },
    { kind: 'tds', section: '194C' },
    { kind: 'tds', section: '194J(b)' },
    { kind: 'tcs', section: '206C(1)' },
  ];
  for (const s of sets) {
    const sug = await w.e.call<{ unpaid: number; interest: number }>('tds.challan.suggest', { kind: s.kind, section: s.section, period: ym, depositDate });
    if (sug.unpaid <= 0) continue;
    w.challans.tds++;
    await w.e.call('tds.challan.save', {
      date: depositDate,
      bankLedgerId: w.L.bank,
      challan: { kind: s.kind, section: s.section, period: ym, bsrCode: '0510308', challanNo: String(20000 + w.challans.tds), depositDate, tax: sug.unpaid, interest: sug.interest },
    });
    w.created++;
  }
}

/** GST set-off of a month with its PMT-06 challan (challan on the 18th, set-off journal on the 20th of the next month). */
async function gstSetoff(w: AfWorld, ym: string): Promise<void> {
  const period = periodKey(ym);
  const nm = nextMonth(ym);
  type Heads = { igst: number; cgst: number; sgst: number; cess: number };
  const s = await w.e.call<{ cash: Array<{ head: string; toDeposit: number }>; liability: Heads; rcm: Heads }>('gst.setoff.compute', { period });
  const due = (h: Heads): number => h.igst + h.cgst + h.sgst + h.cess;
  // A month with no tax payable (purchases only) has nothing to set off: its credit is carried forward.
  if (due(s.liability) + due(s.rcm) === 0) return;
  const heads = s.cash.filter((c) => c.toDeposit > 0).map((c) => ({ head: c.head, minor: 'tax', amount: c.toDeposit }));
  if (heads.length) {
    w.challans.gst++;
    await w.e.call('gst.challan.post', {
      date: day(nm, 18),
      bankLedgerId: w.L.bank,
      cpin: `2${String(w.challans.gst).padStart(2, '0')}${period}0000000`.slice(0, 14),
      cin: `HDFC${period}${String(w.challans.gst).padStart(7, '0')}`,
      challanDate: day(nm, 18),
      period,
      heads,
    });
    w.created++;
  }
  await w.e.call('gst.setoff.post', { period, date: day(nm, 20) });
  w.created++;
}

// ───────────────────────────── The year ─────────────────────────────

export async function postAllFeaturesYear(w: AfWorld): Promise<void> {
  const { e } = w;
  // ── April ──
  // Nagpur: steel 2,000 × 50 = 1,00,000 + paint 100 × 210 = 21,000 → 1,21,000; C = S = 9% = 10,890 → 1,42,780.
  const pn = await post(
    w,
    'pur-nagpur',
    inv(w, 'purchase', '2026-04-02', 'nagpur', [
      { itemId: w.I.steel, qty: 2000, rate: 50 },
      { itemId: w.I.paint, qty: 100, rate: 210 },
    ], { referenceNo: 'NS/1', referenceDate: '2026-04-02' }),
  );
  assert.equal(pn.totals.grandTotal, P(1_42_780));
  newBill(w, 'nagpur', 'NS/1', -P(1_42_780));
  const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
  w.attachmentId = (await e.call<{ id: number }>('attachments.add', { entityType: 'voucher', entityId: pn.id, fileName: 'Nagpur Steel NS-1.pdf', bytes: pdf })).id;

  // Rent (194I(b)): 60,000 > 50,000 for the month → 10% = 6,000; Patil credited 54,000 (on account).
  // (GST: since 10-Oct-2024 commercial rent from an unregistered landlord to a regular taxpayer is under reverse
  // charge — Notification 09/2024-CT(Rate). This scenario keeps the rent ledger without GST so the TDS figures
  // stay readable; reverse charge itself is exercised by the GTA freight below.)
  const rent = await post(
    w,
    'rent-04',
    led(w, 'journal', '2026-04-01', [
      { ledgerId: w.L.rent, amount: P(60_000) },
      { ledgerId: w.L.patil, amount: -P(60_000) },
    ], { narration: 'Factory rent for {period}' }),
  );
  const tpl = await e.call<{ id: number }>('documents.recurring.save', { name: 'Factory rent – Patil', sourceVoucherId: rent.id, frequency: 'monthly', dayOfMonth: 1, startDate: '2026-05-01' });
  assert.ok(tpl.id > 0);

  // Manufacturing Journal 10-Apr: 200 chairs. Steel avg 50 → 1,000 kg = 50,000; paint avg (20,000 + 21,000) / 200 = 205
  // → 80 L = 16,400; consumption 66,400 + labour 20,000 = 86,400 − scrap 100 kg × 20 = 2,000 → chairs 84,400 (422 each)
  // as estimated on saving (re-valued by the late bill below).
  const mj1 = await post(w, 'mfg-1', {
    voucherTypeId: w.MJ.manufacturing,
    date: '2026-04-10',
    mode: 'inventory',
    narration: 'Batch 1',
    stockJournal: {
      bomId: w.bomId,
      lines: [
        { role: 'product', itemId: w.I.chair, qty: 200 },
        { role: 'component', itemId: w.I.steel, qty: 1000 },
        { role: 'component', itemId: w.I.paint, qty: 80 },
        { role: 'scrap', itemId: w.I.scrap, qty: 100, valueBasis: 'rate', valueRate: 20 },
      ],
      additionalCosts: [{ ledgerId: w.L.labour, basis: 'amount', value: P(20_000) }],
    },
  } as VoucherInput);
  assert.ok(mj1.id > 0);
  await post(w, 'labour-1', led(w, 'payment', '2026-04-10', [{ ledgerId: w.L.labour, amount: P(20_000) }, { ledgerId: w.L.CASH, amount: -P(20_000) }]));
  // A supplier bill received late and entered AFTER the journal, back-dated to 5-Apr: paint 100 L × 250 = 25,000
  // + C/S 2,250 = 29,500. The engine re-values batch 1 (paint average (20,000 + 21,000 + 25,000) / 300 = 220 →
  // 80 L = 17,600): consumption 67,600 + 20,000 − 2,000 = 85,600 (428 a chair), while the journal's stored
  // amounts keep the estimate made on 10-Apr (205 a litre). Every report — and the XML data export — must use 220.
  const late = await post(
    w,
    'pur-nagpur-late',
    inv(w, 'purchase', '2026-04-05', 'nagpur', [{ itemId: w.I.paint, qty: 100, rate: 250 }], { referenceNo: 'NS/2', referenceDate: '2026-04-05' }),
  );
  assert.equal(late.totals.grandTotal, P(29_500));
  newBill(w, 'nagpur', 'NS/2', -P(29_500));
  await payBill(w, 'pay-nagpur-2', '2026-04-28', 'nagpur', 'NS/2', P(29_500), { type: 'neft', number: 'UTRNAG2' });

  // Quotation 15-Apr: 50 chairs × 1,200 = 60,000 + C/S 5,400 = 70,800 → converted into the invoice on 20-Apr.
  const q = await post(w, 'quotation-1', inv(w, 'quotation', '2026-04-15', 'kolhapur', [{ itemId: w.I.chair, qty: 50, rate: 1200 }], { validUntil: '2026-05-15' }));
  const draft = await e.call<VoucherInput>('documents.draft', { sourceId: q.id, targetBaseType: 'sales', date: '2026-04-20' });
  const s1 = await post(w, 'sale-kolhapur-1', draft);
  assert.equal(s1.totals.grandTotal, P(70_800));
  newBill(w, 'kolhapur', s1.number!, P(70_800));
  await posDay(w, 'apr', '2026-04-25');

  // ── May ──
  // Contract labour: 1,00,000 + C/S 9,000 = 1,18,000; 194C firm 2% × 1,00,000 = 2,000 → Shinde 1,16,000.
  const sc = await post(w, 'contract-1', acc(w, 'purchase', '2026-05-10', 'shinde', [{ ledgerKey: 'contract', amount: P(1_00_000) }], { referenceNo: 'SC/1', referenceDate: '2026-05-10' }));
  assert.equal(sc.totals.grandTotal, P(1_18_000));
  newBill(w, 'shinde', 'SC/1', -P(1_16_000));
  // Professional fees: 60,000 + C/S 5,400 = 70,800; 194J(b) 10% × 60,000 = 6,000 → Joshi 64,800.
  await post(w, 'prof-1', acc(w, 'purchase', '2026-05-20', 'joshi', [{ ledgerKey: 'profFees', amount: P(60_000) }], { referenceNo: 'JA/1', referenceDate: '2026-05-20' }));
  newBill(w, 'joshi', 'JA/1', -P(64_800));
  // Advance for installation services (inter-state, 18% inclusive): base 1,00,000, IGST 18,000.
  await post(
    w,
    'advance-surat',
    led(w, 'receipt', '2026-05-15', [
      { ledgerId: w.L.bank, amount: P(1_18_000), instrument: { type: 'rtgs', number: 'UTRSUR1' } },
      { ledgerId: w.L.surat, amount: -P(1_18_000), billAllocations: [{ refType: 'advance', billName: 'ADV-SUR-1', amount: P(1_18_000) }] },
    ], { gstDetails: { advance: { supplyType: 'services', rate: 18 } } } as Partial<VoucherInput>),
  );
  newBill(w, 'surat', 'ADV-SUR-1', -P(1_18_000));
  await payBill(w, 'pay-shinde-1', '2026-05-25', 'shinde', 'SC/1', P(1_16_000), { type: 'cheque' });
  w.notPresented = 'pay-shinde-1';
  await payBill(w, 'pay-joshi-1', '2026-05-28', 'joshi', 'JA/1', P(64_800), { type: 'neft', number: 'UTRJOS1' });
  await payBill(w, 'pay-nagpur-1', '2026-05-02', 'nagpur', 'NS/1', P(1_42_780), { type: 'neft', number: 'UTRNAG1' });
  await receiveBill(w, 'rcpt-kolhapur-1', '2026-05-20', 'kolhapur', s1.number!, P(70_800), 'UTRKOL1');

  // ── June ──
  // Installation 1,50,000 + IGST 27,000 = 1,77,000: 1,18,000 against the advance, 59,000 new.
  const si = await post(
    w,
    'install-surat',
    acc(w, 'sales', '2026-06-10', 'surat', [{ ledgerKey: 'installation', amount: P(1_50_000) }], {
      partyBillAllocations: [
        { refType: 'against', billName: 'ADV-SUR-1', amount: P(1_18_000) },
        { refType: 'new', billName: 'INS-1', amount: P(59_000) },
      ],
    }),
  );
  assert.equal(si.totals.grandTotal, P(1_77_000));
  newBill(w, 'surat', 'ADV-SUR-1', P(1_18_000));
  newBill(w, 'surat', 'INS-1', P(59_000));
  // Export under LUT: 100 chairs × $40 = $4,000 @ ₹83 = 3,32,000.
  const ex = await post(
    w,
    'export-atlantic',
    inv(w, 'sales', '2026-06-15', 'atlantic', [{ itemId: w.I.chair, qty: 100, rate: 0, forexRate: 40 }], {
      placeOfSupply: '96',
      exportDetails: { withPayment: false, shippingBillNo: '8877665', shippingBillDate: '2026-06-16', portCode: 'INNSA1' },
      forex: { currencyId: w.usd, rate: 83, rateType: 'standard' },
    } as Partial<VoucherInput>),
  );
  assert.equal(ex.totals.grandTotal, P(3_32_000));
  newBill(w, 'atlantic', ex.number!, P(3_32_000));
  // Job work order and Material Out: 200 kg steel to Ravi at ₹50 (still our stock).
  const order = await e.call<{ id: number }>('mfg.jobWorkOrder.save', {
    direction: 'out',
    date: '2026-06-18',
    partyLedgerId: w.L.ravi,
    godownId: w.GD.ravi,
    itemId: w.I.chair,
    qty: 40,
    process: 'Fabrication',
    lines: [{ itemId: w.I.steel, qty: 200 }],
  });
  await post(w, 'material-out', {
    voucherTypeId: w.MJ.materialOut,
    date: '2026-06-20',
    mode: 'inventory',
    partyLedgerId: w.L.ravi,
    stockJournal: { thirdPartyGodownId: w.GD.ravi, jobWorkOrderId: order.id, process: 'Fabrication', lines: [{ role: 'transfer', itemId: w.I.steel, qty: 200, rate: 50, goodsType: 'inputs' }] },
  } as VoucherInput);

  // ── July ──
  // Material In: 30 chairs; 150 kg steel consumed at Ravi's (150 × 50 = 7,500) + job charges 6,000 → 13,500 (450 each).
  await post(w, 'material-in', {
    voucherTypeId: w.MJ.materialIn,
    date: '2026-07-10',
    mode: 'inventory',
    partyLedgerId: w.L.ravi,
    stockJournal: {
      thirdPartyGodownId: w.GD.ravi,
      jobWorkOrderId: order.id,
      process: 'Fabrication',
      lines: [
        { role: 'product', itemId: w.I.chair, qty: 30 },
        { role: 'component', itemId: w.I.steel, qty: 150 },
      ],
      additionalCosts: [{ ledgerId: w.L.jobCharges, basis: 'amount', value: P(6_000) }],
    },
  } as VoucherInput);
  // Ravi's bill (inter-state): 6,000 + IGST 1,080 = 7,080 (below every TDS threshold: not deducted).
  const rv = await post(w, 'jobwork-bill', acc(w, 'purchase', '2026-07-12', 'ravi', [{ ledgerKey: 'jobCharges', amount: P(6_000) }], { referenceNo: 'RF/31', referenceDate: '2026-07-11' }));
  assert.equal(rv.totals.grandTotal, P(7_080));
  newBill(w, 'ravi', 'RF/31', -P(7_080));
  // Atlantic pays $2,500 @ ₹84.50 = 2,11,250; carried 2,500 × 83 = 2,07,500 → realised gain 3,750.
  await post(
    w,
    'rcpt-atlantic',
    led(w, 'receipt', '2026-07-20', [
      { ledgerId: w.L.bank, amount: P(2_11_250), instrument: { type: 'neft', number: 'SWIFTATL1' } },
      { ledgerId: w.L.atlantic, amount: 0, forexAmount: -2500, exchangeRate: 84.5, billAllocations: [{ refType: 'against', billName: ex.number!, amount: 0, forexAmount: 2500 }] },
    ]),
  );
  newBill(w, 'atlantic', ex.number!, -P(2_07_500));
  // Kolhapur: 60 chairs × 1,200 = 72,000 + C/S 6,480 = 84,960.
  const s2 = await post(w, 'sale-kolhapur-2', inv(w, 'sales', '2026-07-15', 'kolhapur', [{ itemId: w.I.chair, qty: 60, rate: 1200 }]));
  assert.equal(s2.totals.grandTotal, P(84_960));
  newBill(w, 'kolhapur', s2.number!, P(84_960));
  await receiveBill(w, 'rcpt-surat', '2026-07-25', 'surat', 'INS-1', P(59_000), 'UTRSUR2');
  await payBill(w, 'pay-ravi', '2026-07-28', 'ravi', 'RF/31', P(7_080), { type: 'neft', number: 'UTRRAV1' });

  // ── August ──
  // Scrap 80 kg × 100 = 8,000 + C/S 720 = 9,440; TCS 206C(1) 1% on 9,440 (incl. GST) = 94.40 → 94 → 9,534.
  const sp1 = await post(w, 'scrap-1', inv(w, 'sales', '2026-08-15', 'bharat', [{ itemId: w.I.scrap, qty: 80, rate: 100, ledgerId: w.L.scrapSales }]));
  assert.equal(sp1.totals.grandTotal, P(9_534));
  newBill(w, 'bharat', sp1.number!, P(9_534));
  // GTA freight under reverse charge: 10,000; RCM C/S 250 each.
  const gt = await post(w, 'gta-1', acc(w, 'purchase', '2026-08-12', 'gta', [{ ledgerKey: 'freight', amount: P(10_000) }], { referenceNo: 'SR/9', referenceDate: '2026-08-12' }));
  assert.equal(gt.totals.grandTotal, P(10_000));
  newBill(w, 'gta', 'SR/9', -P(10_000));
  await posDay(w, 'aug', '2026-08-22');
  await receiveBill(w, 'rcpt-kolhapur-2', '2026-08-20', 'kolhapur', s2.number!, P(84_960), 'UTRKOL2');

  // ── September ──
  // Manufacturing Journal 100 chairs: steel avg still 50 → 500 kg = 25,000; paint avg 220 → 40 L = 8,800; labour 10,000;
  // scrap 50 kg × 20 = 1,000 → chairs 42,800 (428 each).
  await post(w, 'mfg-2', {
    voucherTypeId: w.MJ.manufacturing,
    date: '2026-09-05',
    mode: 'inventory',
    narration: 'Batch 2',
    stockJournal: {
      bomId: w.bomId,
      lines: [
        { role: 'product', itemId: w.I.chair, qty: 100 },
        { role: 'component', itemId: w.I.steel, qty: 500 },
        { role: 'component', itemId: w.I.paint, qty: 40 },
        { role: 'scrap', itemId: w.I.scrap, qty: 50, valueBasis: 'rate', valueRate: 20 },
      ],
      additionalCosts: [{ ledgerId: w.L.labour, basis: 'amount', value: P(10_000) }],
    },
  } as VoucherInput);
  await post(w, 'labour-2', led(w, 'payment', '2026-09-05', [{ ledgerId: w.L.labour, amount: P(10_000) }, { ledgerId: w.L.CASH, amount: -P(10_000) }]));
  // Joshi 40,000 + C/S 3,600 = 47,200; 194J(b) 4,000 → 43,200.
  await post(w, 'prof-2', acc(w, 'purchase', '2026-09-18', 'joshi', [{ ledgerKey: 'profFees', amount: P(40_000) }], { referenceNo: 'JA/2', referenceDate: '2026-09-18' }));
  newBill(w, 'joshi', 'JA/2', -P(43_200));
  await payBill(w, 'pay-gta', '2026-09-10', 'gta', 'SR/9', P(10_000), { type: 'neft', number: 'UTRGTA1' });

  // ── October: optional sale (scenario), an open quotation ──
  await post(w, 'optional-sale', inv(w, 'sales', '2026-10-12', 'kolhapur', [{ itemId: w.I.chair, qty: 10, rate: 1200 }], { isOptional: true }));
  w.quotationOpenId = (await post(w, 'quotation-2', inv(w, 'quotation', '2026-10-20', 'surat', [{ itemId: w.I.chair, qty: 25, rate: 1300 }], { validUntil: '2026-11-20' }))).id;
  await payBill(w, 'pay-joshi-2', '2026-10-05', 'joshi', 'JA/2', P(43_200), { type: 'cheque' });

  // ── November: Shinde 50,000 + C/S 4,500 = 59,000; 194C 1,000 → 58,000 (unpaid at year end) ──
  await post(w, 'contract-2', acc(w, 'purchase', '2026-11-14', 'shinde', [{ ledgerKey: 'contract', amount: P(50_000) }], { referenceNo: 'SC/2', referenceDate: '2026-11-14' }));
  newBill(w, 'shinde', 'SC/2', -P(58_000));
  // Debit note (deficient work) 25-Nov against SC/2: 10,000 + C/S 900 = 11,800; the bill's TDS is reversed in
  // proportion: 1,000 × 10,000 / 50,000 = 200 → Shinde debited 11,600; November's 194C nets to 800.
  const dnS = await post(
    w,
    'dn-shinde',
    acc(w, 'debit_note', '2026-11-25', 'shinde', [{ ledgerKey: 'contract', amount: P(10_000) }], {
      originalInvoiceNo: 'SC/2',
      originalInvoiceDate: '2026-11-14',
      referenceNo: 'DN-SC2',
      noteReason: 'Deficiency in service',
      partyBillAllocations: [{ refType: 'against', billName: 'SC/2', amount: P(11_600) }],
    }),
  );
  assert.ok(dnS.id > 0);
  newBill(w, 'shinde', 'SC/2', P(11_600));

  // ── December, March: POS days; March scrap 50 kg × 100 = 5,000 + 900 = 5,900; TCS 59 → 5,959 (unpaid) ──
  await posDay(w, 'dec', '2026-12-19');
  // A POS customer created by mobile buys 2 chairs × 1,500 = 3,000 + C/S 270 = 3,540: cash 1,000, 2,540 on credit.
  const cust = await e.call<{ ledgerId: number }>('pos.customer.create', { name: 'Kavita Joshi', mobile: '98220 12345' });
  w.L.kavita = cust.ledgerId;
  const credit = await post(w, 'pos-dec-credit', {
    voucherTypeId: w.pos.saleTypeId,
    date: '2026-12-19',
    mode: 'item_invoice',
    partyLedgerId: cust.ledgerId,
    placeOfSupply: '27',
    items: [{ itemId: w.I.chair, qty: 2, rate: 1500 }],
    posBill: { tenders: [{ modeId: w.pos.cash, amount: P(1_000) }] },
  } as VoucherInput);
  assert.equal(credit.totals.grandTotal, P(3_540));
  newBill(w, 'kavita', credit.number!, P(2_540));
  w.posBills.sales += 1;
  w.posBills.salesValue += P(3_540);
  await posDay(w, 'mar', '2027-03-20');
  const sp2 = await post(w, 'scrap-2', inv(w, 'sales', '2027-03-10', 'bharat', [{ itemId: w.I.scrap, qty: 50, rate: 100, ledgerId: w.L.scrapSales }]));
  assert.equal(sp2.totals.grandTotal, P(5_959));
  newBill(w, 'bharat', sp2.number!, P(5_959));
  // Bharat returns 10 kg (25-Mar): 1,000 + C/S 90 = 1,180; TCS reversed in proportion 59 × 1,000 / 5,000 = 11.80 → 12
  // → credit note 1,192 against the March invoice; Bharat owes 5,959 − 1,192 = 4,767.
  const cnB = await post(
    w,
    'cn-bharat',
    inv(w, 'credit_note', '2027-03-25', 'bharat', [{ itemId: w.I.scrap, qty: 10, rate: 100, ledgerId: w.L.scrapSales }], {
      originalInvoiceNo: sp2.number!,
      originalInvoiceDate: '2027-03-10',
      noteReason: 'Sales return',
      partyBillAllocations: [{ refType: 'against', billName: sp2.number!, amount: P(1_192) }],
    }),
  );
  assert.equal(cnB.totals.grandTotal, P(1_192));
  newBill(w, 'bharat', sp2.number!, -P(1_192));
  await receiveBill(w, 'rcpt-bharat', '2026-09-15', 'bharat', sp1.number!, P(9_534), 'UTRBHA1');

  // ── Recurring rent May–March from the due list (review, then post) ──
  const due = await e.call<{ rows: Array<{ templateId: number; periodKey: string }> }>('documents.recurring.due', {});
  assert.equal(due.rows.length, 11, 'May–March rent due');
  const posted = await e.call<{ posted: number; results: Array<{ ok: boolean; voucherId?: number }> }>('documents.recurring.post', {
    items: due.rows.map((r) => ({ templateId: r.templateId, periodKey: r.periodKey })),
    acknowledgeWarnings: true,
  });
  assert.equal(posted.posted, 11, JSON.stringify(posted.results.filter((r) => !r.ok)));
  w.created += 11;
  // Rent cheques 54,000 on the 5th of every month (cheque leaves filled on save).
  for (const ym of FY_MONTHS) {
    await post(w, `rent-pay-${ym}`, led(w, 'payment', day(ym, 5), [{ ledgerId: w.L.patil, amount: P(54_000) }, { ledgerId: w.L.bank, amount: -P(54_000), instrument: { type: 'cheque' } }]));
  }

  // ── Statutory deposits: TDS / TCS for April–February, GST set-off for April–February ──
  for (const ym of FY_MONTHS.slice(0, 11)) await tdsChallans(w, ym);
  for (const ym of FY_MONTHS.slice(0, 11)) await gstSetoff(w, ym);

  // ── Period end: forex revaluation of $1,500 at ₹85 (carried 1,24,500 → 1,27,500: gain 3,000) ──
  const rev = await e.call<{ voucherId: number; net: number }>('forex.revaluation.post', { asOf: AF_FY_END });
  assert.equal(rev.net, P(3_000));
  w.created++;
  newBill(w, 'atlantic', ex.number!, P(3_000));
}

/** Scenario (optional vouchers included) and a budget for the year. */
export async function planning(w: AfWorld): Promise<void> {
  const types = await w.e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {});
  const salesTypes = types.rows.filter((t) => t.baseType === 'sales').map((t) => t.id);
  w.scenarioId = (await w.e.call<{ id: number }>('documents.scenario.save', { name: 'With optional sales', includeActuals: true, includeTypeIds: salesTypes, excludeTypeIds: [] })).id;
  w.budgetId = (
    await w.e.call<{ id: number }>('documents.budget.save', {
      name: 'FY 2026-27',
      from: AF_BOOKS_FROM,
      to: AF_FY_END,
      lines: [
        { kind: 'ledger', refId: w.L.rent, basis: 'net_transactions', amount: P(7_20_000) },
        { kind: 'ledger', refId: w.L.profFees, basis: 'net_transactions', amount: P(1_20_000) },
      ],
    })
  ).id;
}

/**
 * The bank statement of April–June written from the bank ledger itself (every entry the bank saw),
 * except the cheque to Shinde (not presented by 30-Jun); cheques clear two days after their date.
 */
export async function bankStatementQ1(w: AfWorld): Promise<{ closing: number; notPresented: number; lines: number; autoMatched: number; manual: number }> {
  const from = '2026-04-01';
  const to = '2026-06-30';
  const lg = await w.e.call<{ opening: number; rows: Array<{ voucherId: number; date: string; debit: number; credit: number; number: string | null }> }>('reports.ledger', { ledgerId: w.L.bank, from, to });
  const skip = w.V[w.notPresented].id;
  const instrumentOf = async (voucherId: number): Promise<string> => {
    const v = await w.e.call<{ entries: Array<{ ledgerId: number; instrument?: { type: string } | null }> }>('vouchers.get', { id: voucherId });
    return v.entries.find((x) => x.ledgerId === w.L.bank)?.instrument?.type ?? 'neft';
  };
  type Row = { date: string; narration: string; amount: number };
  const rows: Row[] = [];
  let notPresented = 0;
  for (const r of lg.rows) {
    const amount = r.debit - r.credit;
    if (r.voucherId === skip) {
      notPresented += -amount;
      continue;
    }
    const kind = await instrumentOf(r.voucherId);
    const d = kind === 'cheque' ? `${r.date.slice(0, 8)}${String(Number(r.date.slice(8)) + 2).padStart(2, '0')}` : r.date;
    rows.push({ date: d, narration: `${kind.toUpperCase()}-${r.number ?? r.voucherId}`, amount });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const ddmmyy = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
  const rupees = (p: number): string => (p / 100).toFixed(2);
  let bal = lg.opening;
  const csv = ['Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance'];
  for (const r of rows) {
    bal += r.amount;
    csv.push([ddmmyy(r.date), r.narration, '', ddmmyy(r.date), r.amount < 0 ? rupees(-r.amount) : '', r.amount > 0 ? rupees(r.amount) : '', rupees(bal)].join(','));
  }
  const bytes = new TextEncoder().encode(csv.join('\r\n') + '\r\n');
  const preview = await w.e.call<{ mapping: unknown; lines: unknown[] }>('banking.statement.preview', { ledgerId: w.L.bank, fileName: 'HDFC_Q1.csv', bytes });
  assert.equal(preview.lines.length, rows.length);
  const imp = await w.e.call<{ batchId: number; imported: number; closingBalance: number }>('banking.statement.import', { ledgerId: w.L.bank, fileName: 'HDFC_Q1.csv', bytes, mapping: preview.mapping });
  assert.equal(imp.closingBalance, bal);
  const am = await w.e.call<{ applied: unknown[] }>('banking.autoMatch', { ledgerId: w.L.bank, batchId: imp.batchId });
  // Two TDS challans of ₹6,000 paid on the same day are ambiguous for the auto-match (it never guesses):
  // the accountant matches them by hand from the suggestions.
  const left = await w.e.call<{ rows: Array<{ id: number }> }>('banking.statement.lines', { ledgerId: w.L.bank, from, to, status: 'unmatched' });
  const used = new Set<number>();
  for (const line of left.rows) {
    const cands = await w.e.call<Array<{ ledgerEntryId: number }>>('banking.suggestions', { lineId: line.id });
    const pick = cands.find((c) => !used.has(c.ledgerEntryId));
    assert.ok(pick, `statement line ${line.id} has a candidate`);
    used.add(pick.ledgerEntryId);
    await w.e.call('banking.match', { lineId: line.id, ledgerEntryId: pick.ledgerEntryId });
  }
  return { closing: bal, notPresented, lines: rows.length, autoMatched: am.applied.length, manual: used.size };
}

// ───────────────────────────── Composition variant ─────────────────────────────

export const CMP_OWNER = { username: 'owner', displayName: 'Sai Patil', password: 'Shirdi#2026' };

export interface CmpWorld {
  e: E2E;
  companyId: string;
  L: Record<string, number>;
  I: Record<string, number>;
  VT: Record<string, number>;
  /** Σ outward taxable value per quarter (paise) — the scenario's own expectation. */
  turnover: Record<string, number>;
  challans: number;
}

/**
 * Shirdi Sweets (composition, manufacturer of sweets: 1% of turnover, ½ CGST ½ SGST), books from 1-Apr-2026.
 * Each quarter: purchase of milk solids from a regular supplier (tax is a cost), cash sales (bills of supply).
 * CMP-08 set-off (cash only) + challan for Q1–Q3 on the 18th after the quarter; Q4 stays payable.
 */
export async function createCompositionCompany(e: E2E): Promise<CmpWorld> {
  const state = await e.call<{ companies: Array<{ id: string; name: string }> }>('app.company.create', {
    name: 'Shirdi Sweets',
    stateCode: '27',
    gstRegistrationType: 'composition',
    gstin: makeGstin('27', 'AAAFS3030K'),
    pan: 'AAAFS3030K',
    booksFrom: AF_BOOKS_FROM,
    owner: CMP_OWNER,
  });
  const companyId = state.companies.find((c) => c.name === 'Shirdi Sweets')!.id;
  const w: CmpWorld = { e, companyId, L: {}, I: {}, VT: {}, turnover: {}, challans: 0 };
  const groups = await e.call<{ rows: Array<{ id: number; reservedCode: string | null }> }>('accounts.group.list', {});
  const G: Record<string, number> = {};
  for (const g of groups.rows) if (g.reservedCode) G[g.reservedCode] = g.id;
  const ledgers = await e.call<{ rows: Array<{ id: number; reservedCode: string | null }> }>('accounts.ledger.list', { limit: 10_000 });
  for (const l of ledgers.rows) if (l.reservedCode) w.L[l.reservedCode] = l.id;
  for (const t of (await e.call<{ rows: Array<{ id: number; baseType: string; isPredefined: boolean }> }>('accounts.voucherType.list', {})).rows) if (t.isPredefined) w.VT[t.baseType] = t.id;
  await e.call('accounts.ledger.save', { id: w.L.CASH, openingBalance: P(2_00_000) });
  w.L.capital = (await e.call<{ id: number }>('accounts.ledger.save', { name: 'Proprietor Capital', groupId: G.CAPITAL_ACCOUNT, openingBalance: -P(5_00_000) })).id;
  w.L.bank = (await e.call<{ id: number }>('accounts.ledger.save', { name: 'SBI Current A/c', groupId: G.BANK_ACCOUNTS, openingBalance: P(3_00_000) })).id;
  w.L.dairy = (await e.call<{ id: number }>('accounts.ledger.save', { name: 'Ahmednagar Dairy', groupId: G.SUNDRY_CREDITORS, gstin: makeGstin('27', 'AAACA7070D'), registrationType: 'regular' })).id;
  const units = await e.call<{ rows: Array<{ id: number; symbol: string }> }>('inventory.unit.list', {});
  const kg = units.rows.find((u) => u.symbol === 'Kg')!.id;
  w.I.khoya = (await e.call<{ item: { id: number } }>('inventory.item.save', { name: 'Khoya', unitId: kg, gstApplicable: true, taxability: 'taxable', gstRate: 5, hsnSac: '0406' })).item.id;
  w.I.pedha = (await e.call<{ item: { id: number } }>('inventory.item.save', { name: 'Pedha', unitId: kg, gstApplicable: true, taxability: 'taxable', gstRate: 5, hsnSac: '1704' })).item.id;
  return w;
}

/**
 * Per quarter q (0..3), first month m: purchase khoya 100 kg × 300 = 30,000 + C/S 750 = 31,500 (tax is a cost,
 * paid by bank); cash sales of pedha 40 kg × 500 = 20,000 (no tax) in each of the quarter's three months.
 * Turnover per quarter 60,000 → composition tax 1% = 600 (CGST 300 + SGST 300).
 */
export async function postCompositionYear(w: CmpWorld): Promise<void> {
  const { e } = w;
  for (let q = 0; q < 4; q++) {
    const months = FY_MONTHS.slice(q * 3, q * 3 + 3);
    const p = await e.call<{ id: number; totals: { grandTotal: number } }>('vouchers.save', {
      voucherTypeId: w.VT.purchase,
      date: day(months[0], 5),
      mode: 'item_invoice',
      partyLedgerId: w.L.dairy,
      referenceNo: `AD/${q + 1}`,
      referenceDate: day(months[0], 5),
      items: [{ itemId: w.I.khoya, qty: 100, rate: 300 }],
      acknowledgeWarnings: true,
    });
    assert.equal(p.totals.grandTotal, P(31_500), 'tax charged by the supplier is part of the cost');
    await e.call('vouchers.save', {
      voucherTypeId: w.VT.payment,
      date: day(months[0], 25),
      mode: 'ledger',
      ledgers: [
        { ledgerId: w.L.dairy, amount: P(31_500), billAllocations: [{ refType: 'against', billName: `AD/${q + 1}`, amount: P(31_500) }] },
        { ledgerId: w.L.bank, amount: -P(31_500), instrument: { type: 'neft', number: `UTRAD${q + 1}` } },
      ],
      acknowledgeWarnings: true,
    });
    for (const ym of months) {
      const s = await e.call<{ totals: { grandTotal: number } }>('vouchers.save', {
        voucherTypeId: w.VT.sales,
        date: day(ym, 15),
        mode: 'item_invoice',
        partyLedgerId: w.L.CASH,
        items: [{ itemId: w.I.pedha, qty: 40, rate: 500 }],
        acknowledgeWarnings: true,
      });
      assert.equal(s.totals.grandTotal, P(20_000), 'bill of supply: no tax');
      // Pedha comes from the khoya (no BOM needed for the test): a stock journal of 40 kg.
      await e.call('vouchers.save', {
        voucherTypeId: w.VT.stock_journal,
        date: day(ym, 14),
        mode: 'inventory',
        items: [
          { itemId: w.I.khoya, qty: 30, rate: 300, isConsumption: true },
          { itemId: w.I.pedha, qty: 40, rate: 225 },
        ],
        acknowledgeWarnings: true,
      });
    }
    w.turnover[`Q${q + 1}`] = P(60_000);
  }
  // CMP-08 Q1–Q3: challan (cash) on the 18th after the quarter, then the set-off journal.
  for (const [q, last] of [[1, '2026-06'], [2, '2026-09'], [3, '2026-12']] as const) {
    const nm = nextMonth(last);
    const period = `2026-27-Q${q}`;
    const s = await e.call<{ cash: Array<{ head: string; toDeposit: number }> }>('gst.setoff.compute', { period });
    const heads = s.cash.filter((c) => c.toDeposit > 0).map((c) => ({ head: c.head, minor: 'tax', amount: c.toDeposit }));
    w.challans++;
    await e.call('gst.challan.post', { date: day(nm, 18), bankLedgerId: w.L.bank, cpin: `2700${q}0000000${q}`.slice(0, 14), challanDate: day(nm, 18), period, heads });
    await e.call('gst.setoff.post', { period, date: day(nm, 18) });
  }
}
