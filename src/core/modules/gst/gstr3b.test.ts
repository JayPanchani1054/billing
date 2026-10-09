/**
 * GSTR-3B on the April-2026 dataset (testkit.ts) + manual adjustments + JSON. Amounts in paise.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Gstr3bSummary } from '../../../shared/types/gst-returns.ts';
import { AppError } from '../../lib/errors.ts';
import { setPeriodLock } from '../company/service.ts';
import { loadCompany, loadDocs } from './docs.ts';
import { buildGstr3bJson, computeGstr3b, readAdjustments, saveAdjustments } from './gstr3b.ts';
import { computeGstr9 } from './gstr9.ts';
import { parsePeriodKey, resolvePeriod } from './period.ts';
import { aprilDataset, insertDoc, setupParties, type Dataset } from './testkit.ts';

const row = (s: Gstr3bSummary, key: string) => {
  const r = [...s.supplies, ...s.eco].find((x) => x.key === key);
  assert.ok(r, key);
  return [r.taxable, r.igst, r.cgst, r.sgst, r.cess];
};
/** Read a nested value of parsed JSON: at(j, 'sup_details', 'osup_det'). */
const at = (o: unknown, ...path: Array<string | number>): unknown => path.reduce<unknown>((x, k) => (x as Record<string | number, unknown>)[k], o);
const april = () => parsePeriodKey('042026') as NonNullable<ReturnType<typeof parsePeriodKey>>;

