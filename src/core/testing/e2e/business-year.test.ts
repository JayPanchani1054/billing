/**
 * BUSINESS YEAR end-to-end audit (FY 2026-27): drives the real runtime ONLY through
 * runtime.dispatch(route, input) — company creation with owner login, F11 features, masters, ~185
 * vouchers (purchases intra/inter, RCM GTA, capital goods, import of services, composition supplier,
 * blocked ITC, B2B intra/inter, B2CL, B2CS cash and credit, exports LUT and with payment, SEZ LUT and
 * with payment, credit/debit notes, receipts/payments against bills, advances, on account, contra,
 * journals, delivery note billed later, stock journal, physical stock, optional, cancelled and
 * post-dated vouchers, alters and deletes), a bank statement import + auto-match + BRS, a GSTR-2B import +
 * reconciliation, and a backup → verify → restore as a new company.
 *
 * Then it ties every module to every other one, the way a Chartered Accountant closes a year:
 *   Trial Balance ↔ Balance Sheet ↔ Profit & Loss ↔ stock valuation ↔ stock summary;
 *   GST tax ledgers ↔ gst_lines (vouchers.get) ↔ GSTR-1 ↔ GSTR-3B (year and Σ months) ↔ GSTR-9 ↔ dashboard;
 *   party ledgers ↔ outstanding ↔ dashboard; bank ledger ↔ statement ↔ BRS; cost centres ↔ ledgers;
 *   original books ↔ restored books.
 *
 * Hand-computed expectations (rupees) are written next to each assertion; scenario.ts documents every
 * voucher's arithmetic. Money is paise.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { makeGstin, testPan } from '../fixtures.ts';
import { FY_MONTHS, P, periodKey, startRuntime, sum, type E2E } from './harness.ts';
import {
  BOOKS_FROM,
  FY_END,
  ON_ACCOUNT,
  OWNER,
  alterAndDelete,
  bankQuarter,
  createCompany,
  createMasters,
  gstr2bJuly,
  post,
  postYear,
  type BankStep,
  type World,
} from './scenario.ts';

type Heads = { igst: number; cgst: number; sgst: number; cess: number };
const HEADS = ['igst', 'cgst', 'sgst', 'cess'] as const;
const zero = (): Heads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
const add = (a: Heads, b: Partial<Heads>, sign = 1): Heads => {
  for (const h of HEADS) a[h] += sign * (b[h] ?? 0);
  return a;
};
/** Normalise −0 so deepEqual compares amounts, not IEEE signed zeros. */
const n0 = (x: number): number => (x === 0 ? 0 : x);

interface TbRow { key: string; kind: string; id: number | null; name: string; level: number; opening: number; debit: number; credit: number; closing: number }
interface Tb { rows: TbRow[]; totals: { opening: { debit: number; credit: number }; closing: { debit: number; credit: number } }; balanced: boolean; openingDifference: number; unbalancedBy: number; openingStock: number }
interface StatementLine { key: string; kind: string; id: number | null; name: string; level: number; amount: number }
interface Pl { figures: Record<string, number>; trading: { total: number }; profitLoss: { total: number } }
interface Bs { liabilities: StatementLine[]; assets: StatementLine[]; liabilitiesTotal: number; assetsTotal: number; difference: number; balanced: boolean; closingStock: number; profitLoss: { openingBalance: number; currentPeriod: number; total: number }; openingDifference: number }
interface G3b {
  supplies: Array<Heads & { key: string; taxable: number }>;
  itc: { available: Array<Heads & { ty: string }>; reversed: Array<Heads & { ty: string }>; net: Heads; blocked: Heads };
  inward: Array<{ ty: string; inter: number; intra: number }>;
}
interface G1 { totals: Heads & { taxable: number }; sections: Array<Heads & { id: string; taxable: number; count: number }>; docs: Array<{ docNum: number; total: number; cancelled: number; missing: number; net: number }> }
interface GstLine extends Heads { taxableValue: number; isReverseCharge: boolean; itcEligibility: string | null; taxability: string }
interface VDetail { id: number; voucherType: { baseType: string }; gstNature: string | null; gstLines: GstLine[]; affectsBooks?: boolean }

const FY = { from: BOOKS_FROM, to: FY_END };
const SEZ_SUPPLIER_GSTIN = makeGstin('27', testPan(32));

