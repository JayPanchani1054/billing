/**
 * CROSS-FEATURE TIE-OUT with EVERY feature on (FY 2026-27, allFeatures.ts): GST regular with advances,
 * reverse charge, set-off + PMT-06 challans; TDS (194C / 194J(b) / 194I(b)) and TCS (206C(1) scrap) with
 * challans; a forex export invoice, realisation at another rate and period-end revaluation; manufacturing
 * journals from a BOM and job work out / in; POS split tender, returns and exchange credit; quotation →
 * invoice; recurring rent; cheque payments + bank statement + BRS; a scenario and a budget; an attachment;
 * and a composition dealer beside it (CMP-08 / GSTR-4).
 *
 * Every figure is read through runtime.dispatch (what the screens show) and tied to every other one:
 *   TB ↔ every ledger's own report ↔ cash / bank books ↔ BS ↔ P&L ↔ stock summary ↔ valuation;
 *   GST ledgers ↔ GSTR-1 ↔ GSTR-3B (months, chained credit) ↔ GSTR-9 ↔ ITC register ↔ electronic ledgers;
 *   TDS / TCS ledgers ↔ computation ↔ lines ↔ outstanding ↔ challans ↔ quarterly return data;
 *   party ledgers ↔ outstanding (INR and in the currency) ↔ the scenario's own bill-by-bill expectation;
 *   cheque register ↔ BRS; dashboard ↔ reports; POS day-end ↔ the books; production register ↔ stock;
 *   Tally XML export → import into an empty company; backup → restore.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readZip } from '../../lib/zip.ts';
import { makeGstin } from '../fixtures.ts';
import { FY_MONTHS, P, periodKey, startRuntime, sum, type E2E } from './harness.ts';
import {
  AF_BOOKS_FROM,
  AF_FY_END,
  AF_OWNER,
  bankStatementQ1,
  createAllFeaturesCompany,
  createAllFeaturesMasters,
  createCompositionCompany,
  planning,
  postAllFeaturesYear,
  postCompositionYear,
  type AfWorld,
  type CmpWorld,
} from './allFeatures.ts';

type Heads = { igst: number; cgst: number; sgst: number; cess: number };
const HEADS = ['igst', 'cgst', 'sgst', 'cess'] as const;
const zero = (): Heads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
const add = (a: Heads, b: Partial<Heads>, sign = 1): Heads => {
  for (const h of HEADS) a[h] += sign * (b[h] ?? 0);
  return a;
};
const heads = (h: Partial<Heads>): Heads => ({ igst: h.igst ?? 0, cgst: h.cgst ?? 0, sgst: h.sgst ?? 0, cess: h.cess ?? 0 });
const n0 = (x: number): number => (x === 0 ? 0 : x);
const nh = (h: Heads): Heads => ({ igst: n0(h.igst), cgst: n0(h.cgst), sgst: n0(h.sgst), cess: n0(h.cess) });

interface TbRow { key: string; kind: string; id: number | null; name: string; level: number; opening: number; debit: number; credit: number; closing: number }
interface Tb { rows: TbRow[]; totals: { opening: { debit: number; credit: number }; closing: { debit: number; credit: number } }; balanced: boolean; openingDifference: number; unbalancedBy: number; openingStock: number }
interface StatementLine { key: string; kind: string; id: number | null; name: string; level: number; amount: number }
interface Pl { figures: Record<string, number> }
interface Bs { liabilities: StatementLine[]; assets: StatementLine[]; liabilitiesTotal: number; assetsTotal: number; difference: number; balanced: boolean; closingStock: number; profitLoss: { openingBalance: number; currentPeriod: number; total: number } }
interface G3b {
  supplies: Array<Heads & { key: string; taxable: number }>;
  itc: { available: Array<Heads & { ty: string }>; net: Heads };
  payment: { broughtForward: Heads; creditAvailable: Heads; setOff: { creditBalance: Heads }; rows: Array<{ head: keyof Heads; cash: number; rcmLiability: number }> };
}
interface G1 { totals: Heads & { taxable: number }; sections: Array<Heads & { id: string; taxable: number; count: number }>; advances?: { received: unknown[]; adjusted: unknown[] } }
interface GstLine extends Heads { taxableValue: number; isReverseCharge: boolean; itcEligibility: string | null }
interface VDetail { id: number; voucherType: { baseType: string }; gstNature: string | null; gstLines: GstLine[] }

const FY = { from: AF_BOOKS_FROM, to: AF_FY_END };

describe('every feature on: a business year tied out across all modules', () => {
  let e: E2E;
  let w: AfWorld;
  let bank: { closing: number; notPresented: number; lines: number; autoMatched: number; manual: number };
  let tb: Tb;
  let tbGroups: Tb;
  let pl: Pl;
  let bs: Bs;
  const ledgerClasses = new Map<number, string[]>();
  const ledgerByName = new Map<string, number>();

  before(async () => {
    e = startRuntime(AF_FY_END);
    w = await createAllFeaturesCompany(e);
    await createAllFeaturesMasters(w);
    await postAllFeaturesYear(w);
    await planning(w);
    bank = await bankStatementQ1(w);
    tb = await e.call<Tb>('reports.trialBalance', { ...FY, mode: 'ledgers' });
    tbGroups = await e.call<Tb>('reports.trialBalance', { ...FY, mode: 'groups' });
    pl = await e.call<Pl>('reports.profitLoss', FY);
    bs = await e.call<Bs>('reports.balanceSheet', { asOf: AF_FY_END });
    const list = await e.call<{ rows: Array<{ id: number; name: string; classes: string[] }> }>('accounts.ledger.list', { limit: 10_000 });
    for (const r of list.rows) {
      ledgerClasses.set(r.id, r.classes);
      ledgerByName.set(r.name, r.id);
    }
  });
  after(async () => {
    await e?.close();
  });

  const closingOf = (id: number | undefined): number => (id === undefined ? 0 : (tb.rows.find((r) => r.key === `l:${id}`)?.closing ?? 0));
  const closing = (key: string): number => closingOf(w.L[key]);
  const named = (name: string): number => closingOf(ledgerByName.get(name));

  it('entered the year with no unexpected warnings', () => {
    assert.deepEqual(w.acknowledged, {}, 'no guard warnings had to be acknowledged');
    assert.ok(w.created >= 90, `created ${w.created}`);
  });

  it('trial balance: balanced, no opening difference, Σ closings = 0', () => {
    assert.equal(tb.balanced, true);
    assert.equal(tb.openingDifference, 0);
    assert.equal(tb.unbalancedBy, 0);
    assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
    assert.equal(tb.openingStock, P(1_00_000), 'steel 50,000 + paint 20,000 + cushions 30,000');
    assert.equal(sum(tb.rows, (r) => r.closing), 0);
    assert.equal(tbGroups.balanced, true);
  });

  it('hand-computed closing balances of key ledgers', () => {
    // Sales: Kolhapur 60,000 + 72,000; export 3,32,000; POS 4 days × (4,200 + 300 + 300 − 300 returned) = 18,000
    // + the credit POS bill 3,000.
    assert.equal(closing('SALES'), -P(4_85_000));
    assert.equal(closing('scrapSales'), -P(12_000), '8,000 + 5,000 − 1,000 returned');
    assert.equal(closing('installation'), -P(1_50_000));
    assert.equal(closing('PURCHASE'), P(1_46_000), 'steel 1,00,000 + paint 21,000 + late paint 25,000');
    assert.equal(closing('contract'), P(1_40_000), '1,00,000 + 50,000 − 10,000 debit note');
    assert.equal(closing('profFees'), P(1_00_000));
    assert.equal(closing('jobCharges'), P(6_000));
    assert.equal(closing('freight'), P(10_000), 'RCM tax is not a cost');
    assert.equal(closing('labour'), P(30_000), 'paid in cash; also capitalised into the chairs as an additional cost');
    // Cash: 1,00,000 − 30,000 labour + POS cash 4 × (1,956 + 354) + 1,000 (credit bill) = 80,240.
    assert.equal(closing('CASH'), P(80_240));
    // Debtors: Kolhapur paid both invoices; Surat's advance adjusted and balance paid; Bharat owes March scrap
    // less the return (5,959 − 1,192); the POS customer owes 2,540.
    assert.deepEqual([closing('kolhapur'), closing('surat'), closing('bharat'), closing('kavita')], [0, 0, P(4_767), P(2_540)]);
    // Creditors: Shinde's November bill 58,000 less the debit note 11,600 unpaid; everyone else settled.
    assert.deepEqual([closing('shinde'), closing('joshi'), closing('nagpur'), closing('ravi'), closing('gta'), closing('patil')], [-P(46_400), 0, 0, 0, 0, 0]);
    assert.equal(named('POS Exchange Credit'), 0);
  });

  it('every ledger’s own report (Ledger Vouchers) = its trial balance row', async () => {
    for (const r of tb.rows.filter((x) => x.kind === 'ledger' && x.id !== null)) {
      const lr = await e.call<{ opening: number; closing: number; totals: { debit: number; credit: number } }>('reports.ledger', { ledgerId: r.id, ...FY });
      assert.deepEqual(
        [lr.opening, lr.totals.debit, lr.totals.credit, lr.closing],
        [r.opening, r.debit, r.credit, r.closing],
        `${r.name}: ledger report = trial balance`,
      );
    }
  });

  it('cash and bank books = the cash / bank ledgers', async () => {
    const cb = await e.call<{ rows: TbRow[]; totals: { closing: number } }>('reports.cashBank', FY);
    const ledgers = cb.rows.filter((r) => r.kind === 'ledger');
    assert.ok(ledgers.some((r) => r.id === w.L.CASH) && ledgers.some((r) => r.id === w.L.bank));
    for (const r of ledgers) assert.equal(r.closing, closingOf(r.id ?? undefined), `${r.name}: cash/bank book = TB`);
    assert.equal(cb.totals.closing, sum(ledgers, (r) => r.closing));
    const cf = await e.call<{ opening: number; closing: number; totals: { net: number } }>('reports.cashFlow', FY);
    assert.equal(cf.closing, cb.totals.closing, 'cash flow closing = cash / bank books');
    assert.equal(cf.closing - cf.opening, cf.totals.net, 'cash flow: net movement = closing − opening');
  });

  it('profit & loss = trial balance; balance sheet balanced with the P&L profit and the closing stock', async () => {
    const f = pl.figures;
    let nominal = 0;
    for (const r of tb.rows) {
      if (r.kind !== 'ledger' || r.id === null) continue;
      const cls = ledgerClasses.get(r.id) ?? [];
      if (cls.includes('income') || cls.includes('expense')) nominal += r.closing;
    }
    assert.equal(f.netProfit, -nominal - f.openingStock + f.closingStock);
    assert.equal(bs.balanced, true);
    assert.equal(bs.difference, 0);
    assert.equal(bs.profitLoss.currentPeriod, f.netProfit, 'BS profit = P&L net profit');
    assert.equal(bs.closingStock, f.closingStock);
    for (const side of [bs.liabilities, bs.assets] as const) {
      for (const line of side.filter((l) => l.kind === 'group' && l.level === 0)) {
        const t = tbGroups.rows.find((r) => r.key === line.key);
        assert.ok(t, `TB has group ${line.name}`);
        let expected = (side === bs.assets ? 1 : -1) * t.closing;
        if (/current assets/i.test(line.name)) expected += bs.closingStock;
        assert.equal(line.amount, expected, `BS ${line.name} = TB`);
      }
    }
  });

  it('stock: stock summary = valuation = balance sheet closing stock; job worker’s stock is ours; quantities by hand', async () => {
    const ss = await e.call<{ totals: { closingValue: number }; rows: Array<{ kind: string; id: number; name: string; closing: { qty: number | null; value: number } }> }>('stock.summary', FY);
    const val = await e.call<{ totals: { closingValue: number }; rows: Array<{ itemId: number; closing: { qty: number; value: number } }> }>('inventory.valuation', FY);
    assert.equal(ss.totals.closingValue, bs.closingStock, 'stock summary = BS');
    assert.equal(val.totals.closingValue, bs.closingStock, 'valuation = BS');
    for (const r of ss.rows.filter((x) => x.kind === 'item')) {
      const v = val.rows.find((x) => x.itemId === r.id)!;
      assert.deepEqual([r.closing.qty, r.closing.value], [v.closing.qty, v.closing.value], `${r.name}: summary = valuation`);
    }
    const q = (k: string) => {
      const c = val.rows.find((r) => r.itemId === w.I[k])!.closing;
      return { qty: c.qty, value: c.value };
    };
    // Steel 1,000 + 2,000 − 1,000 − 500 (journals) − 150 (consumed at Ravi's) = 1,350 kg × 50 = 67,500.
    assert.deepEqual(q('steel'), { qty: 1350, value: P(67_500) });
    // Paint 100 + 100 + 100 (late bill) − 80 − 40 = 180 L at the average (20,000 + 21,000 + 25,000) / 300 = 220 = 39,600.
    assert.deepEqual(q('paint'), { qty: 180, value: P(39_600) });
    // Scrap 100 + 50 − 80 − 50 + 10 returned = 30 kg × 20 = 600.
    assert.deepEqual(q('scrap'), { qty: 30, value: P(600) });
    // Cushions 200 − 4 POS days × (4 + 1 − 1 returned + 1) = 180 × 150 = 27,000.
    assert.deepEqual(q('cushion'), { qty: 180, value: P(27_000) });
    // Chairs 200 + 30 + 100 − 50 − 100 − 60 − 4 × 2 (POS) − 2 (POS credit bill) = 110.
    assert.equal(q('chair').qty, 110);
    // Godown summary: Ravi's premises hold our 50 kg steel (in the closing stock); all godowns = the summary.
    const ravi = await e.call<{ rows: Array<{ kind: string; itemId: number | null; qty: number | null; value: number }>; totalValue: number }>('stock.godownSummary', { asOf: AF_FY_END, godownId: w.GD.ravi });
    assert.deepEqual(ravi.rows.filter((r) => r.kind === 'item').map((r) => [r.itemId, r.qty, r.value]), [[w.I.steel, 50, P(2_500)]]);
    const all = await e.call<{ totalValue: number }>('stock.godownSummary', { asOf: AF_FY_END });
    assert.equal(all.totalValue, bs.closingStock, 'godown summary = balance sheet closing stock');
    const jw = await e.call<{ rows: Array<{ itemName: string; pendingQty: number; pendingValue: number }> }>('mfg.jobWork.pending', { asOf: AF_FY_END, direction: 'out' });
    assert.deepEqual(jw.rows.map((r) => [r.itemName, r.pendingQty, r.pendingValue]), [['Steel Sheet', 50, P(2_500)]], '200 sent − 150 consumed');
    const itc04 = await e.call<{ sent: Array<{ qty: number; taxableValue: number }>; returned: Array<{ table: string; qty: number }> }>('mfg.itc04.report', { from: '2026-04-01', to: '2026-09-30', aatoAbove5Cr: true });
    assert.deepEqual(itc04.sent.map((r) => [r.qty, r.taxableValue]), [[200, P(10_000)]], 'ITC-04 table 4: 200 kg × 50');
    assert.deepEqual(itc04.returned.map((r) => [r.table, r.qty]), [['5A', 150]], 'ITC-04 5A: 150 kg came back as chairs');
  });

  it('manufacturing: the production register = the finished goods the stock engine valued', async () => {
    const reg = await e.call<{ rows: Array<{ class: string; qty: number; productValue: number; consumed: number; additional: number; byProducts: number }>; totals: { productValue: number; consumed: number; additional: number; byProducts: number } }>('mfg.production.register', FY);
    // Re-valued by the late paint bill (paint at 220): batch 1: 50,000 + 17,600 + 20,000 − 2,000 = 85,600;
    // batch 2: 25,000 + 8,800 + 10,000 − 1,000 = 42,800; Material In: 7,500 + 6,000 = 13,500.
    assert.deepEqual(
      reg.rows.map((r) => [r.class, r.qty, r.consumed, r.additional, r.byProducts, r.productValue]),
      [
        ['manufacturing', 200, P(67_600), P(20_000), P(2_000), P(85_600)],
        ['material_in', 30, P(7_500), P(6_000), 0, P(13_500)],
        ['manufacturing', 100, P(33_800), P(10_000), P(1_000), P(42_800)],
      ],
    );
    assert.equal(reg.totals.productValue, P(85_600 + 13_500 + 42_800));
    const items = await e.call<{ rows: Array<{ inward: { qty: number; value: number }; baseType: string }> }>('stock.itemVouchers', { itemId: w.I.chair, ...FY });
    const produced = items.rows.filter((r) => r.baseType === 'stock_journal' && r.inward.qty > 0);
    assert.equal(sum(produced, (r) => r.inward.value), reg.totals.productValue, 'stock item vouchers = production register');
    const scrap = await e.call<{ rows: Array<{ inward: { qty: number; value: number }; baseType: string }> }>('stock.itemVouchers', { itemId: w.I.scrap, ...FY });
    assert.equal(sum(scrap.rows.filter((r) => r.baseType === 'stock_journal'), (r) => r.inward.value), reg.totals.byProducts, 'scrap valued as the register says');
  });

  it('GST: output ledgers = GSTR-1 = GSTR-3B; March is still payable, earlier months set off', async () => {
    const docs = await e.call<{ rows: Array<{ id: number }> }>('vouchers.list', { ...FY, baseTypes: ['sales', 'purchase', 'credit_note', 'debit_note'], includeOptional: false, includeCancelled: false, limit: 1000 });
    const outward = zero();
    const inward = zero();
    const rcm = zero();
    for (const row of docs.rows) {
      const d = await e.call<VDetail>('vouchers.get', { id: row.id });
      const base = d.voucherType.baseType;
      const isOut = base === 'sales' || base === 'credit_note';
      const sign = base === 'credit_note' || base === 'debit_note' ? -1 : 1;
      for (const g of d.gstLines) {
        if (isOut) {
          if (!g.isReverseCharge) add(outward, g, sign);
        } else {
          if (g.itcEligibility !== 'ineligible') add(inward, g, sign);
          if (g.isReverseCharge) add(rcm, g, sign);
        }
      }
    }
    const y1 = await e.call<G1>('gst.gstr1.summary', FY);
    assert.deepEqual(heads(y1.totals), outward, 'GSTR-1 (year) = outward invoices');
    const y3 = await e.call<G3b>('gst.gstr3b.summary', FY);
    const row = (g: G3b, k: string) => g.supplies.find((s) => s.key === k)!;
    // Advances: 11A (May) − 11B (June) net to nil over the year, so 3.1(a)+(b) = the invoices.
    assert.deepEqual(add(add(zero(), row(y3, 'osup_det')), row(y3, 'osup_zero')), outward, 'GSTR-3B 3.1(a)+(b) (year) = outward invoices');
    assert.deepEqual(heads(row(y3, 'isup_rev')), rcm, 'GSTR-3B 3.1(d) = reverse-charge purchases');
    assert.deepEqual(nh({ ...y3.itc.net }), inward, 'GSTR-3B 4(C) = eligible inward tax');
    // Σ months = year.
    const m = zero();
    for (const ym of FY_MONTHS) {
      const g = await e.call<G3b>('gst.gstr3b.summary', { period: periodKey(ym) });
      add(add(m, row(g, 'osup_det')), row(g, 'osup_zero'));
    }
    assert.deepEqual(m, outward);
    // The Output ledgers: everything up to February was discharged by the set-off journals → only March remains.
    const mar = await e.call<G3b>('gst.gstr3b.summary', { period: '032027' });
    const marLiability = add(add(zero(), row(mar, 'osup_det')), row(mar, 'osup_zero'));
    const out = { igst: -closing('OUTPUT_IGST'), cgst: -closing('OUTPUT_CGST'), sgst: -closing('OUTPUT_SGST'), cess: -closing('OUTPUT_CESS') };
    assert.deepEqual(nh(out), marLiability, 'Output ledgers = March liability (Apr–Feb set off)');
    assert.equal(closing('RCM_CGST'), 0, 'RCM (Aug) paid in cash with the August set-off');
    assert.equal(closing('RCM_SGST'), 0);
    // Input ledgers = the credit GSTR-3B makes available in March (4(C) + credit brought forward), i.e. the
    // books' set-off journals used exactly the credit the 3B chain used.
    const input = { igst: closing('INPUT_IGST'), cgst: closing('INPUT_CGST'), sgst: closing('INPUT_SGST'), cess: closing('INPUT_CESS') };
    assert.deepEqual(nh(input), nh({ ...mar.payment.creditAvailable }), 'Input ledgers = March 3B credit available');
    // GST on Advances Received: the advance was fully adjusted.
    assert.equal(named('GST on Advances Received'), 0);
  });

  it('GST: electronic cash / credit ledgers = the books; the 3B chain’s cash = challans used by set-off; GSTR-9 6A = Σ 4(A); ITC register = credit ledger', async () => {
    const cash = await e.call<{ totals: { opening: number; deposited: number; utilised: number; closing: number }; booksBalance: number; rows: Array<{ head: keyof Heads; minor: string; utilised: number; deposited: number }> }>('gst.ledger.cash', FY);
    assert.equal(cash.booksBalance, named('GST Electronic Cash Ledger'), 'cash ledger books balance = ledger');
    assert.equal(cash.totals.closing, cash.booksBalance, 'electronic cash ledger = books');
    assert.equal(cash.totals.closing, 0, 'every challan was used by its set-off');
    const credit = await e.call<{ rows: Array<{ head: keyof Heads; opening: number; accrued: number; reversed: number; utilised: number; closing: number }> }>('gst.ledger.credit', FY);
    const inputKey: Record<keyof Heads, string> = { igst: 'INPUT_IGST', cgst: 'INPUT_CGST', sgst: 'INPUT_SGST', cess: 'INPUT_CESS' };
    for (const r of credit.rows) assert.equal(r.closing, closing(inputKey[r.head]), `credit ledger ${r.head} = Input ledger`);
    // Cash paid per the GSTR-3B chain for April–February = cash utilised by the set-off journals.
    const chainCash = zero();
    for (const ym of FY_MONTHS.slice(0, 11)) {
      const g = await e.call<G3b>('gst.gstr3b.summary', { period: periodKey(ym) });
      for (const r of g.payment.rows) chainCash[r.head] += r.cash + r.rcmLiability;
    }
    const used = zero();
    for (const r of cash.rows) used[r.head] += r.utilised;
    assert.deepEqual(used, chainCash, 'set-off cash = GSTR-3B 6.1 cash (Apr–Feb)');
    assert.equal(cash.totals.deposited, cash.totals.utilised);
    const y3 = await e.call<G3b>('gst.gstr3b.summary', FY);
    const g9 = await e.call<{ table4: Array<Heads & { key: string }>; table6: Array<Heads & { key: string }> }>('gst.gstr9.summary', { fy: '2026-27' });
    const avail = zero();
    for (const r of y3.itc.available) add(avail, r);
    assert.deepEqual(heads(g9.table6.find((r) => r.key === '6A')!), avail, 'GSTR-9 6A = Σ 4(A)');
    // GSTR-9 4N (outward + advances net + reverse charge) = GSTR-3B 3.1(a) + (b) + (d) for the year.
    const liab = zero();
    for (const k of ['osup_det', 'osup_zero', 'isup_rev']) add(liab, y3.supplies.find((x) => x.key === k)!);
    assert.deepEqual(heads(g9.table4.find((r) => r.key === '4N')!), liab, 'GSTR-9 4N = GSTR-3B 3.1(a)+(b)+(d)');
    // The Output tax ledgers in full: the year's liability (3.1(a) + (b); the advance's 11A and 11B net to nil)
    // less what the set-off journals discharged from them (credit utilised + cash utilised, less the cash that
    // paid the reverse charge, which is discharged from the RCM ledgers) = their closing balance.
    const tot = (h: Partial<Heads>): number => (h.igst ?? 0) + (h.cgst ?? 0) + (h.sgst ?? 0) + (h.cess ?? 0);
    const yearLiability = tot(y3.supplies.find((x) => x.key === 'osup_det')!) + tot(y3.supplies.find((x) => x.key === 'osup_zero')!);
    const rcmPaid = tot(y3.supplies.find((x) => x.key === 'isup_rev')!);
    const discharged = sum(credit.rows, (r) => r.utilised) + sum(cash.rows.filter((r) => r.minor === 'tax'), (r) => r.utilised) - rcmPaid;
    const outputClosing = -(closing('OUTPUT_IGST') + closing('OUTPUT_CGST') + closing('OUTPUT_SGST') + closing('OUTPUT_CESS'));
    assert.ok(rcmPaid > 0 && discharged > 0);
    assert.equal(yearLiability - discharged, outputClosing, 'Output ledgers = year liability − set-off (credit + cash)');
    const itc = await e.call<{ totals: { eligible: Heads } }>('gst.itc', FY);
    const accrued = zero();
    for (const r of credit.rows) accrued[r.head] += r.accrued - r.reversed;
    assert.deepEqual(heads(itc.totals.eligible), accrued, 'ITC register = credit ledger accrued − reversed');
    assert.deepEqual(heads(itc.totals.eligible), nh({ ...y3.itc.net }), 'ITC register = GSTR-3B 4(C)');
  });

  it('GST: advances in Table 11A (May) and 11B (June)', async () => {
    const may = await e.call<{ received: Array<{ taxable: number; igst: number }>; adjusted: unknown[] }>('gst.advances.register', { from: '2026-05-01', to: '2026-05-31' });
    assert.deepEqual(may.received.map((r) => [r.taxable, r.igst]), [[P(1_00_000), P(18_000)]]);
    const jun = await e.call<{ received: unknown[]; adjusted: Array<{ taxable: number; igst: number }> }>('gst.advances.register', { from: '2026-06-01', to: '2026-06-30' });
    assert.deepEqual(jun.adjusted.map((r) => [r.taxable, r.igst]), [[P(1_00_000), P(18_000)]]);
    const exp = (await e.call<G1>('gst.gstr1.summary', { period: '062026' })).sections.find((s) => s.id === 'exp_wop')!;
    assert.equal(exp.taxable, P(3_32_000), 'the USD export is reported in rupees');
  });

  it('GSTR-1 and GSTR-3B JSON files carry exactly the summary figures every month (exports in rupees, Table 11)', async () => {
    const r2 = (x: number | undefined): number => Math.round((x ?? 0) * 100);
    type J = Record<string, any>;
    for (const ym of FY_MONTHS) {
      const period = periodKey(ym);
      const s = await e.call<G1 & { advances?: { received: Array<Heads & { taxable: number }>; adjusted: Array<Heads & { taxable: number }> } }>('gst.gstr1.summary', { period });
      const f = await e.call<{ json: string | J }>('gst.gstr1.json', { period });
      const g: J = typeof f.json === 'string' ? JSON.parse(f.json) : f.json;
      const t = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
      const take = (it: J, sign = 1): void => {
        const d = it.itm_det ?? it;
        t.taxable += sign * r2(d.txval);
        t.igst += sign * r2(d.iamt);
        t.cgst += sign * r2(d.camt);
        t.sgst += sign * r2(d.samt);
      };
      for (const c of g.b2b ?? []) for (const i of c.inv) if (i.rchrg !== 'Y') for (const it of i.itms) take(it);
      for (const c of g.b2cl ?? []) for (const i of c.inv) for (const it of i.itms) take(it);
      for (const c of g.exp ?? []) for (const i of c.inv) for (const it of i.itms) take(it);
      for (const r of g.b2cs ?? []) take(r);
      for (const c of g.cdnr ?? []) for (const n of c.nt) for (const it of n.itms) take(it, n.ntty === 'C' ? -1 : 1);
      for (const n of g.cdnur ?? []) for (const it of n.itms) take(it, n.ntty === 'C' ? -1 : 1);
      // GSTR-1 totals carry the advances as 3B 3.1(a) does: + 11A (at) − 11B (txpd), value in ad_amt.
      for (const r of g.at ?? []) for (const it of r.itms) take({ ...it, txval: it.ad_amt });
      for (const r of g.txpd ?? []) for (const it of r.itms) take({ ...it, txval: it.ad_amt }, -1);
      assert.deepEqual(t, { taxable: s.totals.taxable, igst: s.totals.igst, cgst: s.totals.cgst, sgst: s.totals.sgst }, `GSTR-1 JSON ${period}`);
      const adv = (rows: J[] | undefined): number => sum((rows ?? []).flatMap((r: J) => r.itms as J[]), (it) => r2(it.iamt) + r2(it.camt) + r2(it.samt));
      const advSum = (rows: Array<Heads> | undefined): number => sum(rows ?? [], (r) => r.igst + r.cgst + r.sgst);
      assert.equal(adv(g.at), advSum(s.advances?.received), `11A JSON ${period}`);
      assert.equal(adv(g.txpd), advSum(s.advances?.adjusted), `11B JSON ${period}`);
      const k = await e.call<{ json: string | J }>('gst.gstr3b.json', { period });
      const K: J = typeof k.json === 'string' ? JSON.parse(k.json) : k.json;
      const s3 = await e.call<G3b>('gst.gstr3b.summary', { period });
      const a = s3.supplies.find((x) => x.key === 'osup_det')!;
      const od = K.sup_details.osup_det;
      assert.deepEqual([r2(od.txval), r2(od.iamt), r2(od.camt), r2(od.samt)], [a.taxable, a.igst, a.cgst, a.sgst], `3B JSON 3.1(a) ${period}`);
      const net = K.itc_elg.itc_net;
      assert.deepEqual([r2(net.iamt), r2(net.camt), r2(net.samt)], [s3.itc.net.igst, s3.itc.net.cgst, s3.itc.net.sgst], `3B JSON 4(C) ${period}`);
    }
    // May: the advance's tax is in 3.1(a) (11A); June: the invoice's 27,000 less the 18,000 adjusted (11B).
    const may = (await e.call<G3b>('gst.gstr3b.summary', { period: '052026' })).supplies.find((x) => x.key === 'osup_det')!;
    const jun = (await e.call<G3b>('gst.gstr3b.summary', { period: '062026' })).supplies.find((x) => x.key === 'osup_det')!;
    assert.ok(may.igst >= P(18_000));
    assert.equal(jun.igst, P(27_000 - 18_000));
  });

  it('TDS / TCS: ledgers = computation = lines = outstanding = challans = quarterly return data', async () => {
    // 194C: 2,000 + 1,000 − 200 reversed by the debit note (posted Dr to the duty ledger, a negative TDS line).
    const sections = { '194I(b)': P(72_000), '194C': P(2_800), '194J(b)': P(10_000) } as const;
    const comp = await e.call<{ rows: Array<{ section: string; deducted: number; deposited: number; balance: number }>; totals: { deducted: number; deposited: number; balance: number } }>('tds.computation', { ...FY, kind: 'tds' });
    const lines = { rows: await e.call<Array<{ section: string; amount: number }>>('tds.lines', { ...FY, kind: 'tds' }) };
    const out = await e.call<{ rows: Array<{ section: string; balance: number }>; totals: { balance: number } }>('tds.outstanding', { asOf: AF_FY_END, kind: 'tds' });
    for (const [section, deducted] of Object.entries(sections)) {
      const ledgerId = ledgerByName.get(`TDS Payable – ${section}`);
      assert.ok(ledgerId, `TDS Payable – ${section}`);
      const lr = await e.call<{ totals: { debit: number; credit: number }; closing: number }>('reports.ledger', { ledgerId, ...FY });
      const lineSum = sum(lines.rows.filter((r) => r.section === section), (r) => r.amount);
      const c = comp.rows.filter((r) => r.section === section);
      const reversed = section === '194C' ? P(200) : 0;
      assert.equal(lr.totals.credit - reversed, deducted, `${section}: deducted net of reversals (by hand)`);
      assert.equal(lineSum, deducted, `${section}: Σ TDS lines = ledger credits − reversals`);
      assert.equal(sum(c, (r) => r.deducted), deducted, `${section}: computation = ledger`);
      assert.equal(sum(c, (r) => r.deposited), lr.totals.debit - reversed, `${section}: deposited = ledger debits (challans)`);
      assert.equal(n0(sum(out.rows.filter((r) => r.section === section), (r) => r.balance)), n0(-lr.closing), `${section}: outstanding = ledger balance`);
    }
    assert.equal(out.totals.balance, P(6_000), 'March rent TDS is due by 30-Apr');
    // Quarterly statements (26Q): Σ deductee tax = Σ lines of the quarter; challans cover what was deposited.
    let returnTax = 0;
    let deposited = 0;
    for (const quarter of [1, 2, 3, 4] as const) {
      const d = await e.call<{ totals: { tax: number; deposited: number; challanTotal: number } }>('tds.return.data', { form: '26Q', fyStart: 2026, quarter });
      returnTax += d.totals.tax;
      deposited += d.totals.deposited;
    }
    assert.equal(returnTax, P(72_000 + 2_800 + 10_000), '26Q Q1–Q4 = the year’s deductions (the reversal netted into its bill)');
    assert.equal(deposited, comp.totals.deposited, '26Q deposited = computation deposited');
    const q4 = await e.call<{ deductees: Array<{ challanSr: number | null; section: string; tax: number; paymentDate: string }> }>('tds.return.data', { form: '26Q', fyStart: 2026, quarter: 4 });
    assert.deepEqual(
      q4.deductees.filter((d) => d.challanSr === null).map((d) => [d.section, d.tax, d.paymentDate]),
      [['194I(b)', P(6_000), '2027-03-01']],
      'only March rent awaits its challan',
    );
    // TCS (27EQ): 94 (Aug, deposited 7-Sep) + 59 − 12 reversed by the March credit note (payable).
    const tcsLedger = ledgerByName.get('TCS Payable');
    assert.ok(tcsLedger, 'TCS Payable');
    const tcsOut = await e.call<{ totals: { balance: number; deducted: number } }>('tds.outstanding', { asOf: AF_FY_END, kind: 'tcs' });
    assert.equal(closingOf(tcsLedger), -P(47));
    assert.equal(tcsOut.totals.balance, P(47));
    let tcs = 0;
    for (const quarter of [1, 2, 3, 4] as const) tcs += (await e.call<{ totals: { tax: number } }>('tds.return.data', { form: '27EQ', fyStart: 2026, quarter })).totals.tax;
    assert.equal(tcs, P(94 + 47));
    const challans = await e.call<{ rows: Array<{ tax: number; kind: string }> }>('tds.challans', FY);
    assert.equal(challans.rows.length, w.challans.tds);
  });

  it('outstanding: every party = its ledger = the scenario’s bills; forex outstanding = the ledger in rupees and dollars', async () => {
    const expected = new Map<string, number>();
    for (const [k, v] of Object.entries(w.bills)) expected.set(k.split('|')[0], (expected.get(k.split('|')[0]) ?? 0) + v);
    for (const side of ['receivable', 'payable'] as const) {
      const ps = await e.call<{ rows: Array<{ ledgerId: number; ledgerName: string; pending: number }>; totals: { pending: number } }>('outstanding.partySummary', { side, asOf: AF_FY_END, includeZero: true });
      for (const r of ps.rows) {
        const ledgerClosing = closingOf(r.ledgerId);
        assert.equal(n0(r.pending), n0(side === 'receivable' ? ledgerClosing : -ledgerClosing), `${r.ledgerName}: outstanding = ledger`);
        const key = Object.entries(w.L).find(([, id]) => id === r.ledgerId)?.[0];
        if (key && expected.has(key)) assert.equal(n0(ledgerClosing), n0(expected.get(key)!), `${r.ledgerName}: scenario expectation`);
      }
      assert.equal(ps.totals.pending, sum(ps.rows, (r) => r.pending));
      const bills = await e.call<{ totals: { pending: number } }>('outstanding.bills', { side, asOf: AF_FY_END });
      assert.equal(bills.totals.pending, ps.totals.pending, `${side}: bill-wise outstanding = party summary`);
    }
    // Atlantic: $1,500 at the closing rate ₹85 = 1,27,500 after revaluation.
    assert.equal(closing('atlantic'), P(1_27_500));
    const fx = await e.call<{ parties: Array<{ ledgerId: number; forexBalance: number; inrBalance: number; difference: number }> }>('forex.outstanding', { asOf: AF_FY_END });
    const at = fx.parties.find((p) => p.ledgerId === w.L.atlantic)!;
    assert.deepEqual([at.forexBalance, at.inrBalance, at.difference], [1500, P(1_27_500), 0]);
    const st = await e.call<{ closingForex?: number; closing?: number; rows: Array<{ inrBalance: number; forexBalance: number }> }>('forex.ledger', { ledgerId: w.L.atlantic, ...FY });
    const lastRow = st.rows[st.rows.length - 1];
    assert.deepEqual([lastRow.forexBalance, lastRow.inrBalance], [1500, P(1_27_500)], 'ledger in currency = books');
    // Forex Gain/Loss: realised 3,750 + unrealised 3,000 (credits).
    assert.equal(named('Forex Gain/Loss'), -P(6_750));
  });

  it('cheques and BRS: uncleared cheques in the register = cheques issued but not presented', async () => {
    assert.equal(bank.autoMatched + bank.manual, bank.lines, 'every statement line matched (two same-day ₹6,000 challans by hand)');
    assert.equal(bank.manual, 2);
    const brs = await e.call<{ balanceAsPerBooks: number; balanceAsPerBank: number; chequesIssuedNotPresented: number; difference: number; unexplainedDifference: number }>('banking.brs', { ledgerId: w.L.bank, asOf: '2026-06-30' });
    assert.equal(brs.balanceAsPerBank, bank.closing);
    assert.equal(brs.chequesIssuedNotPresented, bank.notPresented);
    assert.equal(bank.notPresented, P(1_16_000), 'the cheque to Shinde');
    assert.equal(brs.difference, 0);
    assert.equal(brs.unexplainedDifference, 0);
    const ledger = await e.call<{ closing: number }>('accounts.ledger.balance', { ledgerId: w.L.bank, to: '2026-06-30' });
    assert.equal(ledger.closing, brs.balanceAsPerBooks);
    const reg = await e.call<{ totals: { unclearedAmount: number; issued: number } }>('cheques.register', { bankLedgerId: w.L.bank, asOf: '2026-06-30' });
    assert.equal(reg.totals.unclearedAmount, brs.chequesIssuedNotPresented, 'cheque register uncleared = BRS not presented');
    // On 31-Mar: Apr–Jun rent cleared (BRS); Jan–Mar rent issued; Shinde's (May) and Jul–Dec rent are past
    // three months without a bank date → stale; Joshi's (Oct) too. 12 rent + Shinde + Joshi = 14 leaves used.
    const yearReg = await e.call<{ totals: { issued: number; cleared: number; stale: number; unused: number; leaves: number } }>('cheques.register', { bankLedgerId: w.L.bank, asOf: AF_FY_END });
    assert.deepEqual([yearReg.totals.cleared, yearReg.totals.issued, yearReg.totals.stale], [3, 3, 8]);
    assert.equal(yearReg.totals.leaves - yearReg.totals.unused, 14);
  });

  it('POS day-end summary = the POS vouchers in the books', async () => {
    const s = await e.call<{ bills: number; sales: number; returns: number; returnValue: number; net: number; exchangeIssued: number; exchangeUsed: number; byTender: Array<{ kind: string; net: number }> }>('pos.summary', FY);
    assert.deepEqual([s.bills, s.sales, s.returns, s.returnValue], [w.posBills.sales, w.posBills.salesValue, w.posBills.returns, w.posBills.returnValue]);
    assert.equal(s.exchangeIssued, s.exchangeUsed);
    assert.equal(named('POS Exchange Credit'), 0, 'all exchange credit used');
    assert.equal(sum(s.byTender.filter((t) => t.kind === 'upi'), (t) => t.net), P(4 * 3_000));
  });

  it('documents: quotation converted once, recurring rent posted for every month, budget and scenario', async () => {
    const ql = await e.call<{ rows: Array<{ status: string }> }>('documents.quotation.list', { baseType: 'quotation', ...FY });
    // The October quotation was valid until 20-Nov: on 31-Mar it has expired.
    assert.deepEqual(ql.rows.map((r) => r.status).sort(), ['converted', 'expired']);
    assert.equal(closing('rent'), P(7_20_000), '12 × 60,000');
    assert.equal(closing('patil'), 0, '12 × 54,000 paid by cheque');
    const v = await e.call<{ rows: Array<{ actual: number; budget: number }> }>('documents.budget.variance', { budgetId: w.budgetId, ...FY });
    assert.equal(sum(v.rows, (r) => r.actual), closing('rent') + closing('profFees'));
    const scen = await e.call<Tb>('reports.trialBalance', { ...FY, mode: 'ledgers', scenarioId: w.scenarioId });
    assert.equal(scen.balanced, true, 'scenario TB balances');
    const sales = (t: Tb) => t.rows.find((r) => r.key === `l:${w.L.SALES}`)!.closing;
    assert.equal(sales(scen) - sales(tb), -P(12_000), 'the optional sale (10 × 1,200) counts in the scenario only');
  });

  it('dashboard figures = the reports', async () => {
    const d = await e.call<{
      sales: { ytd: number };
      purchases: { ytd: number };
      grossProfit: { amount: number; closingStock: number };
      receivables: { total: number };
      payables: { total: number };
      cashBank: { cashTotal: number; bankTotal: number };
    }>('dashboard.summary', { asOf: AF_FY_END, ...FY });
    assert.equal(d.sales.ytd, pl.figures.sales);
    assert.equal(d.purchases.ytd, pl.figures.purchases);
    assert.equal(d.grossProfit.amount, pl.figures.grossProfit);
    assert.equal(d.grossProfit.closingStock, pl.figures.closingStock);
    const rec = await e.call<{ totals: { pending: number } }>('outstanding.partySummary', { side: 'receivable', asOf: AF_FY_END });
    const pay = await e.call<{ totals: { pending: number } }>('outstanding.partySummary', { side: 'payable', asOf: AF_FY_END });
    assert.equal(d.receivables.total, rec.totals.pending);
    assert.equal(d.payables.total, pay.totals.pending);
    assert.equal(d.cashBank.cashTotal, closing('CASH'));
    assert.equal(d.cashBank.bankTotal, closing('bank'));
    const g = await e.call<{ gst: { period: string; outputTax: number; inputTax: number } | null }>('dashboard.summary', { asOf: AF_FY_END, ...FY });
    const mar = await e.call<G3b>('gst.gstr3b.summary', { period: '032027' });
    const tax = (h: Partial<Heads>): number => (h.igst ?? 0) + (h.cgst ?? 0) + (h.sgst ?? 0) + (h.cess ?? 0);
    assert.equal(g.gst?.period, '032027');
    assert.equal(g.gst?.outputTax, tax(mar.supplies.find((x) => x.key === 'osup_det')!) + tax(mar.supplies.find((x) => x.key === 'osup_zero')!));
    assert.equal(g.gst?.inputTax, tax(mar.itc.net));
  });

  it('data check and the edit log verify; the attachment is stored', async () => {
    const dv = await e.call<{ ok: boolean; checks: Array<{ name: string; ok: boolean; message: string }> }>('data.verify');
    assert.equal(dv.ok, true, JSON.stringify(dv.checks.filter((c) => !c.ok)));
    assert.equal((await e.call<{ ok: boolean }>('security.audit.verify')).ok, true);
    const att = await e.call<Array<{ id: number; sha256: string }>>('attachments.list', { entityType: 'voucher', entityId: w.V['pur-nagpur'].id });
    assert.equal(att.length, 1);
  });

  it('Tally XML export → import into an empty company reproduces the trial balance, stock summary and GST totals', async () => {
    const file = await e.call<{ bytes: Uint8Array; vouchers: number; skipped: Array<{ reason: string; count: number }> }>('data.tally.export', { masters: true, vouchers: true, ...FY });
    const zip = readZip(file.bytes);
    const srcTb = await tbByName(e);
    const srcStock = await stockByName(e);
    const srcG1 = await e.call<G1>('gst.gstr1.summary', FY);
    const srcG3 = await e.call<G3b>('gst.gstr3b.summary', FY);
    // Month by month too: the advance (11A in May) and its adjustment (11B in June) must come back.
    const monthly = async (): Promise<unknown[]> => {
      const out: unknown[] = [];
      for (const ym of FY_MONTHS) {
        const g3 = await e.call<G3b>('gst.gstr3b.summary', { period: periodKey(ym) });
        const g1 = await e.call<G1>('gst.gstr1.summary', { period: periodKey(ym) });
        out.push({ ym, supplies: g3.supplies, itc: nh({ ...g3.itc.net }), g1: { ...heads(g1.totals), taxable: g1.totals.taxable }, advances: stripIds(g1.advances ?? null) });
      }
      return out;
    };
    const srcMonthly = await monthly();
    assert.deepEqual(file.skipped, [{ reason: 'Quotations and proforma invoices (Tally has no such voucher type)', count: 2 }]);
    await e.call('app.company.close');
    try {
      const st = await e.call<{ companies: Array<{ id: string; name: string }> }>('app.company.create', {
        name: 'Godavari Tally Copy',
        stateCode: '27',
        gstRegistrationType: 'regular',
        gstin: makeGstin('27', 'AAACG1001A'),
        booksFrom: AF_BOOKS_FROM,
        owner: { username: 'owner', displayName: 'Copy Owner', password: 'TallyCopy#2026' },
      });
      assert.ok(st.companies.some((c) => c.name === 'Godavari Tally Copy'));
      await e.call('company.features.save', { inventory: true, integrateInventory: true, billWise: true, multipleGodowns: true });
      for (const [fileName, options] of [
        ['1-Masters.xml', { masters: true, vouchers: false, onDuplicate: 'skip' }],
        ['2-Vouchers.xml', { masters: false, vouchers: true, onDuplicate: 'skip' }],
      ] as const) {
        const r = await e.call<{ issues: Array<{ severity: string; message: string }>; stopped: boolean }>('data.tally.import', { fileName, bytes: zip.read(fileName), options });
        assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), [], `${fileName}: no import errors`);
        assert.equal(r.stopped, false);
      }
      assert.deepEqual(await tbByName(e), srcTb, 'trial balance (by ledger name) reproduced');
      assert.deepEqual(await stockByName(e), srcStock, 'stock summary reproduced');
      const g1 = await e.call<G1>('gst.gstr1.summary', FY);
      assert.deepEqual(heads(g1.totals), heads(srcG1.totals), 'GSTR-1 totals reproduced');
      assert.equal(g1.totals.taxable, srcG1.totals.taxable);
      const g3 = await e.call<G3b>('gst.gstr3b.summary', FY);
      assert.deepEqual(g3.supplies, srcG3.supplies, 'GSTR-3B 3.1 reproduced');
      assert.deepEqual(nh({ ...g3.itc.net }), nh({ ...srcG3.itc.net }), 'GSTR-3B 4(C) reproduced');
      assert.deepEqual(await monthly(), srcMonthly, 'GSTR-1 / GSTR-3B of every month (incl. Table 11A / 11B) reproduced');
    } finally {
      await e.call('app.company.close');
      const back = await e.call<{ session: unknown }>('app.company.open', { id: w.companyId });
      if (!back.session) await e.call('app.auth.login', { username: AF_OWNER.username, password: AF_OWNER.password });
    }
  });

  it('backup → restore as a new company reproduces every report, the attachment and the derived registers', async () => {
    const snapshot = async (): Promise<Record<string, unknown>> => ({
      tb: (await e.call<Tb>('reports.trialBalance', { ...FY, mode: 'ledgers' })).rows,
      pl: (await e.call<Pl>('reports.profitLoss', FY)).figures,
      bs: (await e.call<Bs>('reports.balanceSheet', { asOf: AF_FY_END })).assetsTotal,
      stock: (await e.call<{ totals: unknown }>('stock.summary', FY)).totals,
      g3: (await e.call<G3b>('gst.gstr3b.summary', FY)).supplies,
      g3itc: (await e.call<G3b>('gst.gstr3b.summary', FY)).itc.net,
      g1: await (async () => {
        const g = await e.call<G1>('gst.gstr1.summary', FY);
        return { totals: g.totals, advances: g.advances ?? null };
      })(),
      itc: (await e.call<{ totals: unknown }>('gst.itc', FY)).totals,
      cash: (await e.call<{ totals: unknown }>('gst.ledger.cash', FY)).totals,
      credit: (await e.call<{ rows: unknown[] }>('gst.ledger.credit', FY)).rows,
      tds: (await e.call<{ totals: unknown }>('tds.outstanding', { asOf: AF_FY_END, kind: 'tds' })).totals,
      tcs: (await e.call<{ totals: unknown }>('tds.outstanding', { asOf: AF_FY_END, kind: 'tcs' })).totals,
      tdsComp: (await e.call<{ totals: unknown }>('tds.computation', { ...FY, kind: 'tds' })).totals,
      receivable: (await e.call<{ totals: unknown }>('outstanding.partySummary', { side: 'receivable', asOf: AF_FY_END })).totals,
      payable: (await e.call<{ totals: unknown }>('outstanding.partySummary', { side: 'payable', asOf: AF_FY_END })).totals,
      fx: (await e.call<{ parties: unknown[] }>('forex.outstanding', { asOf: AF_FY_END })).parties,
      brs: await e.call<unknown>('banking.brs', { ledgerId: w.L.bank, asOf: '2026-06-30' }),
      dashboard: withoutTimings(await e.call<unknown>('dashboard.summary', { asOf: AF_FY_END, ...FY })),
      pos: (await e.call<{ net: number }>('pos.summary', FY)).net,
      prod: (await e.call<{ totals: unknown }>('mfg.production.register', FY)).totals,
      cheques: (await e.call<{ totals: unknown }>('cheques.register', { bankLedgerId: w.L.bank, asOf: AF_FY_END })).totals,
      att: (await e.call<Array<{ sha256: string }>>('attachments.list', { entityType: 'voucher', entityId: w.V['pur-nagpur'].id })).map((a) => a.sha256),
    });
    const before = await snapshot();
    const bk = await e.call<{ path: string }>('data.backup.create', { password: 'Backup#Pass9', note: 'Year end' });
    const restored = await e.call<{ company: { id: string } }>('data.backup.restore', { path: bk.path, password: 'Backup#Pass9', mode: 'new' });
    await e.call('app.company.close');
    try {
      const opened = await e.call<{ session: unknown }>('app.company.open', { id: restored.company.id });
      if (!opened.session) await e.call('app.auth.login', { username: AF_OWNER.username, password: AF_OWNER.password });
      assert.deepEqual(await snapshot(), before, 'restored company = original');
      const dv = await e.call<{ ok: boolean; checks: Array<{ ok: boolean }> }>('data.verify');
      assert.equal(dv.ok, true, JSON.stringify(dv.checks.filter((c) => !c.ok)));
    } finally {
      await e.call('app.company.close');
      const back = await e.call<{ session: unknown }>('app.company.open', { id: w.companyId });
      if (!back.session) await e.call('app.auth.login', { username: AF_OWNER.username, password: AF_OWNER.password });
    }
  });
});

/** A payload without the ids / numbers that legitimately differ between two companies. */
function stripIds(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripIds);
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) if (!/^(id|voucherId|receiptVoucherId|ledgerId|partyLedgerId)$/.test(k)) out[k] = stripIds(v);
    return out;
  }
  return x;
}