describe('GSTR-3B — April 2026 dataset', () => {
  let ds: Dataset;
  let s: Gstr3bSummary;
  before(() => {
    ds = aprilDataset();
    s = computeGstr3b(ds.t.db, loadCompany(ds.t.db), resolvePeriod({ period: '042026' }), ds.t.today);
  });
  after(() => ds.t.close());

  it('3.1 outward and inward reverse-charge supplies', () => {
    // (a) B2B 4,100 + B2CL 84,750 + B2CS 85,245.76 + DE 2,000 − CN-1 500 − CN-2 10,000 = 1,65,595.76
    //     IGST 468 + 15,255 + 15,254.24 + 360 − 90 − 1,800 = 29,447.24; CGST = SGST = 102.50 + 20.50 + 27 − 9 = 141.00
    assert.deepEqual(row(s, 'osup_det'), [16559576, 2944724, 14100, 14100, 0]);
    // (b) exports 5,000 + 10,000 + SEZ 1,000 + 4,000 = 20,000; IGST 900 + 180 = 1,080
    assert.deepEqual(row(s, 'osup_zero'), [2000000, 108000, 0, 0, 0]);
    // (c) exempt rice 300 + nil milk 500; (e) petrol 700
    assert.deepEqual(row(s, 'osup_nil_exmp'), [80000, 0, 0, 0, 0]);
    assert.deepEqual(row(s, 'osup_nongst'), [70000, 0, 0, 0, 0]);
    // (d) GTA 1,000 (C/S 25) + lawyer 500 (C/S 45) + import of services 2,000 (IGST 360)
    assert.deepEqual(row(s, 'isup_rev'), [350000, 36000, 7000, 7000, 0]);
    assert.deepEqual(row(s, 'eco_sup'), [0, 0, 0, 0, 0]);
    assert.ok(s.notes.some((n) => /table 4B/.test(n) && /1,000\.00/.test(n)), 'outward RCM S-3 is left out of 3.1(a)');
  });

  it('3.2 inter-state supplies to unregistered persons and composition dealers by POS', () => {
    // Delhi (07): S-4 84,750 + S-5 84,745.76 − CN-2 10,000 = 1,59,495.76; IGST 15,255 + 15,254.24 − 1,800 = 28,709.24
    assert.deepEqual(s.interState.unregistered.map((r) => [r.pos, r.taxable, r.igst]), [['07', 15949576, 2870924]]);
    assert.deepEqual(s.interState.composition.map((r) => [r.pos, r.taxable, r.igst]), [['08', 60000, 10800]]);
    assert.deepEqual(s.interState.uin, []);
  });

  it('4 ITC: imports, RCM, all other (net of purchase return); s.17(5) in 4(A) and reversed in 4(B)(1)', () => {
    const tax = (r: { igst: number; cgst: number; sgst: number; cess: number }) => [r.igst, r.cgst, r.sgst, r.cess];
    assert.deepEqual(
      s.itc.available.map((r) => [r.ty, ...tax(r)]),
      [
        ['IMPG', 180000, 0, 0, 0],
        ['IMPS', 36000, 0, 0, 0],
        ['ISRC', 0, 7000, 7000, 0],
        ['ISD', 0, 0, 0, 0],
        // P-1 270 + P-2 900 + food 10 (blocked) − DN-1 45 → IGST 910, CGST = SGST 270 − 45 = 225
        ['OTH', 91000, 22500, 22500, 0],
      ],
    );
    assert.deepEqual(s.itc.reversed.map((r) => [r.ty, ...tax(r)]), [['RUL', 1000, 0, 0, 0], ['OTH', 0, 0, 0, 0]]);
    assert.deepEqual(tax(s.itc.net), [306000, 29500, 29500, 0]);
    assert.deepEqual(tax(s.itc.blocked), [1000, 0, 0, 0]);
  });

  it('5 exempt / nil / non-GST and composition-supplier inward supplies', () => {
    assert.deepEqual(s.inward.map((r) => [r.ty, r.inter, r.intra]), [['GST', 30000, 40000], ['NONGST', 0, 25000]]);
  });

  it('6.1 payment: ITC set off in statutory order, RCM tax in cash', () => {
    // Liability I 30,527.24 / C 141 / S 141; credit I 3,060 / C 295 / S 295.
    // I→I 3,060; C→C 141, C→I 154; S→S 141, S→I 154 → IGST cash 30,527.24 − 3,060 − 154 − 154 = 27,159.24.
    // Cash total = 27,159.24 + RCM (360 + 70 + 70) = 27,659.24
    assert.deepEqual(
      s.payment.rows.map((r) => [r.head, r.liability, r.paidIgst, r.paidCgst, r.paidSgst, r.cash, r.rcmLiability, r.totalCash]),
      [
        ['igst', 3052724, 306000, 15400, 15400, 2715924, 36000, 2751924],
        ['cgst', 14100, 0, 14100, 0, 0, 7000, 7000],
        ['sgst', 14100, 0, 0, 14100, 0, 7000, 7000],
        ['cess', 0, 0, 0, 0, 0, 0, 0],
      ],
    );
    assert.equal(s.payment.cashTotal, 2765924);
    assert.deepEqual(s.payment.setOff.creditBalance, { igst: 0, cgst: 0, sgst: 0, cess: 0 });
  });

  it('JSON in the GSTN offline-utility shape', () => {
    const f = buildGstr3bJson(s);
    const j: unknown = JSON.parse(f.json);
    assert.equal(f.fileName, `GSTR3B_${String(s.gstin)}_042026.json`);
    assert.deepEqual(Object.keys(j as object), ['gstin', 'ret_period', 'sup_details', 'eco_dtls', 'inter_sup', 'itc_elg', 'inward_sup', 'intr_ltfee']);
    assert.deepEqual(at(j, 'sup_details'), {
      osup_det: { txval: 165595.76, iamt: 29447.24, camt: 141, samt: 141, csamt: 0 },
      osup_zero: { txval: 20000, iamt: 1080, csamt: 0 },
      osup_nil_exmp: { txval: 800 },
      isup_rev: { txval: 3500, iamt: 360, camt: 70, samt: 70, csamt: 0 },
      osup_nongst: { txval: 700 },
    });
    assert.deepEqual(at(j, 'inter_sup', 'unreg_details'), [{ pos: '07', txval: 159495.76, iamt: 28709.24 }]);
    assert.deepEqual(at(j, 'inter_sup', 'comp_details'), [{ pos: '08', txval: 600, iamt: 108 }]);
    assert.deepEqual(
      (at(j, 'itc_elg', 'itc_avl') as Array<{ ty: string; iamt: number }>).map((r) => [r.ty, r.iamt]),
      [['IMPG', 1800], ['IMPS', 360], ['ISRC', 0], ['ISD', 0], ['OTH', 910]],
    );
    assert.deepEqual(at(j, 'itc_elg', 'itc_rev', 0), { ty: 'RUL', iamt: 10, camt: 0, samt: 0, csamt: 0 });
    assert.deepEqual(at(j, 'itc_elg', 'itc_net'), { iamt: 3060, camt: 295, samt: 295, csamt: 0 });
    assert.deepEqual(at(j, 'inward_sup', 'isup_details'), [{ ty: 'GST', inter: 300, intra: 400 }, { ty: 'NONGST', inter: 0, intra: 250 }]);
    assert.deepEqual(at(j, 'intr_ltfee'), { intr_details: { iamt: 0, camt: 0, samt: 0, csamt: 0 }, ltfee_details: { camt: 0, samt: 0 } });
    assert.deepEqual(f.warnings, []);
  });
});