describe('business year FY 2026-27 through runtime.dispatch', () => {
  let e: E2E;
  let w: World;
  let bank: BankStep;
  let tb: Tb;
  let tbGroups: Tb;
  let pl: Pl;
  let bs: Bs;
  const ledgerClasses = new Map<number, string[]>();

  before(async () => {
    e = startRuntime(FY_END);
    w = await createCompany(e);
    await createMasters(w);
    await postYear(w);
    await alterAndDelete(w);
    bank = await bankQuarter(w);
    tb = await e.call<Tb>('reports.trialBalance', { ...FY, mode: 'ledgers' });
    tbGroups = await e.call<Tb>('reports.trialBalance', { ...FY, mode: 'groups' });
    pl = await e.call<Pl>('reports.profitLoss', FY);
    bs = await e.call<Bs>('reports.balanceSheet', { asOf: FY_END });
    const list = await e.call<{ rows: Array<{ id: number; classes: string[] }> }>('accounts.ledger.list', { limit: 10_000 });
    for (const r of list.rows) ledgerClasses.set(r.id, r.classes);
  });
  after(async () => {
    await e?.close();
  });

  const closing = (key: string): number => {
    const id = w.L[key];
    const row = tb.rows.find((r) => r.key === `l:${id}`);
    return row ? row.closing : 0;
  };

  it('entered a full year: ≥ 150 vouchers through vouchers.save, with no unexpected warnings', async () => {
    assert.ok(w.created >= 150, `created ${w.created}`);
    assert.deepEqual(w.acknowledged, {}, 'no guard warnings had to be acknowledged in a clean year');
    const list = await e.call<{ total: number }>('vouchers.list', { ...FY, limit: 1 });
    // created − 2 deleted − 1 post-dated cheque dated after the year (10-Apr-2027).
    assert.equal(list.total, w.created - 2 - 1);
  });

  it('trial balance: Σ = 0, no opening difference, and it equals Σ ledger balances + opening stock', () => {
    assert.equal(tb.balanced, true);
    assert.equal(tb.openingDifference, 0, 'Σ ledger openings + opening stock 9,20,000 = 0');
    assert.equal(tb.unbalancedBy, 0);
    assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
    assert.equal(tb.totals.opening.debit, P(21_88_000), 'Bank 8,00,000 + Cash 50,000 + Furniture 3,00,000 + Mumbai 1,18,000 + stock 9,20,000');
    assert.equal(tb.openingStock, P(9_20_000));
    // Ledgers mode: Σ every row's closing (opening stock row included) is exactly 0.
    assert.equal(sum(tb.rows, (r) => r.closing), 0);
    // Groups mode nets each group (a customer in credit offsets the others), so only Σ = 0 is common to both.
    assert.equal(tbGroups.balanced, true);
    assert.equal(sum(tbGroups.rows.filter((r) => r.level === 0), (r) => r.closing), 0, 'groups mode: Σ top-level closings = 0');
  });

  it('hand-computed closing balances of key ledgers', () => {
    // Output CGST = 12 × (4,050 + 2,700) Mumbai + 11 × (432 + 75) cash sales (one deleted) + 1,368 (DN invoice)
    //             + 190 (B2CS credit) − 450 (CN Mumbai) = 87,685 Cr
    assert.equal(closing('OUTPUT_CGST'), -P(87_685));
    assert.equal(closing('OUTPUT_SGST'), -P(87_685));
    // Output IGST = 12 × 28,800 Bengaluru + 21,600 B2CL + 3,240 export WPAY + 1,368 SEZ WPAY − 1,152 CN = 3,70,656 Cr
    assert.equal(closing('OUTPUT_IGST'), -P(3_70_656));
    // Input CGST = 12 × 6,092 Pune + 45,000 capital goods + 525 tonic + 4 × 500 GTA RCM − 216 purchase return = 1,20,413 Dr
    assert.equal(closing('INPUT_CGST'), P(1_20_413));
    assert.equal(closing('INPUT_SGST'), P(1_20_413));
    // Input IGST = 12 × 23,820 Delhi + 828 (altered Feb purchase) + 18,000 import of services = 3,04,668 Dr
    assert.equal(closing('INPUT_IGST'), P(3_04_668));
    assert.equal(closing('RCM_CGST'), -P(2_000), '4 GTA bills × 500');
    assert.equal(closing('RCM_SGST'), -P(2_000));
    assert.equal(closing('RCM_IGST'), -P(18_000), 'import of services 1,00,000 × 18%');
    // Staff welfare: the blocked tax (250 + 250) is part of the expense.
    assert.equal(closing('staffWelfare'), P(10_500));
    // Sales = 12 × (1,92,000 + 1,16,000) + 11 × 7,800 + 1,20,000 + 1,00,000 + 18,000 + 31,000 + 7,600 + 15,200 + 7,600
    //         − 18,000 − 6,400 (credit notes) = 40,56,800 Cr
    assert.equal(closing('SALES'), -P(40_56_800));
    // Purchase = 12 × (1,68,800 + 97,500) + 4,600 (alter) + 29,000 + 21,000 − 2,400 (return) = 32,47,800 Dr
    assert.equal(closing('PURCHASE'), P(32_47_800));
    assert.equal(closing('rent'), P(3_62_000), '11 × 30,000 + 32,000 (altered)');
    assert.equal(closing('bankCharges'), P(590), 'created from the bank statement line');
    // Cash = 50,000 + 11 × 8,814 − 11 × 8,000 (one deposit deleted) − 29,000 composition supplier = 29,954 Dr
    assert.equal(closing('CASH'), P(29_954));
    assert.equal(closing('delhi'), -P(5_428), 'altered DA-11 left 5,428 unpaid; the cheque dated 10-Apr-2027 is not yet in the books');
  });

  it('profit & loss agrees with the trial balance (nominal ledgers + stock movement)', () => {
    const f = pl.figures;
    let nominal = 0;
    for (const r of tb.rows) {
      if (r.kind !== 'ledger' || r.id === null) continue;
      const cls = ledgerClasses.get(r.id) ?? [];
      if (cls.includes('income') || cls.includes('expense')) nominal += r.closing;
    }
    // Net profit = −Σ(income & expense closings, Dr +) − opening stock + closing stock.
    assert.equal(f.netProfit, -nominal - f.openingStock + f.closingStock);
    assert.equal(f.openingStock, P(9_20_000));
    assert.equal(f.sales, P(40_56_800));
    assert.equal(f.purchases, P(32_47_800));
    assert.equal(f.directExpenses, P(80_000), 'GTA freight 4 × 20,000 (RCM tax is not a cost)');
    assert.equal(f.indirectIncomes, P(4_500));
    assert.equal(f.grossProfit, f.sales + f.directIncomes + f.closingStock - f.openingStock - f.purchases - f.directExpenses);
    assert.equal(f.netProfit, f.grossProfit + f.indirectIncomes - f.indirectExpenses);
  });

  it('balance sheet: balanced, profit line = P&L net profit, closing stock = stock reports = valuation', async () => {
    assert.equal(bs.balanced, true);
    assert.equal(bs.difference, 0);
    assert.equal(bs.liabilitiesTotal, bs.assetsTotal);
    assert.equal(bs.openingDifference, 0);
    assert.equal(bs.profitLoss.currentPeriod, pl.figures.netProfit, 'BS current-period profit = P&L net profit');
    assert.equal(bs.profitLoss.openingBalance, 0, 'first year: nothing brought forward');
    assert.equal(bs.closingStock, pl.figures.closingStock);
    const ss = await e.call<{ totals: { openingValue: number; closingValue: number }; rows: Array<{ kind: string; id: number; closing: { qty: number | null; value: number } }> }>(
      'stock.summary',
      FY,
    );
    const val = await e.call<{ totals: { openingValue: number; closingValue: number }; rows: Array<{ itemId: number; closing: { qty: number; value: number } }> }>(
      'inventory.valuation',
      FY,
    );
    assert.equal(ss.totals.closingValue, bs.closingStock, 'stock summary = balance sheet closing stock');
    assert.equal(val.totals.closingValue, bs.closingStock, 'inventory valuation = balance sheet closing stock');
    assert.equal(ss.totals.openingValue, P(9_20_000));
    assert.equal(sum(val.rows, (r) => r.closing.value), val.totals.closingValue);
    // Closing quantities, by hand:
    //  Utensils 200 + 12×60 − 12×40 − 11×6 − 5 (return) − 20 (export) − 10 (SEZ) − 20 (delivery note) − 3 (count) = 316
    //  Rice     300 + 12×100 − 12×90 + 10 (CN) − 50 (export) + 20 (composition) − 4 (walk-in) = 396
    //  Cigars    50 + 12×15 − 12×12 = 86
    //  Mixers   100 + 12×30 + 2 (alter) − 12×25 − 40 (B2CL) − 10 (SEZ) + 2 (CN) = 114
    //  Tonic    100 + 100 − 11×10 = 90
    const qty = (k: string): number => val.rows.find((r) => r.itemId === w.I[k])!.closing.qty;
    assert.deepEqual(
      { utensil: qty('utensil'), rice: qty('rice'), cigar: qty('cigar'), mixer: qty('mixer'), tonic: qty('tonic') },
      { utensil: 316, rice: 396, cigar: 86, mixer: 114, tonic: 90 },
    );
    for (const r of ss.rows.filter((x) => x.kind === 'item')) {
      const v = val.rows.find((x) => x.itemId === r.id)!;
      assert.equal(r.closing.value, v.closing.value, `item ${r.id}: stock summary value = valuation`);
      assert.equal(r.closing.qty, v.closing.qty, `item ${r.id}: stock summary qty = valuation`);
    }
    // Stock-in-Hand appears on the asset side with the closing stock.
    const stockLine = bs.assets.find((l) => l.kind === 'stock' || /stock/i.test(l.name));
    assert.ok(stockLine, 'closing stock line on the asset side');
    assert.equal(stockLine.amount, bs.closingStock);
  });

  it('balance sheet group lines equal the trial balance group closings', () => {
    for (const side of [bs.liabilities, bs.assets] as const) {
      for (const line of side.filter((l) => l.kind === 'group' && l.level === 0)) {
        const t = tbGroups.rows.find((r) => r.key === line.key);
        assert.ok(t, `TB has group ${line.name}`);
        const sign = side === bs.assets ? 1 : -1;
        let expected = sign * t.closing;
        // Current Assets carries the closing stock (Stock-in-Hand) on the Balance Sheet; the TB shows opening stock separately.
        if (/current assets/i.test(line.name)) expected += bs.closingStock;
        assert.equal(line.amount, expected, `BS ${line.name} = TB closing (${t.closing})`);
      }
    }
  });

  it('GST: tax ledgers = gst_lines (vouchers.get) = GSTR-1 = GSTR-3B for the year, by head', async () => {
    const docs = await e.call<{ rows: Array<{ id: number; baseType: string; isOptional: boolean; isCancelled: boolean }> }>('vouchers.list', {
      ...FY,
      baseTypes: ['sales', 'purchase', 'credit_note', 'debit_note'],
      includeOptional: false,
      includeCancelled: false,
      limit: 1000,
    });
    const outward = zero();
    const inward = zero();
    const rcm = zero();
    let outwardTaxable = 0;
    for (const row of docs.rows) {
      const d = await e.call<VDetail>('vouchers.get', { id: row.id });
      const base = d.voucherType.baseType;
      const isOut = base === 'sales' || base === 'credit_note';
      const sign = base === 'credit_note' || base === 'debit_note' ? -1 : 1;
      for (const g of d.gstLines) {
        if (isOut) {
          if (g.isReverseCharge) continue;
          add(outward, g, sign);
          if (g.taxability === 'taxable') outwardTaxable += sign * g.taxableValue;
        } else {
          if (g.itcEligibility !== 'ineligible') add(inward, g, sign);
          if (g.isReverseCharge || d.gstNature === 'import_services') add(rcm, g, sign);
        }
      }
    }
    const ledgerHeads = (prefix: string): Heads => ({
      igst: closing(`${prefix}_IGST`),
      cgst: closing(`${prefix}_CGST`),
      sgst: closing(`${prefix}_SGST`),
      cess: closing(`${prefix}_CESS`),
    });
    const neg = (h: Heads): Heads => ({ igst: n0(-h.igst), cgst: n0(-h.cgst), sgst: n0(-h.sgst), cess: n0(-h.cess) });
    assert.deepEqual(neg(ledgerHeads('OUTPUT')), outward, 'Output ledgers (Cr) = Σ outward gst_lines');
    assert.deepEqual(ledgerHeads('INPUT'), inward, 'Input ledgers = Σ claimable inward gst_lines');
    assert.deepEqual(neg(ledgerHeads('RCM')), rcm, 'RCM payable ledgers = Σ reverse-charge inward gst_lines');

    const g1 = await e.call<G1>('gst.gstr1.summary', FY);
    assert.deepEqual({ igst: g1.totals.igst, cgst: g1.totals.cgst, sgst: g1.totals.sgst, cess: g1.totals.cess }, outward, 'GSTR-1 totals = outward gst_lines');
    assert.equal(g1.totals.taxable, outwardTaxable, 'GSTR-1 taxable = outward taxable lines');

    const g3 = await e.call<G3b>('gst.gstr3b.summary', FY);
    const row = (k: string) => g3.supplies.find((s) => s.key === k)!;
    const liability = add(add(zero(), row('osup_det')), row('osup_zero'));
    assert.deepEqual(liability, outward, 'GSTR-3B 3.1(a) + 3.1(b) = Output ledgers');
    const d31 = row('isup_rev');
    assert.deepEqual({ igst: d31.igst, cgst: d31.cgst, sgst: d31.sgst, cess: d31.cess }, rcm, 'GSTR-3B 3.1(d) = RCM payable ledgers');
    assert.deepEqual({ ...g3.itc.net }, inward, 'GSTR-3B 4(C) = Input ledgers (blocked credit added in 4(A) and reversed in 4(B))');
    assert.deepEqual({ ...g3.itc.blocked }, { igst: 0, cgst: P(250), sgst: P(250), cess: 0 }, 's.17(5) food 10,000 × 5%');
    assert.equal(g3.inward.find((r) => r.ty === 'GST')!.intra, P(29_000), 'Table 5: composition supplier purchase');
    // Zero-rated: 3.1(b) taxable = exports 1,00,000 + 18,000 and SEZ 31,000 + 7,600 = 1,56,600; IGST 3,240 + 1,368.
    assert.equal(row('osup_zero').taxable, P(1_56_600));
    assert.equal(row('osup_zero').igst, P(4_608));

    // Sections: B2CL one invoice 1,20,000; exports and SEZ split by payment.
    const sec = (id: string) => g1.sections.find((s) => s.id === id)!;
    assert.equal(sec('b2cl').taxable, P(1_20_000));
    assert.equal(sec('exp_wop').taxable, P(1_00_000));
    assert.equal(sec('exp_wp').igst, P(3_240));
    assert.equal(sec('sez_wop').taxable, P(31_000));
    assert.equal(sec('sez_wp').igst, P(1_368));
    assert.equal(sec('b2cs').taxable, P(93_400), '11 cash sales × 7,800 + 7,600 walk-in credit sale');
    assert.equal(sec('cdnr').taxable, -P(24_400), 'credit notes 18,000 + 6,400 to registered customers');
  });

  it('GST: Σ of the twelve monthly returns = the year (GSTR-1, GSTR-3B) and GSTR-9 agrees', async () => {
    const y1 = await e.call<G1>('gst.gstr1.summary', FY);
    const y3 = await e.call<G3b>('gst.gstr3b.summary', FY);
    const m1 = zero();
    const m3 = zero();
    const mItc = zero();
    let m1Taxable = 0;
    for (const ym of FY_MONTHS) {
      const g1 = await e.call<G1>('gst.gstr1.summary', { period: periodKey(ym) });
      add(m1, g1.totals);
      m1Taxable += g1.totals.taxable;
      const g3 = await e.call<G3b>('gst.gstr3b.summary', { period: periodKey(ym) });
      add(m3, g3.supplies.find((s) => s.key === 'osup_det')!);
      add(m3, g3.supplies.find((s) => s.key === 'osup_zero')!);
      add(mItc, g3.itc.net);
    }
    assert.deepEqual(m1, { igst: y1.totals.igst, cgst: y1.totals.cgst, sgst: y1.totals.sgst, cess: y1.totals.cess });
    assert.equal(m1Taxable, y1.totals.taxable);
    const yLiab = add(add(zero(), y3.supplies.find((s) => s.key === 'osup_det')!), y3.supplies.find((s) => s.key === 'osup_zero')!);
    assert.deepEqual(m3, yLiab);
    assert.deepEqual(mItc, { ...y3.itc.net });

    const g9 = await e.call<{ table6: Array<Heads & { key: string }>; table9: Array<{ head: string; payable: number }>; months: unknown[] }>(
      'gst.gstr9.summary',
      { fy: '2026-27' },
    );
    assert.equal(g9.months.length, 12);
    const t6a = g9.table6.find((r) => r.key === '6A');
    assert.ok(t6a, 'GSTR-9 6A');
    const avail = zero();
    for (const r of y3.itc.available) add(avail, r);
    assert.deepEqual({ igst: t6a.igst, cgst: t6a.cgst, sgst: t6a.sgst, cess: t6a.cess }, avail, 'GSTR-9 6A = Σ 4(A)');
  });

  it('outstanding: every party = its ledger balance = the scenario’s own bill-by-bill expectation', async () => {
    const expected = new Map<string, number>();
    for (const [k, v] of Object.entries(w.bills)) {
      const party = k.split('|')[0];
      expected.set(party, (expected.get(party) ?? 0) + v);
    }
    for (const side of ['receivable', 'payable'] as const) {
      const ps = await e.call<{ rows: Array<{ ledgerId: number; ledgerName: string; pending: number; advance: number; onAccount: number; billsPending: number }>; totals: { pending: number } }>(
        'outstanding.partySummary',
        { side, asOf: FY_END, includeZero: true },
      );
      for (const r of ps.rows) {
        const key = Object.entries(w.L).find(([, id]) => id === r.ledgerId)![0];
        const ledgerClosing = closing(key);
        const sideSigned = side === 'receivable' ? ledgerClosing : -ledgerClosing;
        assert.equal(n0(r.pending), n0(sideSigned), `${r.ledgerName}: outstanding = ledger closing`);
        assert.equal(n0(r.billsPending + r.advance + r.onAccount), n0(r.pending), `${r.ledgerName}: bills + advance + on account = pending`);
        const exp = expected.get(key) ?? 0;
        assert.equal(n0(sideSigned), n0(side === 'receivable' ? exp : -exp), `${r.ledgerName}: scenario expectation`);
      }
      assert.equal(ps.totals.pending, sum(ps.rows, (r) => r.pending));
    }
    const blr = (await e.call<{ rows: Array<{ ledgerId: number; advance: number; onAccount: number; billsPending: number }> }>('outstanding.partySummary', {
      side: 'receivable',
      asOf: FY_END,
    })).rows.find((r) => r.ledgerId === w.L.blr)!;
    assert.equal(blr.advance, -P(50_000), 'advance received is in the customer’s favour (negative receivable)');
    assert.equal(blr.onAccount, -P(15_000), 'post-dated (now due) on-account cheque');
    assert.equal(blr.billsPending, -P(7_552), 'unadjusted credit note');
    assert.equal(w.bills[`blr|${ON_ACCOUNT}`], -P(15_000));
  });

  it('dashboard KPIs equal the reports', async () => {
    const d = await e.call<{
      sales: { ytd: number; period: number };
      purchases: { ytd: number };
      grossProfit: { amount: number; closingStock: number; openingStock: number };
      receivables: { total: number; advance: number; onAccount: number };
      payables: { total: number };
      cashBank: { cashTotal: number; bankTotal: number };
      gst: { period: string; outputTax: number; inputTax: number; reverseChargeTax: number };
    }>('dashboard.summary', { asOf: FY_END, ...FY });
    assert.equal(d.sales.ytd, pl.figures.sales);
    assert.equal(d.sales.period, pl.figures.sales);
    assert.equal(d.purchases.ytd, pl.figures.purchases);
    assert.equal(d.grossProfit.amount, pl.figures.grossProfit);
    assert.equal(d.grossProfit.closingStock, pl.figures.closingStock);
    assert.equal(d.grossProfit.openingStock, pl.figures.openingStock);
    const rec = await e.call<{ totals: { pending: number; advance: number; onAccount: number } }>('outstanding.partySummary', { side: 'receivable', asOf: FY_END });
    const pay = await e.call<{ totals: { pending: number } }>('outstanding.partySummary', { side: 'payable', asOf: FY_END });
    assert.equal(d.receivables.total, rec.totals.pending);
    assert.equal(d.receivables.advance, rec.totals.advance);
    assert.equal(d.receivables.onAccount, rec.totals.onAccount);
    assert.equal(d.payables.total, pay.totals.pending);
    assert.equal(d.cashBank.cashTotal, closing('CASH'));
    assert.equal(d.cashBank.bankTotal, closing('bank'));
    const mar = await e.call<G3b>('gst.gstr3b.summary', { period: '032027' });
    const tax = (h: Partial<Heads>): number => (h.igst ?? 0) + (h.cgst ?? 0) + (h.sgst ?? 0) + (h.cess ?? 0);
    assert.equal(d.gst.period, '032027');
    assert.equal(d.gst.outputTax, tax(mar.supplies.find((s) => s.key === 'osup_det')!) + tax(mar.supplies.find((s) => s.key === 'osup_zero')!));
    assert.equal(d.gst.inputTax, tax(mar.itc.net));
    assert.equal(d.gst.reverseChargeTax, tax(mar.supplies.find((s) => s.key === 'isup_rev')!));
  });

  it('cost centres add up to the ledgers they allocate', async () => {
    const cc = await e.call<{ rows: Array<{ kind: string; id: number; net: number }> }>('reports.costCentres', FY);
    const net = (id: number): number => cc.rows.find((r) => r.kind === 'centre' && r.id === id)!.net;
    // Mumbai: rent 11 × 18,000 + 19,000 + salaries 12 × 36,000 = 2,17,000 + 4,32,000
    assert.equal(net(w.CC.mumbai), P(2_17_000 + 4_32_000));
    // Pune: rent 11 × 12,000 + 13,000 + salaries 12 × 24,000 = 1,45,000 + 2,88,000
    assert.equal(net(w.CC.pune), P(1_45_000 + 2_88_000));
    assert.equal(net(w.CC.mumbai) + net(w.CC.pune), closing('rent') + closing('salaries'));
  });

  it('bank: statement imported, auto-matched, BRS balance as per bank = statement closing balance', async () => {
    assert.equal(bank.autoMatched, bank.lines - 1, 'every line but the bank charges matched automatically');
    assert.equal(bank.withoutCandidates, 1);
    const brs = await e.call<{
      balanceAsPerBooks: number;
      balanceAsPerBank: number;
      statementBalance: number;
      chequesIssuedNotPresented: number;
      chequesDepositedNotCleared: number;
      difference: number;
      unexplainedDifference: number;
    }>('banking.brs', { ledgerId: w.L.bank, asOf: '2026-06-30' });
    assert.equal(brs.statementBalance, bank.statementClosing);
    assert.equal(brs.balanceAsPerBank, bank.statementClosing, 'BRS: balance as per bank = statement closing balance');
    assert.equal(brs.chequesIssuedNotPresented, bank.notPresented, '2,00,000 to Mumbai Machines not yet presented');
    assert.equal(brs.chequesDepositedNotCleared, 0);
    assert.equal(brs.balanceAsPerBooks, bank.statementClosing - bank.notPresented);
    assert.equal(brs.difference, 0);
    assert.equal(brs.unexplainedDifference, 0);
    const ledger = await e.call<{ closing: number }>('accounts.ledger.balance', { ledgerId: w.L.bank, to: '2026-06-30' });
    assert.equal(ledger.closing, brs.balanceAsPerBooks, 'BRS books balance = bank ledger balance');
  });

  it('GSTR-2B import + reconciliation for July 2026', async () => {
    const bytes = await gstr2bJuly(w);
    const imp = await e.call<{ docCount: number }>('gstrecon.import', { source: 'gstr2b', fileName: 'GSTR2B_072026.json', bytes });
    assert.equal(imp.docCount, 4);
    const run = await e.call<{
      statuses: Array<{ status: string; count: number }>;
      booksItc: Heads & { taxable: number };
      itcNotBooked: { total: number };
      itcAtRisk: { total: number };
    }>('gstrecon.run', { period: '072026', source: 'gstr2b' });
    const count = (s: string): number => run.statuses.find((x) => x.status === s)!.count;
    assert.equal(count('matched'), 3, 'PW/4, DA-4 and the supplier credit note DRN-PW4');
    assert.equal(count('missing_in_books'), 1, 'PW/X9 was never booked');
    assert.equal(count('missing_in_portal'), 0);
    assert.equal(run.itcNotBooked.total, P(1_800), 'PW/X9: 900 + 900');
    assert.equal(run.itcAtRisk.total, 0);
    // Books ITC of July = July's Input-ledger movement: Pune C/S 6,092 − 216; Delhi I 23,820.
    assert.deepEqual(
      { igst: run.booksItc.igst, cgst: run.booksItc.cgst, sgst: run.booksItc.sgst },
      { igst: P(23_820), cgst: P(5_876), sgst: P(5_876) },
    );
    const july = await e.call<G3b>('gst.gstr3b.summary', { period: '072026' });
    assert.deepEqual({ igst: july.itc.net.igst, cgst: july.itc.net.cgst, sgst: july.itc.net.sgst }, { igst: P(23_820), cgst: P(5_876), sgst: P(5_876) });
  });

  it('optional, cancelled and post-dated vouchers stay out of the books until they should count', async () => {
    const pdc = await e.call<{ rows: Array<{ date: string }> }>('banking.pdc', { asOf: FY_END });
    assert.ok(pdc.rows.some((r) => r.date === '2027-04-10'), 'the April cheque is listed as a PDC');
    const g1 = await e.call<{ excluded: { optional: number; cancelled: number } }>('gst.gstr1.summary', FY);
    assert.deepEqual({ optional: g1.excluded.optional, cancelled: g1.excluded.cancelled }, { optional: 1, cancelled: 1 });
    // On 10-Apr-2027 the post-dated cheque falls due: Delhi becomes 10,000 − 5,428 = 4,572 Dr.
    e.clock.setToday('2027-04-10');
    try {
      const bal = await e.call<{ closing: number }>('accounts.ledger.balance', { ledgerId: w.L.delhi, to: '2027-04-10' });
      assert.equal(bal.closing, P(4_572));
      const tb2 = await e.call<Tb>('reports.trialBalance', { from: '2027-04-01', to: '2027-04-10' });
      assert.equal(tb2.balanced, true);
    } finally {
      e.clock.setToday(FY_END);
    }
  });

  it('data check passes and the edit log verifies, recording alters and deletes', async () => {
    const dv = await e.call<{ ok: boolean; checks: Array<{ name: string; ok: boolean; message: string }> }>('data.verify');
    assert.equal(dv.ok, true, JSON.stringify(dv.checks.filter((c) => !c.ok)));
    const av = await e.call<{ ok: boolean }>('security.audit.verify');
    assert.equal(av.ok, true, JSON.stringify(av));
    const deletes = await e.call<{ total: number }>('security.audit.list', { entityType: 'voucher', actions: ['delete'], limit: 50 });
    assert.equal(deletes.total, 2);
    const cancels = await e.call<{ total: number }>('security.audit.list', { entityType: 'voucher', actions: ['cancel'], limit: 50 });
    assert.equal(cancels.total, 1);
  });

  it('GSTR-1 and GSTR-3B JSON files carry exactly the summary figures, every month', async () => {
    const r2 = (x: number | undefined): number => Math.round((x ?? 0) * 100);
    for (const ym of FY_MONTHS) {
      const period = periodKey(ym);
      const s = await e.call<G1>('gst.gstr1.summary', { period });
      const f = await e.call<{ json: string | Record<string, any> }>('gst.gstr1.json', { period });
      const J: Record<string, any> = typeof f.json === 'string' ? JSON.parse(f.json) : f.json;
      const t = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
      const take = (it: any, sign = 1): void => {
        const d = it.itm_det ?? it;
        t.taxable += sign * r2(d.txval);
        t.igst += sign * r2(d.iamt);
        t.cgst += sign * r2(d.camt);
        t.sgst += sign * r2(d.samt);
      };
      for (const c of J.b2b ?? []) for (const i of c.inv) if (i.rchrg !== 'Y') for (const it of i.itms) take(it);
      for (const c of J.b2cl ?? []) for (const i of c.inv) for (const it of i.itms) take(it);
      for (const c of J.exp ?? []) for (const i of c.inv) for (const it of i.itms) take(it);
      for (const r of J.b2cs ?? []) take(r);
      for (const c of J.cdnr ?? []) for (const n of c.nt) for (const it of n.itms) take(it, n.ntty === 'C' ? -1 : 1);
      for (const n of J.cdnur ?? []) for (const it of n.itms) take(it, n.ntty === 'C' ? -1 : 1);
      assert.deepEqual(t, { taxable: s.totals.taxable, igst: s.totals.igst, cgst: s.totals.cgst, sgst: s.totals.sgst }, `GSTR-1 JSON ${period}`);

      const g = await e.call<{ json: string | Record<string, any> }>('gst.gstr3b.json', { period });
      const K: Record<string, any> = typeof g.json === 'string' ? JSON.parse(g.json) : g.json;
      const s3 = await e.call<G3b>('gst.gstr3b.summary', { period });
      const a = s3.supplies.find((x) => x.key === 'osup_det')!;
      const b = s3.supplies.find((x) => x.key === 'osup_zero')!;
      const od = K.sup_details.osup_det;
      const oz = K.sup_details.osup_zero;
      assert.deepEqual([r2(od.txval), r2(od.iamt), r2(od.camt), r2(od.samt)], [a.taxable, a.igst, a.cgst, a.sgst], `3B JSON 3.1(a) ${period}`);
      assert.deepEqual([r2(oz.txval), r2(oz.iamt)], [b.taxable, b.igst], `3B JSON 3.1(b) ${period}`);
      const net = K.itc_elg.itc_net;
      assert.deepEqual([r2(net.iamt), r2(net.camt), r2(net.samt)], [s3.itc.net.igst, s3.itc.net.cgst, s3.itc.net.sgst], `3B JSON 4(C) ${period}`);
    }
  });

  // ── Regressions of fixed audit findings (they were node:test `todo`s until the defects were fixed).

  it(
    'GSTR-3B carries the unused ITC of June into July (electronic credit ledger brought forward)',
    async () => {
      const jun = await e.call<G3b & { payment: { setOff: { creditBalance: Heads }; creditAvailable: Heads; cashTotal: number } }>('gst.gstr3b.summary', { period: '062026' });
      const jul = await e.call<G3b & { payment: { creditAvailable: Heads; cashTotal: number } }>('gst.gstr3b.summary', { period: '072026' });
      // June: capital goods ITC (C 45,000 + S 45,000) exceeds June's output tax → credit left after set-off.
      assert.ok(jun.payment.setOff.creditBalance.cgst > 0, 'June leaves CGST credit unused');
      for (const h of HEADS) {
        assert.equal(jul.payment.creditAvailable[h], Math.max(0, jul.itc.net[h]) + jun.payment.setOff.creditBalance[h], `July ${h}: 4(C) + June's closing credit`);
      }
      // The chain holds for every month of the year (April starts at the books beginning with nothing),
      // and GSTR-9 Table 9 and the dashboard use the same chained figures.
      type Pay = { payment: { broughtForward: Heads; setOff: { creditBalance: Heads }; rows: Array<{ head: keyof Heads; cash: number; rcmLiability: number }> } };
      let prev: Heads = zero();
      const cash = zero();
      const julyCash = { v: 0 };
      for (const ym of FY_MONTHS) {
        const m = await e.call<Pay>('gst.gstr3b.summary', { period: periodKey(ym) });
        assert.deepEqual({ ...m.payment.broughtForward }, prev, `${ym}: brought forward = previous month's closing credit`);
        prev = { ...m.payment.setOff.creditBalance };
        for (const r of m.payment.rows) cash[r.head] += r.cash + r.rcmLiability;
        if (periodKey(ym) === '072026') julyCash.v = m.payment.rows.reduce((t, r) => t + r.cash + r.rcmLiability, 0);
      }
      const g9 = await e.call<{ table9: Array<{ head: keyof Heads; paidCash: number }> }>('gst.gstr9.summary', { fy: '2026-27' });
      for (const r of g9.table9) assert.equal(r.paidCash, cash[r.head], `GSTR-9 table 9 ${r.head} paid in cash = Σ chained months`);
      e.clock.setToday('2026-07-31');
      try {
        const d = await e.call<{ gst: { period: string; netPayable: number } | null }>('dashboard.summary', { asOf: '2026-07-31', from: BOOKS_FROM, to: '2026-07-31' });
        assert.equal(d.gst?.period, '072026');
        assert.equal(d.gst?.netPayable, julyCash.v, 'dashboard GST card = July GSTR-3B cash (with June credit used)');
      } finally {
        e.clock.setToday(FY_END);
      }
    },
  );

  it(
    'GSTR-1 Table 13 reports only the deleted invoice as missing (the optional voucher is not an issued or cancelled invoice)',
    async () => {
      const g1 = await e.call<G1>('gst.gstr1.summary', FY);
      const sales = g1.docs.find((d) => d.docNum === 1)!;
      // Sales 1–45: one deleted (Nov cash sale), one cancelled (Dec), one optional (Dec, still a draft).
      assert.equal(sales.missing, 1, 'only the deleted number is missing');
      assert.equal(sales.cancelled, 2, 'cancelled = the cancelled invoice + the deleted number');
    },
  );

  it('backup → verify → restore as a new company → identical books', async () => {
    const bk = await e.call<{ path: string; encrypted: boolean }>('data.backup.create', { password: 'Backup#Pass1', note: 'Year end FY 2026-27' });
    assert.equal(bk.encrypted, true);
    const vr = await e.call<{ ok: boolean; counts: { vouchers: number } | null }>('data.backup.verify', { path: bk.path, password: 'Backup#Pass1' });
    assert.equal(vr.ok, true);
    const list = await e.call<{ total: number }>('vouchers.list', { from: '2000-01-01', to: '2099-12-31', limit: 1 });
    assert.equal(vr.counts?.vouchers, list.total);

    const origGst = await e.call<G3b>('gst.gstr3b.summary', FY);
    const origOut = await e.call<{ totals: { pending: number } }>('outstanding.partySummary', { side: 'receivable', asOf: FY_END });
    const origStock = await e.call<{ totals: { closingValue: number } }>('inventory.valuation', FY);

    const restored = await e.call<{ company: { id: string; name: string } }>('data.backup.restore', { path: bk.path, password: 'Backup#Pass1', mode: 'new' });
    assert.notEqual(restored.company.id, w.companyId);
    await e.call('app.company.close');
    const opened = await e.call<{ pendingLogin: unknown; session: unknown }>('app.company.open', { id: restored.company.id });
    if (!opened.session) await e.call('app.auth.login', { username: OWNER.username, password: OWNER.password });

    const rtb = await e.call<Tb>('reports.trialBalance', { ...FY, mode: 'ledgers' });
    assert.deepEqual(rtb.rows, tb.rows, 'restored trial balance = original');
    assert.deepEqual(rtb.totals, tb.totals);
    const rpl = await e.call<Pl>('reports.profitLoss', FY);
    assert.deepEqual(rpl.figures, pl.figures);
    const rbs = await e.call<Bs>('reports.balanceSheet', { asOf: FY_END });
    assert.equal(rbs.assetsTotal, bs.assetsTotal);
    assert.deepEqual((await e.call<G3b>('gst.gstr3b.summary', FY)).supplies, origGst.supplies);
    assert.equal((await e.call<{ totals: { pending: number } }>('outstanding.partySummary', { side: 'receivable', asOf: FY_END })).totals.pending, origOut.totals.pending);
    assert.equal((await e.call<{ totals: { closingValue: number } }>('inventory.valuation', FY)).totals.closingValue, origStock.totals.closingValue);
    const dv = await e.call<{ ok: boolean; checks: Array<{ ok: boolean }> }>('data.verify');
    assert.equal(dv.ok, true, JSON.stringify(dv.checks.filter((c) => !c.ok)));
    assert.equal((await e.call<{ ok: boolean }>('security.audit.verify')).ok, true);

    // Back to the original company for any later test.
    await e.call('app.company.close');
    const back = await e.call<{ session: unknown }>('app.company.open', { id: w.companyId });
    if (!back.session) await e.call('app.auth.login', { username: OWNER.username, password: OWNER.password });
  });
});

