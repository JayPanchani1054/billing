/**
 * The GST returns' graphs, figures and stats (SPEC-21 §5 "GST returns", §4.8): every drawn total equals
 * the table total it summarises — on the core's own computations where the core can produce them
 * (GSTR-3B, GSTR-9 from the April test dataset) and on consistent fixtures otherwise; the null gates;
 * the takeaways; no stat repeats a visible total (D24); the due date agrees with the core's rule.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { CashLedgerTxn, CreditLedgerTxn, ElectronicCashLedger, ElectronicCreditLedger, GstSetoffResult } from '../../../../shared/types/gst-plus.ts';
import type { GstIssue, Gstr3bSummary, Gstr9MonthRow, Gstr9Summary, TaxHead } from '../../../../shared/types/gst-returns.ts';
import { loadCompany } from '../../../../core/modules/gst/docs.ts';
import { computeGstr1, gstr1Summary } from '../../../../core/modules/gst/gstr1.ts';
import { computeGstr3b } from '../../../../core/modules/gst/gstr3b.ts';
import { computeGstr9 } from '../../../../core/modules/gst/gstr9.ts';
import { electronicCreditLedger } from '../../../../core/modules/gst/eledgers.ts';
import { resolvePeriod } from '../../../../core/modules/gst/period.ts';
import { aprilDataset, insertDoc } from '../../../../core/modules/gst/testkit.ts';
import type { Dataset } from '../../../../core/modules/gst/testkit.ts';
import { gstDueDate, QRMP_22ND_STATES } from '../../../../core/modules/dashboard/summary.ts';
import { assertSpec, drawnTotal, inlineBars, markColor, specProblems, statRepeatsTotal, TAKEAWAY_MAX } from '../../../ui/lib/chartSpec.ts';
import { statTotalAllowed } from '../../../app/lib/chartCatalogue.ts';
import { buildTiles, gstr1Rows } from './gstr1.ts';
import { paymentSections } from './gstr3b.ts';
import { sumTax } from './reports.ts';
import {
  afterCredit,
  cashLedgerChart,
  creditClosing,
  creditLedgerChart,
  dueCaption,
  dueStateCode,
  gstr1Chart,
  gstr1Excluded,
  gstr1Stat,
  gstr1Total,
  gstr3bMeter,
  gstr3bPaid,
  gstr9Chart,
  returnDue,
  setoffCovered,
  setoffMeter,
  setoffStat,
} from './returnCharts.ts';

const tax = (igst: number, cgst: number, sgst: number, cess = 0) => ({ igst, cgst, sgst, cess });

// ───────────────────────────── GSTR-1 ─────────────────────────────

function issue(severity: GstIssue['severity'], voucherId: number | null): GstIssue {
  return { code: 'hsn_missing', severity, voucherId, voucherNumber: null, voucherTypeName: null, date: null, partyName: null, section: 'b2b', message: 'm', fix: 'f' };
}

describe('GSTR-1 — the stat answers "can I file?"', () => {
  test('nothing blocking; warnings are the link', () => {
    assert.deepEqual(gstr1Stat([]), { text: 'Nothing blocking', tone: null, link: null });
    assert.deepEqual(gstr1Stat([issue('warning', 1), issue('warning', 2), issue('warning', 2)]), { text: 'Nothing blocking', tone: null, link: '3 warnings' });
    assert.deepEqual(gstr1Stat([issue('warning', 1)]).link, '1 warning');
  });

  test('errors block the JSON — counted as documents, or as problems with a period-level error', () => {
    assert.deepEqual(gstr1Stat([issue('error', 7), issue('error', 7), issue('error', 9), issue('warning', 3)]), { text: '2 documents block the JSON', tone: 'danger', link: 'Review' });
    assert.equal(gstr1Stat([issue('error', 7)]).text, '1 document blocks the JSON');
    assert.equal(gstr1Stat([issue('error', 7), issue('error', null)]).text, '2 problems block the JSON');
    assert.equal(gstr1Stat([issue('error', null)]).text, '1 problem blocks the JSON');
  });

  test('the Total row is the return net (all heads in its tooltip); the excluded documents in words', () => {
    const totals = { taxable: 7410300, igst: 0, cgst: 666720, sgst: 666720, cess: 1000 };
    const t = gstr1Total({ totals }, [{ taxable: 7410300, tax: 1334440 }]);
    assert.deepEqual([t.label, t.taxable, t.tax, t.note], ['Total', 7410300, 1334440, null]);
    assert.match(t.split, /^IGST ₹0 · CGST ₹6\.7 K · SGST ₹6\.7 K · Cess ₹10$/);
    const off = gstr1Total({ totals }, [{ taxable: 7410300, tax: 1334440 }, { taxable: 100000, tax: 5000 }]);
    assert.equal(off.label, 'Net total', 'a total that does not foot with the rows is never called "Total"');
    assert.match(off.note ?? '', /4B/);
    assert.equal(gstr1Excluded({ excluded: { optional: 0, cancelled: 0, notGst: 0 } }), '');
    assert.equal(gstr1Excluded({ excluded: { optional: 2, cancelled: 1, notGst: 3 } }), '2 optional · 1 cancelled · 3 without GST');
  });

  test('the stat never repeats a figure (it is words, not a total)', () => {
    assert.equal(statTotalAllowed('gst.gstr1'), false);
    for (const s of [gstr1Stat([]), gstr1Stat([issue('error', 1)])]) assert.doesNotMatch(s.text, /₹/);
  });
});

describe('GSTR-1 Total row on the core\'s own computation', () => {
  let ds: Dataset;
  after(() => ds.t.close());

  test('April (4B reverse charge and 8 exempt present): "Net total" = Σ supply rows − 4B − 8, as GSTR-3B 3.1(a)/(b)', () => {
    ds = aprilDataset();
    const summary = gstr1Summary(computeGstr1(ds.t.db, loadCompany(ds.t.db), resolvePeriod({ period: '042026' }), ds.t.today));
    const rows = gstr1Rows(buildTiles(summary), false);
    const t = gstr1Total(summary, rows.supply);
    const shown = new Set(rows.supply.map((r) => r.id));
    assert.ok(shown.has('4B') && shown.has('8'), 'the April dataset reports 4B and 8');
    assert.equal(t.label, 'Net total');
    const net = rows.supply.filter((r) => r.id !== '4B' && r.id !== '8');
    assert.equal(t.taxable, net.reduce((a, r) => a + r.taxable, 0));
    assert.equal(t.tax, net.reduce((a, r) => a + r.tax, 0));
  });

  test('a period of plain B2B and B2C sales: the row reads "Total" and foots with the rows above it', () => {
    const { t: kit, P } = ds;
    insertDoc(kit, { type: 'sales', number: 'MY-1', date: '2026-05-05', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '7208', uqc: 'KGS', qty: 2, rate: 18, taxable: 100000, cgst: 9000, sgst: 9000 }] });
    insertDoc(kit, { type: 'sales', number: 'MY-2', date: '2026-05-06', party: P.cash, nature: 'b2cs', pos: '27', lines: [{ hsn: '7208', uqc: 'KGS', qty: 1, rate: 18, taxable: 50000, cgst: 4500, sgst: 4500 }] });
    const summary = gstr1Summary(computeGstr1(kit.db, loadCompany(kit.db), resolvePeriod({ period: '052026' }), kit.today));
    const rows = gstr1Rows(buildTiles(summary), false);
    assert.deepEqual(rows.supply.map((r) => r.id), ['4A', '7']);
    const t = gstr1Total(summary, rows.supply);
    assert.deepEqual([t.label, t.taxable, t.tax, t.note], ['Total', 150000, 27000, null]);
    // 2.1.2: the inline bars add up to the Total row it shows.
    const spec = gstr1Chart(rows.supply);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.total, t.taxable);
    assert.equal(inlineBars(spec, rows.supply.length), true);
  });

  test('2.1.2 — April: the bars are the supply rows as listed (4A … 11), table-only up to 20; Σ = Σ rows; the check tables 12 and 13 carry none', () => {
    const summary = gstr1Summary(computeGstr1(ds.t.db, loadCompany(ds.t.db), resolvePeriod({ period: '042026' }), ds.t.today));
    const rows = gstr1Rows(buildTiles(summary), false);
    // The April dataset reports every kind of supply: more than 7 tables — still drawn in the table (the
    // owner's complaint: a normal return lists 8+ tables and saw no graph), never as a strip.
    assert.ok(rows.supply.length > 7 && rows.supply.length <= 20, `${rows.supply.length} supply tables`);
    const spec = gstr1Chart(rows.supply);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    assert.equal(spec.inlineOnly, true);
    assert.deepEqual(spec.categories, rows.supply.map((r) => r.title));
    assert.equal(spec.total, rows.supply.reduce((a, r) => a + r.taxable, 0));
    assert.equal(inlineBars(spec, rows.supply.length), true, 'inline in the table');
    assert.ok(!spec.categories.includes('HSN summary') && !spec.categories.includes('Documents issued'));
    // More › Show empty tables lists every table: still within 20 rows, still in the table.
    const all = gstr1Rows(buildTiles(summary), true).supply;
    assert.ok(all.length <= 20, `${all.length} tables with the empty ones`);
    assert.equal(inlineBars(gstr1Chart(all), all.length), true);
  });
});

describe('GSTR-1 graph (2.1.2): taxable value by table, inline in the table only', () => {
  const rows = [
    { title: 'B2B invoices', taxable: 4_00_000_00 },
    { title: 'B2C others', taxable: 50_000_00 },
    { title: 'Credit / debit notes', taxable: -20_000_00 },
  ];

  test('graph total = Σ the rows\' Taxable value; a table that reduces it is slot 2, said "less" in words', () => {
    const spec = gstr1Chart(rows);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.total, 4_30_000_00);
    assert.equal(drawnTotal(spec), spec.total);
    assert.equal(markColor(spec, 2), 2);
    assert.equal(markColor(spec, 0), 1);
    // 4,00,000 of 4,50,000 positive = 88.9 % → 89 %.
    assert.equal(spec.takeaway, 'B2B invoices: 89 % of the taxable value · Credit / debit notes: less ₹20.0 K');
    const f = spec.valueFormat;
    assert.ok(f && typeof f === 'object');
    assert.equal(f.tick(-20_000_00), 'less ₹20.0 K');
    assert.equal(f.full(-20_000_00), 'less ₹ 20,000.00');
    assert.ok(spec.takeaway.length <= TAKEAWAY_MAX);
  });

  test('table-only (inlineOnly): up to 20 supply rows draw in the table; 9 supply tables draw inline; more than 20 → no graph, never a strip', () => {
    assert.equal(inlineBars(gstr1Chart(rows), rows.length), true);
    const tables = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `T${i}`, taxable: (i % 4 === 3 ? -1 : 1) * (i + 1) * 1000 }));
    const nine = gstr1Chart(tables(9));
    assert.ok(nine);
    assert.deepEqual(specProblems(nine), [], 'a 9-row table-only bar is valid (the strip cap of 10 does not apply; tips only ≤ 7)');
    assert.equal(nine.inlineOnly, true);
    assert.equal(nine.label, 'none');
    assert.equal(nine.total, tables(9).reduce((a, r) => a + r.taxable, 0));
    assert.equal(inlineBars(nine, 9), true, '9 supply tables: bars in the Taxable value cells');
    const twenty = gstr1Chart(tables(20));
    assert.ok(twenty);
    assert.deepEqual(specProblems(twenty), []);
    assert.equal(inlineBars(twenty, 20), true);
    assert.equal(gstr1Chart(tables(21)), null, '> 20 rows: no graph');
  });

  test('gates: one table with a value is a sentence (2.1.1 D2); nothing → none', () => {
    assert.equal(gstr1Chart([]), null);
    assert.equal(gstr1Chart([{ title: 'B2B invoices', taxable: 1000 }, { title: 'Nil, exempt, non-GST', taxable: 0 }]), null);
  });

  test('20 rows of any size stay well under 50 ms (the builder never draws more than 20)', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, taxable: (i - 2) * 10_000 }));
    let ms = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      for (let j = 0; j < 1000; j++) gstr1Chart(twenty);
      ms = Math.min(ms, performance.now() - t0);
    }
    assert.ok(ms < 50, `1,000 builds: ${ms.toFixed(1)} ms`);
  });
});

// ───────────────────────────── GSTR-3B (core computation) ─────────────────────────────

describe('GSTR-3B — figure, due date and the meter (April dataset, core gstr3b)', () => {
  let ds: Dataset;
  let s: Gstr3bSummary;
  before(() => {
    ds = aprilDataset();
    // A purchase in the month brings input credit, so the tax is paid partly from credit and partly in cash.
    insertDoc(ds.t, {
      type: 'purchase',
      number: 'PX-1',
      date: '2026-04-20',
      party: ds.P.steel,
      nature: 'inward_b2b',
      refNo: 'SS/900',
      refDate: '2026-04-20',
      lines: [{ hsn: '72081000', uqc: 'KGS', qty: 10, rate: 18, taxable: 100000, cgst: 9000, sgst: 9000 }],
    });
    s = computeGstr3b(ds.t.db, loadCompany(ds.t.db), resolvePeriod({ period: '042026' }), ds.t.today);
  });
  after(() => ds.t.close());

  test('credit + cash = the 6.1 "Tax payable" column (A + B); cash also equals the cash column', () => {
    const p = gstr3bPaid(s);
    const sections = paymentSections(s.payment);
    const payableColumn = sections.flatMap((x) => x.lines).reduce((a, l) => a + l.payable, 0);
    const cashColumn = sections.flatMap((x) => x.lines).reduce((a, l) => a + l.cash, 0);
    assert.equal(p.payable, payableColumn);
    assert.equal(p.fromCredit + p.inCash, payableColumn);
    assert.equal(p.inCash, cashColumn);
    assert.equal(p.fromCredit, sumTax(s.payment.itcUsed), 'credit used per head (6.1) = itcUsed');
  });

  test('the meter: drawn total = tax payable; takeaway names both parts', () => {
    const spec = gstr3bMeter(s);
    assert.ok(spec, 'credit and cash both pay part of April');
    assertSpec(spec);
    assert.equal(spec.kind, 'meter');
    assert.equal(drawnTotal(spec), gstr3bPaid(s).payable);
    assert.equal(spec.series[0].values[0], gstr3bPaid(s).fromCredit);
    assert.match(spec.takeaway, /^From credit ₹[\d.]+ [KLC]?r?\s?· In cash ₹/);
    assert.ok(spec.takeaway.length <= TAKEAWAY_MAX);
  });

  test('no meter unless both parts are above 0 (the seeded shop pays all in cash: the figure is the answer)', () => {
    const noCredit = { payment: { ...s.payment, rows: s.payment.rows.map((r) => ({ ...r, paidIgst: 0, paidCgst: 0, paidSgst: 0, paidCess: 0, cash: r.liability })) } };
    assert.equal(gstr3bMeter(noCredit), null);
    const noCash = { payment: { ...s.payment, rows: s.payment.rows.map((r) => ({ ...r, cash: 0, rcmLiability: 0, paidIgst: r.liability, paidCgst: 0, paidSgst: 0, paidCess: 0 })) } };
    assert.equal(gstr3bMeter(noCash), null);
  });

  test('the figure is table 6.1\'s cash total — allow-listed (it sits at the bottom of the form)', () => {
    assert.equal(statTotalAllowed('gst.gstr3b'), true);
  });
});

describe('GSTR-3B due date — the Home dashboard\'s rule (core gstDueDate)', () => {
  test('monthly: the 20th; quarterly: 22nd / 24th by state for the quarter, PMT-06 on the 25th for a month', () => {
    assert.deepEqual(returnDue({ kind: 'month', to: '2026-09-30' }, 'monthly', '27'), { date: '2026-10-20', form: 'GSTR-3B' });
    assert.deepEqual(returnDue({ kind: 'month', to: '2027-03-31' }, 'monthly', '27'), { date: '2027-04-20', form: 'GSTR-3B' });
    assert.deepEqual(returnDue({ kind: 'quarter', to: '2026-09-30' }, 'quarterly', '27'), { date: '2026-10-22', form: 'GSTR-3B' });
    assert.deepEqual(returnDue({ kind: 'quarter', to: '2026-12-31' }, 'quarterly', '07'), { date: '2027-01-24', form: 'GSTR-3B' });
    assert.deepEqual(returnDue({ kind: 'month', to: '2026-08-31' }, 'quarterly', '07'), { date: '2026-09-25', form: 'PMT-06' });
    assert.equal(returnDue({ kind: 'range', to: '2026-08-15' }, 'monthly', '27'), null);
  });

  test('agrees with the core for every state code, both frequencies and every month', () => {
    const states = [...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')), '97', ''];
    for (const st of [...QRMP_22ND_STATES]) assert.ok(states.includes(st));
    for (const st of states) {
      for (let m = 1; m <= 12; m++) {
        const from = `2026-${String(m).padStart(2, '0')}-01`;
        const to = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10);
        for (const f of ['monthly', 'quarterly'] as const) {
          const core = gstDueDate(from, f, st);
          assert.deepEqual(returnDue({ kind: 'month', to }, f, st), { date: core.dueDate, form: core.form }, `${st} ${from} ${f}`);
        }
        if (m % 3 === 0) {
          const core = gstDueDate(from, 'quarterly', st);
          assert.deepEqual(returnDue({ kind: 'quarter', to }, 'quarterly', st), { date: core.dueDate, form: core.form }, `${st} quarter ending ${to}`);
        }
      }
    }
  });

  test('the state is the company\'s (as the core reads it), else the GSTIN\'s first two digits', () => {
    assert.equal(dueStateCode('27', '07AAACB1234C1Z5'), '27', 'the company state wins over a GSTIN of another state');
    assert.equal(dueStateCode(null, '07AAACB1234C1Z5'), '07');
    assert.equal(dueStateCode('', null), '');
    assert.equal(dueStateCode(undefined, undefined), '');
    // A quarterly filer in Maharashtra (27) without a GSTIN yet still gets the 22nd, as on Home.
    assert.equal(returnDue({ kind: 'quarter', to: '2026-09-30' }, 'quarterly', dueStateCode('27', null))?.date, '2026-10-22');
  });

  test('caption: "Due 20-Oct-26 (in 10 days)", today, late (warning tone), PMT-06', () => {
    assert.deepEqual(dueCaption({ date: '2026-10-20', form: 'GSTR-3B' }, '2026-10-10'), { text: 'Due 20-Oct-26 (in 10 days)', late: false });
    assert.deepEqual(dueCaption({ date: '2026-10-20', form: 'GSTR-3B' }, '2026-10-19'), { text: 'Due 20-Oct-26 (in 1 day)', late: false });
    assert.deepEqual(dueCaption({ date: '2026-10-20', form: 'GSTR-3B' }, '2026-10-20'), { text: 'Due 20-Oct-26 (today)', late: false });
    assert.deepEqual(dueCaption({ date: '2026-10-20', form: 'GSTR-3B' }, '2026-10-23'), { text: 'Due 20-Oct-26 (3 days late)', late: true });
    assert.equal(dueCaption({ date: '2026-09-25', form: 'PMT-06' }, '2026-09-01').text, 'PMT-06 due 25-Sep-26 (in 24 days)');
  });
});

// ───────────────────────────── GSTR-9 ─────────────────────────────

describe('GSTR-9 — tax payable after credit, by month (core gstr9)', () => {
  let ds: Dataset;
  let g: Gstr9Summary;
  before(() => {
    ds = aprilDataset();
    const { t, P } = ds;
    insertDoc(t, { type: 'sales', number: 'M-1', date: '2026-05-05', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '7208', uqc: 'KGS', qty: 20, rate: 18, taxable: 200000, cgst: 18000, sgst: 18000 }] });
    insertDoc(t, { type: 'purchase', number: 'M-2', date: '2026-05-06', party: P.steel, nature: 'inward_b2b', refNo: 'SS/150', refDate: '2026-05-06', lines: [{ hsn: '7208', uqc: 'KGS', qty: 10, rate: 18, taxable: 100000, cgst: 9000, sgst: 9000 }] });
    insertDoc(t, { type: 'sales', number: 'J-1', date: '2026-06-05', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '7208', uqc: 'KGS', qty: 5, rate: 18, taxable: 50000, cgst: 4500, sgst: 4500 }] });
    // July: purchases only — credit left over (below the line).
    insertDoc(t, { type: 'purchase', number: 'JL-1', date: '2026-07-06', party: P.steel, nature: 'inward_b2b', refNo: 'SS/170', refDate: '2026-07-06', lines: [{ hsn: '7208', uqc: 'KGS', qty: 10, rate: 18, taxable: 100000, cgst: 9000, sgst: 9000 }] });
    t.clock.setToday('2026-09-15');
    g = computeGstr9(t.db, loadCompany(t.db), '2026-27', t.today);
  });
  after(() => ds.t.close());

  test('drawn total = the month table\'s "After credit" column total = Σ tax on outward − Σ net ITC', () => {
    const opened: number[] = [];
    const spec = gstr9Chart(g, (i) => opened.push(i));
    assert.ok(spec);
    assertSpec(spec);
    const column = g.months.reduce((a, m) => a + afterCredit(m), 0);
    assert.equal(drawnTotal(spec), column);
    assert.equal(column, g.months.reduce((a, m) => a + sumTax(m.outwardTax), 0) - g.months.reduce((a, m) => a + sumTax(m.itc), 0));
    assert.equal(spec.categories.length, 12);
    assert.deepEqual(spec.categories.slice(0, 4), ['Apr', 'May', 'Jun', 'Jul']);
    assert.equal(spec.color, 'polarity');
    assert.deepEqual(spec.axisCaptions, { up: 'Payable ↑', down: 'Credit left ↓' });
    assert.ok((spec.series[0].values[3] ?? 0) < 0, 'July (purchases only) is credit left over');
    spec.activate?.(1);
    assert.deepEqual(opened, [1], 'Enter on a column opens that month (its row)');
  });

  test('takeaway: where credit is left, and the month with the most tax due', () => {
    const spec = gstr9Chart(g);
    assert.ok(spec);
    assert.match(spec.takeaway, /^Credit left over in 1 of 12 months; tax due most in Apr \(₹[\d.]+ [KL]\)$/);
    const allDue = gstr9Chart({ months: g.months.map((m, i) => (i === 3 ? { ...m, itc: tax(0, 0, 0) } : m)) });
    assert.ok(allDue);
    assert.match(allDue.takeaway, /^Tax due after credit in \d+ of 12 months; most in Apr/);
  });

  test('a year just begun draws from its first month with a value; none without one (2.1.1 D2)', () => {
    const empty = (m: Gstr9MonthRow): Gstr9MonthRow => ({ ...m, outwardTax: tax(0, 0, 0), itc: tax(0, 0, 0) });
    const first = gstr9Chart({ months: g.months.map((m, i) => (i < 1 ? m : empty(m))) });
    assert.ok(first, 'one month with a value: a graph');
    assert.equal(first.xKind, 'time');
    assert.equal(first.total, afterCredit(g.months[0]));
    assert.equal(gstr9Chart({ months: g.months.map(empty) }), null, 'no month with a value: no graph');
    assert.equal(gstr9Chart({ months: [] }), null);
  });
});

// ───────────────────────────── GST Set-off ─────────────────────────────

const head = (h: TaxHead, total: number, available: number) => ({ head: h, label: h, tax: total, interest: 0, penalty: 0, fee: 0, others: 0, total, available, toDeposit: Math.max(0, total - available) });

function setoff(cash: ReturnType<typeof head>[]): GstSetoffResult {
  const cashTotal = cash.reduce((a, r) => a + r.total, 0);
  return {
    cash,
    cashTotal,
    toDepositTotal: cash.reduce((a, r) => a + r.toDeposit, 0),
    challans: [{ voucherId: 1, number: 'P-1', date: '2026-10-05', cpin: '1', cin: null, brn: null, challanDate: null, bankName: null, mode: null, period: '092026', total: 5000_00, heads: [] }],
  } as unknown as GstSetoffResult;
}

describe('GST Set-off — is there enough cash in the e-ledger?', () => {
  test('meter: cash in the ledger (capped per head) of the cash needed; drawn total = Σ "Total" of Cash by head', () => {
    const s = setoff([head('igst', 0, 0), head('cgst', 6000_00, 5000_00), head('sgst', 6000_00, 9000_00), head('cess', 0, 0)]);
    const spec = setoffMeter(s);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(drawnTotal(spec), s.cash.reduce((a, r) => a + r.total, 0));
    assert.equal(spec.series[0].values[0], 11000_00, 'SGST has more than it needs: only what it needs counts');
    assert.equal(setoffCovered(s), s.cashTotal - s.toDepositTotal);
    assert.equal(spec.takeaway, 'Cash in ledger ₹11.0 K of ₹12.0 K needed');
  });

  test('no meter when nothing is needed or nothing is in the ledger', () => {
    assert.equal(setoffMeter(setoff([head('cgst', 0, 3000_00)])), null);
    assert.equal(setoffMeter(setoff([head('cgst', 6000_00, 0)])), null);
  });

  test('stat: "To deposit" (exact paise) — or covered — and never a visible total', () => {
    const s = setoff([head('cgst', 6000_00, 5000_00), head('sgst', 6000_00, 9000_00)]);
    assert.deepEqual(setoffStat(s), { label: 'To deposit', value: 1000_00, tone: 'warning' });
    const challanTotal = s.challans.reduce((a, c) => a + c.total, 0);
    assert.equal(statRepeatsTotal([1000_00], [challanTotal]), false);
    assert.equal(statTotalAllowed('gst.setoff'), false);
    assert.deepEqual(setoffStat(setoff([head('cgst', 6000_00, 9000_00)])), { label: '', value: 'Covered by the cash ledger' });
    assert.equal(setoffStat(setoff([head('cgst', 0, 0)])), null);
  });
});

// ───────────────────────────── Electronic ledgers ─────────────────────────────

const cashTxn = (date: string, kind: CashLedgerTxn['kind'], cgst: number, sgst: number): CashLedgerTxn => ({ voucherId: 1, number: null, date, kind, description: '', period: null, igst: 0, cgst, sgst, cess: 0 });

function cashLedger(txns: CashLedgerTxn[], opening: number): ElectronicCashLedger {
  const deposited = txns.filter((t) => t.kind === 'deposit').reduce((a, t) => a + t.cgst + t.sgst, 0);
  const utilised = txns.filter((t) => t.kind === 'utilised').reduce((a, t) => a + t.cgst + t.sgst, 0);
  return { from: '2026-04-01', to: '2026-10-10', rows: [], totals: { opening, deposited, utilised, closing: opening + deposited - utilised }, transactions: txns, booksBalance: opening + deposited - utilised, notes: [] };
}

describe('Electronic cash ledger — running balance (detail class)', () => {
  test('drawn total = the closing balance (the Total row of "Balance by head"); one point per day', () => {
    const l = cashLedger(
      [cashTxn('2026-05-20', 'deposit', 3000_00, 3000_00), cashTxn('2026-05-20', 'utilised', 1000_00, 1000_00), cashTxn('2026-06-20', 'utilised', 2000_00, 1500_00), cashTxn('2026-05-01', 'deposit', 500_00, 500_00)],
      200_00,
    );
    const spec = cashLedgerChart(l);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(drawnTotal(spec), l.totals.closing);
    assert.deepEqual(spec.series[0].values, [200_00, 1200_00, 5200_00, 1700_00], 'opening, then the end of each day in date order');
    assert.deepEqual(spec.categories, ['Opening 1-Apr-26', '1-May-26', '20-May-26', '20-Jun-26']);
    assert.equal(spec.takeaway, '₹1.7 K on 20-Jun, up ₹1.5 K since 1-Apr');
  });

  test('null with fewer than 2 points (2.1.1 D2)', () => {
    assert.equal(cashLedgerChart(cashLedger([cashTxn('2026-05-20', 'deposit', 100, 100)], 0))?.categories.length, 2, 'opening + one deposit: a line');
    assert.equal(cashLedgerChart(cashLedger([], 0)), null);
  });

  test('a long range keeps at most 480 points and ends on the closing', () => {
    const txns: CashLedgerTxn[] = [];
    for (let d = 0; d < 900; d++) txns.push(cashTxn(new Date(Date.UTC(2024, 0, 1 + d)).toISOString().slice(0, 10), d % 3 === 0 ? 'utilised' : 'deposit', 100, 0));
    const l = { ...cashLedger(txns, 0), from: '2023-12-31' };
    const spec = cashLedgerChart(l);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(spec.categories.length, 480);
    assert.equal(drawnTotal(spec), l.totals.closing);
  });
});

const creditTxn = (date: string, kind: CreditLedgerTxn['kind'], cgst: number, sgst: number): CreditLedgerTxn => ({ voucherId: 1, number: null, voucherTypeName: 'Purchase', date, kind, description: '', igst: 0, cgst, sgst, cess: 0 });

describe('Electronic credit ledger — credit in hand (detail class)', () => {
  test('drawn total = Σ closing of the heads (the "Closing" column total)', () => {
    const txns = [creditTxn('2026-04-06', 'accrued', 9000_00, 9000_00), creditTxn('2026-04-25', 'reversed', -450_00, -450_00), creditTxn('2026-05-20', 'utilised', -6000_00, -6000_00)];
    const rows = [
      { head: 'igst' as const, label: 'IGST', opening: 1000_00, accrued: 0, reversed: 0, utilised: 0, closing: 1000_00 },
      { head: 'cgst' as const, label: 'CGST', opening: 0, accrued: 9000_00, reversed: 450_00, utilised: 6000_00, closing: 2550_00 },
      { head: 'sgst' as const, label: 'SGST/UTGST', opening: 0, accrued: 9000_00, reversed: 450_00, utilised: 6000_00, closing: 2550_00 },
      { head: 'cess' as const, label: 'Cess', opening: 0, accrued: 0, reversed: 0, utilised: 0, closing: 0 },
    ];
    const l: ElectronicCreditLedger = { from: '2026-04-01', to: '2026-10-10', rows, transactions: txns, notes: [] };
    const spec = creditLedgerChart(l);
    assert.ok(spec);
    assertSpec(spec);
    assert.equal(drawnTotal(spec), creditClosing(l));
    assert.equal(creditClosing(l), 6100_00);
    assert.deepEqual(spec.series[0].values, [1000_00, 19000_00, 18100_00, 6100_00]);
    assert.match(spec.takeaway, /^₹6\.1 K on 20-May, up ₹5\.1 K since 1-Apr$/);
  });
});

describe('Electronic credit ledger on the core\'s own computation (April dataset)', () => {
  test('drawn total = Σ closing of the heads, from the core\'s opening and signed movements', () => {
    const ds = aprilDataset();
    try {
      const l = electronicCreditLedger(ds.t.db, '2026-04-01', '2026-04-30', ds.t.today);
      assert.ok(l.transactions.length >= 2, 'the April purchases book credit');
      const spec = creditLedgerChart(l);
      assert.ok(spec);
      assertSpec(spec);
      assert.equal(drawnTotal(spec), creditClosing(l));
      assert.ok(creditClosing(l) > 0);
    } finally {
      ds.t.close();
    }
  });
});

describe('every builder output passes the kit rules', () => {
  test('titles name a single series; takeaways fit the strip', () => {
    const specs = [
      setoffMeter(setoff([head('cgst', 6000_00, 5000_00)])),
      cashLedgerChart(cashLedger([cashTxn('2026-05-01', 'deposit', 100_00, 0), cashTxn('2026-06-01', 'utilised', 50_00, 0)], 10_00)),
    ];
    for (const spec of specs) {
      assert.ok(spec);
      assertSpec(spec);
      assert.ok(spec.takeaway.length <= TAKEAWAY_MAX);
    }
  });
});
