/**
 * Regression tests for defects found in the adversarial review of the GST plus features (each test
 * fails if its defect returns):
 *
 *   1. an advance receipt already adjusted / refunded could be altered (amount lowered, advance dropped,
 *      rate changed, made optional) → "GST on Advances Received" left with a balance, 11B > 11A;
 *   2. an advance larger than the amount received was taxed in full;
 *   3. Table 11 reported an advance received and adjusted in the same return period in both 11A and 11B
 *      (GSTR-1: 11A is "invoice not issued in the same tax period", 11B adjusts "earlier" periods);
 *   4. after the set-off was posted, GST Set-off asked for the same cash to be deposited again;
 *   5. a journal tagged as a set-off could use CGST credit for SGST (s.49(5)) through vouchers.save;
 *   6. an amendment logged on the last day of a filed period was reported in that (filed) period;
 *   7. the bill-of-entry reconciliation offered ZIP files but read JSON only;
 *   8. the credit ledger's transactions mixed signs (reversals −, utilisation +), so their totals meant nothing;
 *   9. a bill of entry on blocked goods (ITC ineligible) still debited Input IGST and claimed it in 3B;
 *  10. a GST challan could be posted with a malformed return period;
 *  11. the GST system ledgers created on demand (GST on Advances, Electronic Cash Ledger, …) were not audited.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ElectronicCreditLedger, GstAmendmentRow, GstSetoffResult } from '../../../shared/types/gst-plus.ts';
import type { Gstr3bSummary } from '../../../shared/types/gst-returns.ts';
import type { VoucherDetail, VoucherInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { routes } from '../../api/routes.ts';
import { createZip } from '../../lib/zip.ts';
import { previewVoucher, setVoucherOptional } from '../vouchers/service.ts';
import { entryMap, save, setupKit, throwsApp, type Kit } from '../vouchers/testkit.ts';
import { table11 } from './advances.ts';
import { reconcileBoe } from './boeRecon.ts';
import { loadCompany } from './docs.ts';
import { computeGstr3b } from './gstr3b.ts';
import { parsePeriodKey } from './period.ts';

function receipt(k: Kit, amount = 11_800_00, over: Partial<VoucherInput> = {}): VoucherInput {
  return {
    voucherTypeId: k.vt.receipt,
    date: '2026-04-10',
    mode: 'ledger',
    ledgers: [
      { ledgerId: k.L.bank, amount },
      { ledgerId: k.L.acme, amount: -amount, billAllocations: [{ refType: 'advance', billName: 'ADV-1', amount }] },
    ],
    gstDetails: { advance: { supplyType: 'services', rate: 18 } },
    ...over,
  };
}

const invoiceAgainst = (k: Kit, date: string, against: number): VoucherInput => ({
  voucherTypeId: k.vt.sales,
  date,
  mode: 'accounting_invoice',
  partyLedgerId: k.L.acme,
  ledgers: [{ ledgerId: k.L.consult, amount: 20_000_00 }],
  partyBillAllocations: [
    { refType: 'against', billName: 'ADV-1', amount: against },
    { refType: 'new', billName: `INV-${date}`, amount: 23_600_00 - against },
  ],
});

const blocking = (k: Kit, input: VoucherInput): string[] =>
  previewVoucher(k.t.ctx, input)
    .warnings.filter((w) => w.blocking)
    .map((w) => w.message);

const advanceBalance = (k: Kit): number =>
  k.t.db.value<number>(`SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE ledger_id = (SELECT id FROM ledgers WHERE reserved_code = 'GST_ADVANCE')`) ?? 0;

describe('gstplus review: advances', () => {
  it('1. an advance already adjusted cannot be lowered, dropped, re-rated or made optional', () => {
    const k = setupKit({ today: '2026-06-15' });
    const r = save(k, receipt(k));
    // 11. The system ledger created on demand is in the audit trail.
    assert.ok(k.t.db.value(`SELECT 1 FROM audit_log WHERE action = 'create' AND entity_type = 'ledger' AND entity_label = 'GST on Advances Received'`));
    save(k, invoiceAgainst(k, '2026-05-05', 5_900_00)); // half the advance: 5,900 incl. tax
    assert.equal(advanceBalance(k), 900_00, 'Dr 1,800 on receipt − 900 reversed on the invoice');

    const lower = blocking(k, { ...receipt(k, 4_720_00), id: r.id });
    assert.ok(lower.some((m) => /cannot be reduced/.test(m)), lower.join(' | '));
    const dropped = { ...receipt(k), id: r.id };
    delete dropped.gstDetails;
    assert.ok(blocking(k, dropped).some((m) => /already adjust or refund/.test(m)));
    assert.ok(blocking(k, { ...receipt(k), id: r.id, gstDetails: { advance: { supplyType: 'services', rate: 5 } } }).some((m) => /rate and place of supply cannot change/.test(m)));
    assert.ok(blocking(k, { ...receipt(k), id: r.id, gstDetails: { advance: { supplyType: 'goods', rate: 0 } } }).some((m) => /already adjust or refund/.test(m)));
    throwsApp(() => setVoucherOptional(k.t.ctx, r.id, true, true), 'BUSINESS_RULE');
    assert.equal(advanceBalance(k), 900_00, 'nothing changed');

    // Raising the advance (or any change that keeps what was used) is fine: 23,600 → tax 3,600; 900 reversed.
    const raised = save(k, { ...receipt(k, 23_600_00), id: r.id });
    assert.equal(entryMap(k, raised.id)['GST on Advances Received'], 3_600_00);
    assert.equal(advanceBalance(k), 2_700_00);
    k.t.close();
  });

  it('2. refuses an advance larger than the amount received', () => {
    const k = setupKit({ today: '2026-06-15' });
    const msgs = blocking(k, receipt(k, 11_800_00, { gstDetails: { advance: { supplyType: 'services', rate: 18, amount: 50_000_00 } } }));
    assert.ok(msgs.some((m) => /more than the amount received/.test(m)), msgs.join(' | '));
    // A smaller part of the receipt as the advance is fine (the rest may settle an old bill).
    const ok = save(k, receipt(k, 11_800_00, { gstDetails: { advance: { supplyType: 'services', rate: 18, amount: 5_900_00 } } }));
    assert.equal(entryMap(k, ok.id)['GST on Advances Received'], 900_00);
    k.t.close();
  });

  it('3. Table 11 leaves out what is received and adjusted in the same period (only the unadjusted part is 11A)', () => {
    const k = setupKit({ today: '2026-07-15' });
    save(k, receipt(k, 11_800_00, { date: '2026-05-05' }));
    save(k, invoiceAgainst(k, '2026-05-20', 5_900_00));
    save(k, invoiceAgainst(k, '2026-06-10', 5_900_00));
    const may = table11(k.t.db, '2026-05-01', '2026-05-31', k.t.today, '27');
    // 11,800 received − 5,900 adjusted in May = 5,900 still unadjusted at the end of May: taxable 5,000, 450 + 450.
    assert.deepEqual(may.received.map((x) => [x.gross, x.taxable, x.cgst, x.sgst]), [[5_900_00, 5_000_00, 450_00, 450_00]]);
    assert.deepEqual(may.adjusted, [], 'adjusted in the period it was received: not 11B');
    assert.equal(may.vouchers.length, 2, 'the register still lists both');
    const june = table11(k.t.db, '2026-06-01', '2026-06-30', k.t.today, '27');
    assert.deepEqual([june.received, june.adjusted.map((x) => [x.taxable, x.cgst])], [[], [[5_000_00, 450_00]]]);
    // GSTR-3B 3.1(a) is unchanged by the netting (it adds 11A − 11B either way).
    const company = loadCompany(k.t.db);
    const m3b = computeGstr3b(k.t.db, company, parsePeriodKey('052026')!, k.t.today);
    const osup = m3b.supplies.find((s) => s.key === 'osup_det')!;
    // Invoice 20,000 / 1,800 / 1,800 + advance net (10,000 − 5,000 = 5,000 / 450 / 450).
    assert.deepEqual([osup.taxable, osup.cgst, osup.sgst], [25_000_00, 2_250_00, 2_250_00]);
    k.t.close();
  });
});

describe('gstplus review: set-off', () => {
  it('4. once posted, the set-off does not ask for the same cash again', async () => {
    const k = setupKit({ today: '2026-06-25' });
    save(k, { voucherTypeId: k.vt.sales, date: '2026-05-05', mode: 'accounting_invoice', partyLedgerId: k.L.acme, ledgers: [{ ledgerId: k.L.consult, amount: 10_000_00 }] });
    await k.t.callOk(routes, 'gst.challan.post', {
      date: '2026-06-15',
      bankLedgerId: k.L.bank,
      cpin: '26052700012345',
      period: '052026',
      heads: [
        { head: 'cgst', minor: 'tax', amount: 900_00 },
        { head: 'sgst', minor: 'tax', amount: 900_00 },
      ],
    });
    const before = await k.t.callOk<GstSetoffResult>(routes, 'gst.setoff.compute', { period: '052026' });
    assert.equal(before.toDepositTotal, 0);
    await k.t.callOk(routes, 'gst.setoff.post', { period: '052026', date: '2026-06-20' });
    const after = await k.t.callOk<GstSetoffResult>(routes, 'gst.setoff.compute', { period: '052026' });
    assert.ok(after.posted);
    assert.equal(after.toDepositTotal, 0, 'the deposit was used by this very set-off');
    assert.deepEqual(
      after.cash.filter((c) => c.total > 0).map((c) => [c.head, c.total, c.available]),
      [
        ['cgst', 900_00, 900_00],
        ['sgst', 900_00, 900_00],
      ],
    );
    k.t.close();
  });

  it('5. a set-off journal cannot use CGST credit for SGST (s.49(5))', () => {
    const k = setupKit({ today: '2026-06-25' });
    const msgs = blocking(k, {
      voucherTypeId: k.vt.journal,
      date: '2026-06-20',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.OUTPUT_SGST, amount: 100_00 },
        { ledgerId: k.L.INPUT_CGST, amount: -100_00 },
      ],
      gstDetails: { setoff: { period: '052026', cash: [], credit: [{ from: 'cgst', to: 'sgst', amount: 100_00 }] } },
    });
    assert.ok(msgs.some((m) => /CGST credit cannot be used to pay SGST/.test(m)), msgs.join(' | '));
    k.t.close();
  });

  it('10. a challan needs a well-formed return period', async () => {
    const k = setupKit({ today: '2026-06-25' });
    const bad = await k.t.call(routes, 'gst.challan.post', {
      date: '2026-06-15',
      bankLedgerId: k.L.bank,
      cpin: '26052700012345',
      period: 'May 2026',
      heads: [{ head: 'cgst', minor: 'tax', amount: 100_00 }],
    });
    assert.equal(!bad.ok && bad.error.code, 'VALIDATION');
    k.t.close();
  });
});

describe('gstplus review: amendments', () => {
  it('6. a change logged while the working date is still in the filed period goes to the next period, never a filed one', async () => {
    const k = setupKit({ today: '2026-05-31' });
    const s1 = await k.t.callOk<VoucherSaveResult>(routes, 'vouchers.save', {
      voucherTypeId: k.vt.sales,
      date: '2026-05-05',
      mode: 'accounting_invoice',
      partyLedgerId: k.L.acme,
      ledgers: [{ ledgerId: k.L.consult, amount: 10_000_00 }],
    });
    // Filed on the last day of May (allowed: the period has ended at the close of that day).
    await k.t.callOk(routes, 'gst.filing.mark', { form: 'gstr1', period: '052026', filedOn: '2026-05-31' });
    const d = await k.t.callOk<VoucherDetail>(routes, 'vouchers.get', { id: s1.id });
    await k.t.callOk(routes, 'vouchers.save', { ...d.input, ledgers: [{ ledgerId: k.L.consult, amount: 12_000_00 }], acknowledgeWarnings: true });
    const log = await k.t.callOk<GstAmendmentRow[]>(routes, 'gst.amendments.list', {});
    assert.deepEqual(log.map((a) => [a.originalPeriod, a.amendPeriod]), [['052026', '062026']]);
    k.t.close();
  });
});

describe('gstplus review: imports and the credit ledger', () => {
  it('7. reconciles bills of entry from a GSTR-2B ZIP of JSON parts', () => {
    const k = setupKit({ today: '2026-06-15' });
    const overseas = k.t.addLedger({ name: 'Shenzhen Tools Co', group: 'SUNDRY_CREDITORS', registrationType: 'overseas', columns: { country: 'China', state_code: null } });
    save(k, {
      voucherTypeId: k.vt.purchase,
      date: '2026-05-10',
      mode: 'item_invoice',
      partyLedgerId: overseas,
      referenceNo: 'SZ-77',
      items: [{ itemId: k.I.mixer, qty: 10, rate: 1000 }],
      gstDetails: { billOfEntry: { number: '4567890', date: '2026-05-10', portCode: 'INNSA1', assessableValue: 11_000_00, igst: 2_197_80 } },
    });
    const part = (impg: unknown[]) => JSON.stringify({ data: { rtnprd: '052026', docdata: { impg } } });
    const zip = createZip([
      { name: 'GSTR2B_part1.json', data: part([{ portcode: 'INNSA1', boenum: '4567890', boedt: '10-05-2026', txval: 12210, igst: 2197.8, cess: 0 }]) },
      { name: 'GSTR2B_part2.json', data: part([{ portcode: 'INMAA1', boenum: '1111111', boedt: '18-05-2026', txval: 5000, igst: 900, cess: 0 }]) },
    ]);
    const rec = reconcileBoe(k.t.db, zip, '2026-05-01', '2026-05-31', k.t.today);
    assert.deepEqual(rec.counts, { matched: 1, mismatch: 0, missing_in_books: 1, missing_in_portal: 0 });
    assert.equal(rec.period, '052026');
    k.t.close();
  });

  it('9. a bill of entry on blocked goods is a cost, shown in 4(A)(1) and reversed in 4(B)(1)', () => {
    const k = setupKit({ today: '2026-06-15' });
    const overseas = k.t.addLedger({ name: 'Stuttgart Motors', group: 'SUNDRY_CREDITORS', registrationType: 'overseas', columns: { country: 'Germany', state_code: null } });
    const car = k.t.addLedger({ name: 'Motor Car (imported)', group: 'FIXED_ASSETS', gstRate: 28, hsnSac: '8703', supplyType: 'goods', columns: { itc_eligibility: 'ineligible' } });
    const blocked = save(k, {
      voucherTypeId: k.vt.purchase,
      date: '2026-05-12',
      mode: 'accounting_invoice',
      partyLedgerId: overseas,
      referenceNo: 'ST-1',
      ledgers: [{ ledgerId: car, amount: 10_000_00 }],
      gstDetails: { billOfEntry: { number: '7654321', date: '2026-05-12', portCode: 'INNSA1', assessableValue: 11_000_00, igst: 3_080_00 } },
    });
    const e = entryMap(k, blocked.id);
    assert.equal(e['Input IGST'], undefined, 'no credit for blocked goods');
    assert.equal(e['Motor Car (imported)'], 13_080_00, 'invoice 10,000 + IGST 3,080 capitalised');
    assert.equal(e['IGST Payable on Imports (Customs)'], -3_080_00);
    const s = computeGstr3b(k.t.db, loadCompany(k.t.db), parsePeriodKey('052026')!, k.t.today) as Gstr3bSummary;
    const impg = s.itc.available.find((r) => r.ty === 'IMPG')!;
    const rul = s.itc.reversed.find((r) => r.row === '4(B)(1)')!;
    assert.deepEqual([impg.igst, rul.igst, s.itc.net.igst], [3_080_00, 3_080_00, 0]);
    k.t.close();
  });

  it('9b. a bill of entry cannot mix blocked and eligible lines', () => {
    const k = setupKit({ today: '2026-06-15' });
    const overseas = k.t.addLedger({ name: 'Stuttgart Motors', group: 'SUNDRY_CREDITORS', registrationType: 'overseas', columns: { country: 'Germany', state_code: null } });
    const car = k.t.addLedger({ name: 'Motor Car (imported)', group: 'FIXED_ASSETS', gstRate: 28, hsnSac: '8703', supplyType: 'goods', columns: { itc_eligibility: 'ineligible' } });
    const parts = k.t.addLedger({ name: 'Imported Spares', group: 'PURCHASE_ACCOUNTS', gstRate: 18, hsnSac: '8708', supplyType: 'goods' });
    const msgs = blocking(k, {
      voucherTypeId: k.vt.purchase,
      date: '2026-05-12',
      mode: 'accounting_invoice',
      partyLedgerId: overseas,
      referenceNo: 'ST-2',
      ledgers: [
        { ledgerId: car, amount: 10_000_00 },
        { ledgerId: parts, amount: 1_000_00 },
      ],
      gstDetails: { billOfEntry: { number: '7654322', date: '2026-05-12', assessableValue: 11_000_00, igst: 3_000_00 } },
    });
    assert.ok(msgs.some((m) => /separate purchase/.test(m)), msgs.join(' | '));
    k.t.close();
  });

  it('8. credit ledger transactions are signed so their total is closing − opening', async () => {
    const k = setupKit({ today: '2026-06-30' });
    // Purchase 10,000 @5% intra → Input CGST 250 + SGST 250; Rule 42 reversal 50 + 50.
    save(k, { voucherTypeId: k.vt.purchase, date: '2026-05-07', mode: 'item_invoice', partyLedgerId: k.L.supplier, referenceNo: 'S-1', items: [{ itemId: k.I.rice, qty: 100, rate: 100 }] });
    save(k, {
      voucherTypeId: k.vt.journal,
      date: '2026-05-31',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.rent, amount: 100_00 },
        { ledgerId: k.L.INPUT_CGST, amount: -50_00 },
        { ledgerId: k.L.INPUT_SGST, amount: -50_00 },
      ],
      gstDetails: { adjustment: { nature: 'itc_reversal_r42' } },
    });
    const l = await k.t.callOk<ElectronicCreditLedger>(routes, 'gst.ledger.credit', { from: '2026-05-01', to: '2026-05-31' });
    const cg = l.rows.find((r) => r.head === 'cgst')!;
    assert.deepEqual([cg.opening, cg.accrued, cg.reversed, cg.closing], [0, 250_00, 50_00, 200_00]);
    const sum = l.transactions.reduce((s, t) => s + t.cgst, 0);
    assert.equal(sum, cg.closing - cg.opening);
    assert.deepEqual(
      l.transactions.map((t) => [t.kind, t.cgst]),
      [
        ['accrued', 250_00],
        ['reversed', -50_00],
      ],
    );
    // Opening of the next period = this closing (aggregated, not replayed entry by entry).
    const june = await k.t.callOk<ElectronicCreditLedger>(routes, 'gst.ledger.credit', { from: '2026-06-01', to: '2026-06-30' });
    assert.equal(june.rows.find((r) => r.head === 'cgst')!.opening, 200_00);
    k.t.close();
  });
});