/** A payload without its timing fields (elapsedMs / durationMs), which differ between two runs. */
function withoutTimings(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(withoutTimings);
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) if (k !== 'elapsedMs' && k !== 'durationMs') out[k] = withoutTimings(v);
    return out;
  }
  return x;
}

/** Trial balance as name → [opening, debit, credit, closing] (ids differ between companies). */
async function tbByName(e: E2E): Promise<Record<string, unknown>> {
  const t = await e.call<Tb>('reports.trialBalance', { ...FY, mode: 'ledgers' });
  const out: Record<string, unknown> = { balanced: t.balanced, openingStock: t.openingStock, totals: t.totals };
  for (const r of t.rows) out[`${r.kind}:${r.name}`] = [r.opening, r.debit, r.credit, r.closing];
  return out;
}
async function stockByName(e: E2E): Promise<Record<string, unknown>> {
  const s = await e.call<{ rows: Array<{ kind: string; name: string; closing: { qty: number | null; value: number } }>; totals: unknown }>('stock.summary', FY);
  const out: Record<string, unknown> = { totals: s.totals };
  for (const r of s.rows) if (r.kind === 'item') out[r.name] = [r.closing.qty, r.closing.value];
  return out;
}

describe('composition variant: CMP-08 / GSTR-4 / composition tax tie out with the books', () => {
  let e: E2E;
  let w: CmpWorld;
  before(async () => {
    e = startRuntime(AF_FY_END);
    w = await createCompositionCompany(e);
    await postCompositionYear(w);
  });
  after(async () => {
    await e?.close();
  });

  it('books balance; supplier tax is a cost; no Output / Input tax', async () => {
    const tb = await e.call<Tb>('reports.trialBalance', { ...FY, mode: 'ledgers' });
    assert.equal(tb.balanced, true);
    const c = (id: number | undefined) => (id === undefined ? 0 : (tb.rows.find((r) => r.key === `l:${id}`)?.closing ?? 0));
    assert.equal(c(w.L.PURCHASE), P(4 * 31_500), 'purchases at 31,500 incl. tax');
    for (const k of ['INPUT_CGST', 'INPUT_SGST', 'OUTPUT_CGST', 'OUTPUT_SGST']) assert.equal(c(w.L[k]), 0, k);
    assert.equal(c(w.L.SALES), -P(4 * 60_000));
  });

  it('P&L = trial balance; balance sheet balanced with that profit; stock summary = valuation = closing stock', async () => {
    const tb = await e.call<Tb>('reports.trialBalance', { ...FY, mode: 'ledgers' });
    const pl = await e.call<Pl>('reports.profitLoss', FY);
    const bs = await e.call<Bs>('reports.balanceSheet', { asOf: AF_FY_END });
    const list = await e.call<{ rows: Array<{ id: number; classes: string[] }> }>('accounts.ledger.list', { limit: 10_000 });
    const nominal = new Set(list.rows.filter((r) => r.classes.includes('income') || r.classes.includes('expense')).map((r) => r.id));
    const net = sum(tb.rows.filter((r) => r.kind === 'ledger' && r.id !== null && nominal.has(r.id)), (r) => r.closing);
    assert.equal(pl.figures.netProfit, -net - pl.figures.openingStock + pl.figures.closingStock);
    assert.deepEqual([bs.balanced, bs.difference, bs.profitLoss.currentPeriod, bs.closingStock], [true, 0, pl.figures.netProfit, pl.figures.closingStock]);
    const ss = await e.call<{ totals: { closingValue: number } }>('stock.summary', FY);
    const val = await e.call<{ totals: { closingValue: number }; rows: Array<{ itemId: number; closing: { qty: number; value: number } }> }>('inventory.valuation', FY);
    assert.equal(ss.totals.closingValue, bs.closingStock);
    assert.equal(val.totals.closingValue, bs.closingStock);
    // Khoya 4 × (100 − 90) = 40 kg at 315 (300 + the supplier's 5% tax, a cost) = 12,600; pedha 12 × (40 − 40) = 0.
    const khoya = val.rows.find((r) => r.itemId === w.I.khoya)!.closing;
    assert.deepEqual([khoya.qty, khoya.value], [40, P(12_600)]);
  });

  it('CMP-08 per quarter = 1% of turnover; composition tax ledger = Σ set off; electronic cash ledger = books; GSTR-4 = CMP-08', async () => {
    let payable = 0;
    for (const q of [1, 2, 3, 4]) {
      const s = await e.call<{ turnover: { total: number }; table3: Array<{ key?: string; cgst: number; sgst: number; igst: number }> }>('gst.cmp08.summary', { period: `2026-27-Q${q}` });
      assert.equal(s.turnover.total, w.turnover[`Q${q}`]);
      const t1 = s.table3[0];
      assert.deepEqual([t1.cgst, t1.sgst], [P(300), P(300)], `Q${q}: 1% of 60,000 = 600`);
      payable += t1.cgst + t1.sgst;
    }
    const list = await e.call<{ rows: Array<{ id: number; name: string }> }>('accounts.ledger.list', { search: 'Composition Tax', limit: 10 });
    const ct = list.rows.find((r) => r.name === 'Composition Tax (GST)');
    assert.ok(ct, 'Composition Tax (GST) ledger');
    const ctr = await e.call<{ closing: number }>('reports.ledger', { ledgerId: ct.id, ...FY });
    assert.equal(ctr.closing, P(1_800), 'Q1–Q3 set off: 3 × 600');
    const cash = await e.call<{ totals: { deposited: number; utilised: number; closing: number }; booksBalance: number }>('gst.ledger.cash', FY);
    assert.deepEqual([cash.totals.deposited, cash.totals.utilised, cash.totals.closing, cash.booksBalance], [P(1_800), P(1_800), 0, 0]);
    const g4 = await e.call<{ table5: Array<{ cgst: number; sgst: number }>; table8: { payable: Heads; paid: number }; table4Totals: Record<string, Heads & { taxable: number }> }>('gst.gstr4.summary', { fy: '2026-27' });
    assert.equal(sum(g4.table5, (r) => r.cgst + r.sgst), payable, 'GSTR-4 table 5 = Σ CMP-08');
    assert.equal(g4.table8.payable.cgst + g4.table8.payable.sgst, P(2_400));
    assert.equal(g4.table8.paid, P(1_800), 'paid = cash utilised by the set-off journals');
    assert.deepEqual(
      [g4.table4Totals['4A'].taxable, g4.table4Totals['4A'].cgst, g4.table4Totals['4A'].sgst],
      [P(1_20_000), P(3_000), P(3_000)],
      'GSTR-4 4A: 4 × (30,000 + C 750 + S 750) from the registered dairy',
    );
  });
});