describe('GSTR-3B manual adjustments', () => {
  it('saves, merges, audits and applies ISD, reversals, reclaim, interest, late fee and the credit ledger balance', () => {
    const { t, P } = setupParties({ today: '2026-05-10' });
    insertDoc(t, { type: 'sales', number: 'S1', date: '2026-04-02', party: P.bharat, nature: 'b2b', pos: '29', lines: [{ hsn: '8471', rate: 18, taxable: 1000000, igst: 180000 }] });
    insertDoc(t, { type: 'purchase', number: 'P1', date: '2026-04-03', party: P.steel, nature: 'inward_b2b', refNo: 'A1', refDate: '2026-04-03', lines: [{ hsn: '7208', rate: 18, taxable: 500000, cgst: 45000, sgst: 45000 }] });
    const company = loadCompany(t.db);
    saveAdjustments(t.ctx, april(), { itcIsd: { igst: 10000 }, itcReversalRules: { cgst: 5000, sgst: 5000 }, interest: { igst: 1234 } });
    saveAdjustments(t.ctx, april(), { lateFee: { cgst: 2500, sgst: 2500 }, itcReclaimed: { igst: 2000 }, creditLedgerBalance: { igst: 30000 } });
    const stored = readAdjustments(t.db, '042026');
    assert.deepEqual(stored.values.itcIsd, { igst: 10000, cgst: 0, sgst: 0, cess: 0 }, 'first save kept by the second (merge)');
    assert.equal(stored.values.interest.igst, 1234);
    const audits = t.db.all<{ action: string; entity_type: string; entity_label: string }>("SELECT action, entity_type, entity_label FROM audit_log WHERE entity_type = 'gst_adjustments' ORDER BY id");
    assert.deepEqual(audits.map((a) => [a.action, a.entity_label]), [['create', 'GSTR-3B manual entries Apr 2026'], ['alter', 'GSTR-3B manual entries Apr 2026']]);

    const s = computeGstr3b(t.db, company, april(), t.today);
    const ty = (rows: Gstr3bSummary['itc']['available'], k: string) => rows.find((r) => r.ty === k);
    assert.equal(ty(s.itc.available, 'ISD')?.igst, 10000);
    assert.equal(ty(s.itc.available, 'OTH')?.igst, 2000, 'reclaimed ITC is added to 4(A)(5)');
    assert.equal(ty(s.itc.available, 'OTH')?.source, 'both');
    assert.equal(s.itc.reversed[0].cgst, 5000);
    assert.equal(s.itc.ineligible[0].igst, 2000);
    // Net: I 100 + 20 = 120; C/S 450 − 50 = 400. Credit for set-off: I 120 + 300 b/f = 420.
    assert.deepEqual(s.itc.net, { igst: 12000, cgst: 40000, sgst: 40000, cess: 0 });
    assert.deepEqual(s.payment.creditAvailable, { igst: 42000, cgst: 40000, sgst: 40000, cess: 0 });
    // IGST liability 1,800: I→I 420; C→I 400; S→I 400 → cash 580. Plus interest 12.34 and late fee 25 + 25.
    const igst = s.payment.rows[0];
    assert.deepEqual([igst.liability, igst.paidIgst, igst.paidCgst, igst.paidSgst, igst.cash, igst.interest, igst.totalCash], [180000, 42000, 40000, 40000, 58000, 1234, 59234]);
    assert.equal(s.payment.cashTotal, 59234 + 2500 + 2500);
    const j: unknown = JSON.parse(buildGstr3bJson(s).json);
    assert.deepEqual(at(j, 'intr_ltfee'), { intr_details: { iamt: 12.34, camt: 0, samt: 0, csamt: 0 }, ltfee_details: { camt: 25, samt: 25 } });
    assert.deepEqual(at(j, 'itc_elg', 'itc_inelg', 0), { ty: 'RUL', iamt: 20, camt: 0, samt: 0, csamt: 0 });
    t.close();
  });

  it('rejects late fee under IGST, negative amounts and changes to a locked period', () => {
    const { t } = setupParties({ today: '2026-05-10' });
    assert.throws(() => saveAdjustments(t.ctx, april(), { lateFee: { igst: 100 } }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION' && /CGST and SGST/.test(e.message));
    assert.throws(() => saveAdjustments(t.ctx, april(), { interest: { cgst: -1 } }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
    setPeriodLock(t.ctx, '2026-04-30');
    assert.throws(() => saveAdjustments(t.ctx, april(), { interest: { cgst: 1 } }), (e: unknown) => e instanceof AppError && e.code === 'LOCKED');
    t.close();
  });

  it('credit notes larger than supplies: liability treated as zero, JSON writes 0 with a warning', () => {
    const { t, P } = setupParties({ today: '2026-05-10' });
    insertDoc(t, { type: 'credit_note', number: 'CN1', date: '2026-04-05', party: P.bharat, nature: 'b2b', pos: '29', origNo: 'OLD-1', lines: [{ hsn: '8471', rate: 18, taxable: 100000, igst: 18000 }] });
    const s = computeGstr3b(t.db, loadCompany(t.db), april(), t.today);
    assert.deepEqual(row(s, 'osup_det'), [-100000, -18000, 0, 0, 0]);
    assert.equal(s.payment.rows[0].liability, 0);
    assert.ok(s.notes.some((n) => /negative/.test(n)));
    const f = buildGstr3bJson(s);
    assert.deepEqual(at(JSON.parse(f.json), 'sup_details', 'osup_det'), { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
    assert.equal(f.warnings.length, 2);
    t.close();
  });
});

describe('GSTR-3B credit chain: lean document load', () => {
  it('classifies every document exactly like the full load, so the chained set-off is the same', () => {
    // The chain walks the whole history with loadDocs({ lean: true }) (classification columns only). On the
    // April dataset (every nature: B2B / B2CL / B2CS / exports / SEZ / deemed exports / RCM / imports /
    // composition / nil / non-GST / notes) the lean and full loads must agree field for field on what
    // GSTR-3B uses, and give the same summary.
    const ds = aprilDataset();
    try {
      const company = loadCompany(ds.t.db);
      const range = { from: '2026-04-01', to: '2026-04-30', today: ds.t.today };
      const full = loadDocs(ds.t.db, company, range);
      const lean = loadDocs(ds.t.db, company, { ...range, lean: true });
      const pick = (d: (typeof full)[number]) => ({
        id: d.id, nature: d.nature, direction: d.direction, sign: d.sign, interState: d.interState, pos: d.pos,
        reverseCharge: d.reverseCharge, inBooks: d.inBooks, registration: d.party.registration,
        lines: d.lines.map((l) => [l.supplyType, l.taxability, l.rate, l.taxable, l.igst, l.cgst, l.sgst, l.cess, l.reverseCharge, l.itcEligibility]),
      });
      assert.ok(full.length > 20);
      assert.deepEqual(lean.map(pick), full.map(pick));
      const p = april();
      const viaLean = computeGstr3b(ds.t.db, company, p, ds.t.today, undefined, lean);
      const viaFull = computeGstr3b(ds.t.db, company, p, ds.t.today, undefined, full);
      assert.deepEqual(viaLean, viaFull);
    } finally {
      ds.t.close();
    }
  });
});

describe('GSTR-3B electronic credit ledger brought forward (6.1)', () => {
  // Maharashtra company, books from 1-Apr-2026. Amounts in paise.
  //   April: purchase C/S 450 + 450; intra sale C/S 90 + 90; portal opening balance (manual) IGST 100.
  //          Set-off (Rule 88A: IGST credit is used up first): C 90 ← I 90; S 90 ← I 10 + S 80
  //          → closing credit I 0, C 450, S 370; cash 0.
  //   May:   inter-state sale IGST 360; no ITC. Credit b/f I 0, C 450, S 370: I 360 ← C 360
  //          → closing I 0, C 90, S 370; cash 0.
  //          Before the fix May started with no credit and showed ₹360 IGST payable in cash.
  //   June:  nothing → brought forward = closing = C 90, S 370.
  const setup = () => {
    const { t, P } = setupParties({ today: '2026-10-10' });
    insertDoc(t, { type: 'purchase', number: 'P1', date: '2026-04-03', party: P.steel, nature: 'inward_b2b', refNo: 'A1', refDate: '2026-04-03', lines: [{ hsn: '7208', rate: 18, taxable: 500000, cgst: 45000, sgst: 45000 }] });
    insertDoc(t, { type: 'sales', number: 'S1', date: '2026-04-10', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '8471', rate: 18, taxable: 100000, cgst: 9000, sgst: 9000 }] });
    insertDoc(t, { type: 'sales', number: 'S2', date: '2026-05-10', party: P.bharat, nature: 'b2b', pos: '29', lines: [{ hsn: '8471', rate: 18, taxable: 200000, igst: 36000 }] });
    saveAdjustments(t.ctx, april(), { creditLedgerBalance: { igst: 10000 } });
    return { t, P, company: loadCompany(t.db) };
  };
  const m = (key: string) => parsePeriodKey(key) as NonNullable<ReturnType<typeof parsePeriodKey>>;
  const tax = (igst: number, cgst: number, sgst: number) => ({ igst, cgst, sgst, cess: 0 });

  it('each month starts with the credit the previous month left, and the cash payable uses it', () => {
    const { t, company } = setup();
    const apr = computeGstr3b(t.db, company, m('042026'), t.today);
    assert.deepEqual(apr.payment.broughtForward, tax(0, 0, 0), 'the first period of the books carries nothing in');
    assert.deepEqual(apr.payment.creditAvailable, tax(10000, 45000, 45000), '4(C) + the manual portal balance');
    assert.deepEqual(apr.payment.setOff.creditBalance, tax(0, 45000, 37000));
    const may = computeGstr3b(t.db, company, m('052026'), t.today);
    assert.deepEqual(may.payment.broughtForward, tax(0, 45000, 37000));
    assert.deepEqual(may.payment.creditAvailable, tax(0, 45000, 37000));
    assert.deepEqual([may.payment.rows[0].paidIgst, may.payment.rows[0].paidCgst, may.payment.rows[0].cash], [0, 36000, 0]);
    assert.equal(may.payment.cashTotal, 0);
    assert.deepEqual(may.payment.setOff.creditBalance, tax(0, 9000, 37000));
    assert.ok(may.notes.some((n) => /Credit brought forward from the previous return period/.test(n)));
    const jun = computeGstr3b(t.db, company, m('062026'), t.today);
    assert.deepEqual(jun.payment.broughtForward, tax(0, 9000, 37000));

    // GSTR-9 table 9 follows the same chain: no IGST paid in cash in the year.
    const nine = computeGstr9(t.db, company, '2026-27', t.today);
    assert.deepEqual(nine.table9.map((r) => [r.head, r.paidCash]), [['igst', 0], ['cgst', 0], ['sgst', 0], ['cess', 0]]);
    t.close();
  });

  it('a later entry in an earlier month changes what is brought forward (no stale cache)', () => {
    const { t, P, company } = setup();
    assert.deepEqual(computeGstr3b(t.db, company, m('062026'), t.today).payment.broughtForward, tax(0, 9000, 37000));
    // Another April purchase: C/S 10 + 10 more credit → April closes at C 460, S 380 → May at C 100, S 380.
    insertDoc(t, { type: 'purchase', number: 'P2', date: '2026-04-20', party: P.steel, nature: 'inward_b2b', refNo: 'A2', refDate: '2026-04-20', lines: [{ hsn: '7208', rate: 18, taxable: 11112, cgst: 1000, sgst: 1000 }] });
    assert.deepEqual(computeGstr3b(t.db, company, m('062026'), t.today).payment.broughtForward, tax(0, 10000, 38000));
    // A manual entry in May (credit the books do not hold) is carried on too.
    saveAdjustments(t.ctx, m('052026'), { creditLedgerBalance: { sgst: 500 } });
    assert.deepEqual(computeGstr3b(t.db, company, m('062026'), t.today).payment.broughtForward, tax(0, 10000, 38500));
    t.close();
  });

  it('only periods from the first changed one are recomputed, and a shorter chain never leaves a later period stale', () => {
    const { t, P, company } = setup();
    assert.deepEqual(computeGstr3b(t.db, company, m('072026'), t.today).payment.broughtForward, tax(0, 9000, 37000), 'June closing');
    // A June purchase adds C/S 10 + 10; then June itself is viewed (its chain ends in May, unchanged) …
    insertDoc(t, { type: 'purchase', number: 'P3', date: '2026-06-05', party: P.steel, nature: 'inward_b2b', refNo: 'A3', refDate: '2026-06-05', lines: [{ hsn: '7208', rate: 18, taxable: 11112, cgst: 1000, sgst: 1000 }] });
    assert.deepEqual(computeGstr3b(t.db, company, m('062026'), t.today).payment.broughtForward, tax(0, 9000, 37000));
    // … and July must still see June's new closing credit, not the one cached before the purchase.
    assert.deepEqual(computeGstr3b(t.db, company, m('072026'), t.today).payment.broughtForward, tax(0, 10000, 38000));
    // A change of the working date (post-dated vouchers falling due) starts afresh.
    assert.deepEqual(computeGstr3b(t.db, company, m('072026'), '2026-10-11').payment.broughtForward, tax(0, 10000, 38000));
    t.close();
  });

  it('a quarter carries the previous quarter’s closing credit; a date range carries nothing', () => {
    const { t, company } = setup();
    // Q1 as one return (the April manual entry belongs to the month, not to the quarter):
    // liability I 360, C 90, S 90; credit C 450, S 450 → C 90 ← C, I 360 ← C → C 0; S 90 ← S → S 360.
    const q1 = computeGstr3b(t.db, company, m('2026-27-Q1'), t.today);
    assert.deepEqual(q1.payment.setOff.creditBalance, tax(0, 0, 36000));
    const q2 = computeGstr3b(t.db, company, m('2026-27-Q2'), t.today);
    assert.deepEqual(q2.payment.broughtForward, tax(0, 0, 36000));
    const range = computeGstr3b(t.db, company, resolvePeriod({ from: '2026-05-01', to: '2026-05-31' }), t.today);
    assert.deepEqual(range.payment.broughtForward, tax(0, 0, 0));
    assert.equal(range.payment.rows[0].cash, 36000, 'a review range sets off only its own credit');
    assert.ok(range.notes.some((n) => /date range is a review/.test(n)));
    t.close();
  });
});
