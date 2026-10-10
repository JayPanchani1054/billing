/**
 * Regression tests of the adversarial review of the tds module (each would fail if its defect came
 * back). Figures are hand-verified in the comments.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TdsChallanRegister, TdsComputationResult, TdsOutstandingResult } from '../../../shared/types/tds.ts';
import type { VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { previewVoucher } from '../vouchers/service.ts';
import { vouchersRoutes } from '../vouchers/routes.ts';
import { computeTds } from './engine.ts';
import { getLedgerDetails, listLedgerDetails, listNatures, saveLedgerDetails, saveNature, getNature, saveSettings } from './masters.ts';
import { tdsRoutes } from './routes.ts';
import { getTdsSettings, TdsStore } from './store.ts';
import { entries, journal, purchase, save, setupTds, tdsLines, type TdsKit } from './testkit.ts';

const R = { ...vouchersRoutes, ...tdsRoutes };
const P = (rupees: number): number => Math.round(rupees * 100);
const sum = (e: Record<string, number>): number => Object.values(e).reduce((a, b) => a + b, 0);

function payable(k: TdsKit, section: string): number {
  const id = k.t.db.value<number>(`SELECT ledger_id FROM tds_ledger_details WHERE payable_kind = 'tds' AND payable_section = :s`, { s: section });
  assert.ok(id !== undefined, `TDS Payable – ${section} exists`);
  return id;
}

function ledgerBalance(k: TdsKit, ledgerId: number): number {
  return k.t.db.value<number>('SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE ledger_id = :id AND affects_books = 1', { id: ledgerId }) ?? 0;
}

describe('tds review: posting', () => {
  it('a TDS line typed by hand is the deduction: not posted a second time; reports tie to the ledger', async () => {
    const k = setupTds();
    save(k, journal(k, '2026-05-01', k.L.contractExp, k.L.contractor, P(40_000))); // creates TDS Payable – 194C
    const pay = payable(k, '194C');
    // Dr Contract Charges 40,000 / Cr Sharma Contractors 39,200 / Cr TDS Payable – 194C 800 (typed).
    const r = save(k, {
      voucherTypeId: k.vt.journal,
      date: '2026-05-02',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.contractExp, amount: P(40_000) },
        { ledgerId: k.L.contractor, amount: -P(39_200) },
        { ledgerId: pay, amount: -P(800) },
      ],
    });
    const e = entries(k, r.id);
    assert.equal(e['TDS Payable – 194C'], -P(800), 'posted once (was ₹1,600: typed + auto)');
    assert.equal(e['Sharma Contractors'], -P(39_200));
    assert.equal(sum(e), 0);
    const [l] = tdsLines(k, r.id);
    assert.deepEqual({ amount: l.amount, overridden: l.overridden, status: l.status }, { amount: P(800), overridden: 0, status: 'deducted' });
    // Tie-out: the duty ledger's credit balance = the outstanding report's balance (2 × ₹800).
    const o = await k.t.callOk<TdsOutstandingResult>(R, 'tds.outstanding', { asOf: '2026-05-31', kind: 'tds' });
    assert.equal(o.totals.balance, -ledgerBalance(k, pay));
    assert.equal(o.totals.balance, P(1_600));
    k.t.close();
  });

  it('a different typed amount is recorded as a change (with its reason) and shown as short deduction', () => {
    const k = setupTds();
    save(k, journal(k, '2026-05-01', k.L.contractExp, k.L.contractor, P(40_000)));
    const pay = payable(k, '194C');
    const r = save(k, {
      voucherTypeId: k.vt.journal,
      date: '2026-05-02',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.contractExp, amount: P(40_000) },
        { ledgerId: k.L.contractor, amount: -P(39_600) },
        { ledgerId: pay, amount: -P(400) },
      ],
    });
    assert.equal(entries(k, r.id)['TDS Payable – 194C'], -P(400));
    const [l] = tdsLines(k, r.id);
    assert.deepEqual({ amount: l.amount, computed: l.computed, overridden: l.overridden }, { amount: P(400), computed: P(800), overridden: 1 });
    assert.match(l.reason ?? '', /Entered by hand/);
    k.t.close();
  });

  it('a TDS line typed by hand with nothing TDS-applicable on the voucher asks for confirmation', () => {
    const k = setupTds();
    save(k, journal(k, '2026-05-01', k.L.contractExp, k.L.contractor, P(40_000)));
    const pay = payable(k, '194C');
    const misc = k.t.addLedger({ name: 'Repairs', group: 'INDIRECT_EXPENSES' });
    const p = previewVoucher(k.t.ctx, {
      voucherTypeId: k.vt.journal,
      date: '2026-05-02',
      mode: 'ledger',
      ledgers: [
        { ledgerId: misc, amount: P(40_000) },
        { ledgerId: k.L.contractor, amount: -P(39_200) },
        { ledgerId: pay, amount: -P(800) },
      ],
    });
    assert.ok(p.warnings.some((w) => w.code === 'tds' && w.level === 'confirm' && /by hand/.test(w.message)));
    k.t.close();
  });

  it('194T: a partner’s capital account marked as a deductee is found (was "no party")', () => {
    const k = setupTds();
    // 194T is deducted by a firm (final wave: other deductors do not deduct under it).
    saveSettings(k.t.ctx, { ...getTdsSettings(k.t.db), deductorCategory: 'firm' });
    const n194T = k.t.db.value<number>(`SELECT id FROM tds_natures WHERE section = '194T'`) as number;
    const cap = k.t.addLedger({ name: 'Partner A Capital', group: 'CAPITAL_ACCOUNT', pan: 'ABCPA1111A' });
    const rem = k.t.addLedger({ name: 'Partner Remuneration', group: 'INDIRECT_EXPENSES' });
    saveLedgerDetails(k.t.ctx, { ledgerId: rem, applicable: true, natureId: n194T });
    saveLedgerDetails(k.t.ctx, { ledgerId: cap, applicable: true, deducteeType: 'individual', natureId: n194T });
    // Remuneration ₹1,00,000 > ₹20,000: 10% = ₹10,000; the capital account is credited ₹90,000.
    const r = save(k, journal(k, '2026-06-30', rem, cap, P(1_00_000)));
    const e = entries(k, r.id);
    assert.deepEqual([e['Partner A Capital'], e['TDS Payable – 194T'], sum(e)], [-P(90_000), -P(10_000), 0]);
    k.t.close();
  });

  it('a transfer between two parties is not a payment for work (no TDS from a party’s default nature)', () => {
    const k = setupTds();
    // Sharma Contractors has 194C as default nature; Dr Sharma / Cr CA Kapoor is a set-off between parties.
    const p = previewVoucher(k.t.ctx, journal(k, '2026-06-30', k.L.contractor, k.L.prof, P(1_00_000)));
    assert.equal(p.tds, undefined);
    assert.ok(!p.entries.some((x) => /TDS Payable/.test(x.ledgerName)));
    k.t.close();
  });

  it('a party marked "does not apply" is exempt; a party without details is a deductee by default', () => {
    const k = setupTds();
    const fresh = k.t.addLedger({ name: 'New Supplier', group: 'SUNDRY_CREDITORS' });
    assert.equal(getLedgerDetails(k.t.db, fresh).applicable, true);
    assert.equal(listLedgerDetails(k.t.db, { role: 'party' }).find((x) => x.ledgerId === fresh)?.applicable, true);
    saveLedgerDetails(k.t.ctx, { ledgerId: k.L.contractor, applicable: false, deducteeType: 'firm' });
    const input = purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'X1');
    const p = previewVoucher(k.t.ctx, input);
    assert.ok(p.warnings.some((w) => w.code === 'tds' && /does not apply/.test(w.message)));
    const r = save(k, input);
    assert.deepEqual(tdsLines(k, r.id), []);
    assert.equal(entries(k, r.id)['Sharma Contractors'], -P(47_200), 'credited in full');
    k.t.close();
  });
});

describe('tds review: feature turned off', () => {
  it('altering a voucher with TDS after F11 › TDS was turned off asks before dropping the TDS', async () => {
    const k = setupTds();
    const r = save(k, purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-1'));
    const { saveFeatures } = await import('../company/service.ts');
    saveFeatures(k.t.ctx, { tds: false });
    const p = previewVoucher(k.t.ctx, { ...purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-1'), id: r.id });
    assert.ok(p.warnings.some((w) => w.code === 'tds' && w.level === 'confirm' && /turned off/.test(w.message)));
    // A new voucher (nothing to lose) is not warned.
    const fresh = previewVoucher(k.t.ctx, purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-2'));
    assert.ok(!fresh.warnings.some((w) => /turned off/.test(w.message)));
    k.t.close();
  });
});

describe('tds review: advances', () => {
  it('a bill after an advance taxed under the same nature is taxed only on the rest (no second deduction)', () => {
    const k = setupTds();
    // Advance ₹50,000 to Sharma Contractors (firm, 194C 2%): single sum > ₹30,000 → ₹1,000.
    const adv = save(k, {
      voucherTypeId: k.vt.payment,
      date: '2026-05-01',
      mode: 'ledger',
      tds: { natureId: k.N['194C'] },
      ledgers: [
        { ledgerId: k.L.contractor, amount: P(50_000) },
        { ledgerId: k.L.bank, amount: -P(50_000) },
      ],
    });
    assert.equal(tdsLines(k, adv.id)[0].amount, P(1_000));
    // Bill ₹80,000 (+ GST): ₹50,000 set off; one sum of ₹80,000 > ₹30,000 → 2% × 30,000 = ₹600 (was ₹1,600).
    const b1 = save(k, purchase(k, '2026-05-10', k.L.contractor, k.L.contractExp, P(80_000), 'B1'));
    const l1 = k.t.db.get<{ assessable: number; advance_adjusted: number; base: number; amount: number }>(
      'SELECT assessable, advance_adjusted, base, amount FROM tds_lines WHERE voucher_id = :id',
      { id: b1.id },
    );
    assert.deepEqual(l1, { assessable: P(30_000), advance_adjusted: P(50_000), base: P(30_000), amount: P(600) });
    // Altering the bill (self excluded) gives the same set-off.
    // Bill ₹40,000: no advance left; aggregate 50,000 + 30,000 + 40,000 = ₹1,20,000 > ₹1,00,000 → ₹800.
    const b2 = save(k, purchase(k, '2026-05-20', k.L.contractor, k.L.contractExp, P(40_000), 'B2'));
    const l2 = tdsLines(k, b2.id)[0];
    assert.deepEqual({ assessable: l2.assessable, amount: l2.amount }, { assessable: P(40_000), amount: P(800) });
    // Total ₹2,400 = 2% of ₹1,20,000 actually paid / credited.
    assert.equal(k.t.db.value<number>('SELECT SUM(amount) FROM tds_lines'), P(2_400));
    k.t.close();
  });

  it('an advance below the threshold (nothing deducted) is not set off: the bill is taxed in full', () => {
    const k = setupTds();
    // Advance ₹20,000 to Ramesh Labour (individual 1%): within ₹30,000 / ₹1,00,000 → nil.
    const adv = save(k, {
      voucherTypeId: k.vt.payment,
      date: '2026-05-01',
      mode: 'ledger',
      tds: { natureId: k.N['194C'] },
      ledgers: [
        { ledgerId: k.L.labour, amount: P(20_000) },
        { ledgerId: k.L.bank, amount: -P(20_000) },
      ],
    });
    assert.equal(tdsLines(k, adv.id)[0].amount, 0);
    // Bill ₹50,000: 1% × 50,000 = ₹500, no set-off.
    const b = save(k, journal(k, '2026-05-10', k.L.labourExp, k.L.labour, P(50_000)));
    const l = tdsLines(k, b.id)[0];
    assert.deepEqual({ assessable: l.assessable, amount: l.amount }, { assessable: P(50_000), amount: P(500) });
    k.t.close();
  });

  it('engine: the single-transaction limit is tested on the whole sum, the tax on the base', () => {
    const rate = {
      id: 1,
      applicableFrom: '2024-04-01',
      rateIndividual: 1,
      rateCompany: 2,
      rateOthers: 2,
      rateNoPan: 20,
      thresholdSingle: P(30_000),
      thresholdAggregate: P(1_00_000),
      aggregatePeriod: 'fy' as const,
      thresholdBasis: 'whole' as const,
      baseIncludesGst: false,
      note: null,
    };
    const base = { rate, deducteeType: 'firm' as const, panOk: true, prior: 0, priorUndeducted: 0, certificate: null, roundToRupee: true, verb: 'deduct' as const };
    assert.equal(computeTds({ ...base, assessable: P(25_000) }).amount, 0);
    assert.equal(computeTds({ ...base, assessable: P(25_000), singleBase: P(75_000) }).amount, P(500));
  });
});

describe('tds review: masters', () => {
  it('a PAN or deductor TAN can be cleared (null), not only changed', () => {
    const k = setupTds();
    saveLedgerDetails(k.t.ctx, { ledgerId: k.L.buyer, applicable: true, deducteeType: 'company', deductorTan: 'MUMA12345B' });
    const out = saveLedgerDetails(k.t.ctx, { ledgerId: k.L.buyer, applicable: true, deducteeType: 'company', pan: null, deductorTan: null });
    assert.deepEqual({ pan: out.pan, tan: out.deductorTan }, { pan: null, tan: null });
    assert.equal(k.t.db.value('SELECT pan FROM ledgers WHERE id = :id', { id: k.L.buyer }), null);
    // undefined keeps them.
    saveLedgerDetails(k.t.ctx, { ledgerId: k.L.labour, applicable: true, deducteeType: 'individual' });
    assert.equal(getLedgerDetails(k.t.db, k.L.labour).pan, 'ABCPL5678M');
    k.t.close();
  });

  it('inactive natures are left out unless asked for; seeds: timber TCS 2% from 1-Oct-2024', () => {
    const k = setupTds();
    const n = getNature(k.t.db, k.N['194H']);
    saveNature(k.t.ctx, { id: n.id, kind: 'tds', name: n.name, section: n.section, isActive: false, rates: n.rates.map(({ id: _id, ...r }) => r) });
    assert.ok(!listNatures(k.t.db, { kind: 'tds' }).some((x) => x.id === n.id));
    assert.ok(listNatures(k.t.db, { kind: 'tds', includeInactive: true }).some((x) => x.id === n.id));
    const timber = k.t.db.value<number>(`SELECT id FROM tds_natures WHERE name = 'Sale of timber or other forest produce'`) as number;
    const store = new TdsStore(k.t.db);
    assert.deepEqual([store.rateOn(timber, '2024-09-30')?.rate_individual, store.rateOn(timber, '2024-10-01')?.rate_individual, store.rateOn(timber, '2024-10-01')?.rate_no_pan], [2.5, 2, 5]);
    k.t.close();
  });
});

describe('tds review: challans and reports', () => {
  const challan = (challanNo: string, depositDate: string, tax: number) => ({
    kind: 'tds' as const,
    section: '194C',
    period: '2026-04',
    bsrCode: '0510001',
    challanNo,
    depositDate,
    tax,
  });

  it('the same challan (BSR + date + serial) recorded twice needs confirmation', async () => {
    const k = setupTds();
    save(k, purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-1'));
    await k.t.callOk<VoucherSaveResult>(R, 'tds.challan.save', { date: '2026-05-07', bankLedgerId: k.L.bank, challan: challan('00011', '2026-05-07', P(800)) });
    const again = await k.t.call(R, 'tds.challan.save', { date: '2026-05-07', bankLedgerId: k.L.bank, challan: challan('00011', '2026-05-07', P(800)) });
    assert.equal(again.ok, false);
    assert.match(JSON.stringify(again), /already recorded/);
    k.t.close();
  });

  it('tie-outs: computation (any period) = drill-down lines; challan register cleared = computation deposited; outstanding = duty ledgers', async () => {
    const k = setupTds();
    // April: 194C ₹800; May: 194C ₹800 (another bill), June: 194C ₹800.
    save(k, purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'A1'));
    save(k, purchase(k, '2026-05-20', k.L.contractor, k.L.contractExp, P(40_000), 'A2'));
    save(k, purchase(k, '2026-06-05', k.L.contractor, k.L.contractExp, P(40_000), 'A3'));
    // April's tax paid in May; May's half paid in June.
    await k.t.callOk(R, 'tds.challan.save', { date: '2026-05-07', bankLedgerId: k.L.bank, challan: challan('00001', '2026-05-07', P(800)) });
    await k.t.callOk(R, 'tds.challan.save', {
      date: '2026-06-07',
      bankLedgerId: k.L.bank,
      challan: { ...challan('00002', '2026-06-07', P(400)), period: '2026-05' },
    });
    // Computation of May alone (history before the month is not loaded): ₹800 deducted, ₹400 deposited.
    const may = await k.t.callOk<TdsComputationResult>(R, 'tds.computation', { from: '2026-05-01', to: '2026-06-30', kind: 'tds' });
    assert.deepEqual({ d: may.totals.deducted, dep: may.totals.deposited, bal: may.totals.balance }, { d: P(1_600), dep: P(400), bal: P(1_200) });
    const fy = await k.t.callOk<TdsComputationResult>(R, 'tds.computation', { from: '2026-04-01', to: '2027-03-31', kind: 'tds' });
    const reg = await k.t.callOk<TdsChallanRegister>(R, 'tds.challans', { from: '2026-04-01', to: '2027-03-31', kind: 'tds' });
    assert.equal(reg.totals.cleared, fy.totals.deposited);
    assert.equal(fy.totals.deposited, P(1_200));
    // A register of June alone still clears May's challan against May's deduction.
    const june = await k.t.callOk<TdsChallanRegister>(R, 'tds.challans', { from: '2026-06-01', to: '2026-06-30', kind: 'tds' });
    assert.deepEqual(june.rows.map((r) => [r.period, r.cleared, r.unconsumed]), [['2026-05', P(400), 0]]);
    const o = await k.t.callOk<TdsOutstandingResult>(R, 'tds.outstanding', { asOf: '2027-03-31', kind: 'tds' });
    assert.equal(o.totals.balance, -ledgerBalance(k, payable(k, '194C')));
    assert.equal(o.totals.balance, P(1_200));
    k.t.close();
  });
});