describe('audit findings reproduced on a fresh company (fixed; regression tests)', () => {
  let e: E2E;
  let w: World;
  before(async () => {
    e = startRuntime('2026-06-30');
    w = await createCompany(e);
    await createMasters(w);
  });
  after(async () => {
    await e?.close();
  });

  it(
    'a debit note to a customer for a price revision does not move stock again',
    async () => {
      const { L, I, VT } = w;
      const sale = await post(w, 'fx-sale', { voucherTypeId: VT.sales, date: '2026-04-11', mode: 'item_invoice', partyLedgerId: L.blr, items: [{ itemId: I.mixer, qty: 2, rate: 3000 }] });
      const before = await e.call<{ qty: number }>('inventory.stockOnHand', { itemId: I.mixer, asOf: '2026-06-30' });
      assert.equal(before.qty, 98, 'opening 100 − 2 sold');
      // Upward price revision of ₹100 per unit on the same 2 mixers (s.34 debit note): value only.
      await post(w, 'fx-dn', {
        voucherTypeId: VT.debit_note,
        date: '2026-04-20',
        mode: 'item_invoice',
        partyLedgerId: L.blr,
        items: [{ itemId: I.mixer, qty: 2, rate: 100 }],
        originalInvoiceNo: sale.number!,
        originalInvoiceDate: '2026-04-11',
        noteReason: 'Price revision',
      });
      const after = await e.call<{ qty: number }>('inventory.stockOnHand', { itemId: I.mixer, asOf: '2026-06-30' });
      assert.equal(after.qty, 98, 'the goods were delivered once, with the invoice');
      const pl = await e.call<Pl>('reports.profitLoss', { from: BOOKS_FROM, to: '2026-06-30' });
      const prof = await e.call<{ totals: { netSales: number } }>('stock.profitability', { from: BOOKS_FROM, to: '2026-06-30' });
      assert.equal(prof.totals.netSales, pl.figures.sales, 'item profitability sales = P&L sales (6,000 + 200)');
    },
  );

  it(
    'goods bought from an SEZ unit are posted like an import (IGST at customs), as GSTR-3B reports them',
    async () => {
      const { L, I, VT, G } = w;
      const sup = await e.call<{ id: number }>('accounts.ledger.save', {
        name: 'Pune SEZ Supplier',
        groupId: G.SUNDRY_CREDITORS,
        gstin: SEZ_SUPPLIER_GSTIN,
        registrationType: 'sez',
      });
      const v = await post(w, 'fx-sez-in', {
        voucherTypeId: VT.purchase,
        date: '2026-05-12',
        mode: 'item_invoice',
        partyLedgerId: sup.id,
        items: [{ itemId: I.mixer, qty: 2, rate: 2000 }],
        referenceNo: 'SZS-1',
      });
      const d = await e.call<{ entries: Array<{ ledgerId: number; amount: number }> }>('vouchers.get', { id: v.id });
      const g3 = await e.call<G3b>('gst.gstr3b.summary', { period: '052026' });
      assert.equal(g3.itc.available.find((r) => r.ty === 'IMPG')!.igst, P(720), 'GSTR-3B: 4,000 × 18% under 4(A)(1) import of goods');
      // Then the books must treat it as an import too: the SEZ supplier is owed the value only, and the IGST
      // is booked from the bill of entry (as for import of goods).
      assert.equal(d.entries.find((x) => x.ledgerId === sup.id)!.amount, -P(4_000), 'supplier credited with the value only');
      assert.equal(d.entries.find((x) => x.ledgerId === L.INPUT_IGST), undefined, 'no IGST posted from the supplier invoice');
    },
  );
});
