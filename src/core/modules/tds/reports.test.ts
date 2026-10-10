/**
 * TDS/TCS reports through the real dispatcher: challans (clearing by month), outstanding with
 * interest u/s 201(1A), statements and late fee u/s 234E, computation, quarterly return data + CSV,
 * exceptions, and TDS receivable vs Form 26AS.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  TdsChallanRegister,
  TdsChallanSuggestion,
  TdsComputationResult,
  TdsExceptionRow,
  TdsLineRow,
  TdsOutstandingResult,
  TdsReceivableResult,
  TdsReturnData,
} from '../../../shared/types/tds.ts';
import type { VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { vouchersRoutes } from '../vouchers/routes.ts';
import { tdsRoutes } from './routes.ts';
import { journal, purchase, save, setupTds, type TdsKit } from './testkit.ts';

const R = { ...vouchersRoutes, ...tdsRoutes };
const P = (rupees: number): number => Math.round(rupees * 100);

/**
 * April 2026: 194C ₹800 (20-Apr) and 194J(b) ₹6,000 (25-Apr, advance payment).
 * June 2026: 194C ₹1,250 (10-Jun, aggregate crossed).
 */
function scenario(k: TdsKit): void {
  save(k, purchase(k, '2026-04-20', k.L.contractor, k.L.contractExp, P(40_000), 'SC-1'));
  save(k, {
    voucherTypeId: k.vt.payment,
    date: '2026-04-25',
    mode: 'ledger',
    ledgers: [
      { ledgerId: k.L.prof, amount: P(60_000) },
      { ledgerId: k.L.bank, amount: -P(60_000) },
    ],
    tds: { natureId: k.N['194J(b)'] },
  });
  for (const d of ['2026-04-10', '2026-05-10', '2026-06-01', '2026-06-05', '2026-06-10']) save(k, journal(k, d, k.L.labourExp, k.L.labour, P(25_000)));
}

const challan = (section: string, period: string, depositDate: string, tax: number, interest = 0) => ({
  kind: 'tds' as const,
  section,
  period,
  bsrCode: '0510001',
  challanNo: '12345',
  depositDate,
  tax,
  interest,
});

describe('tds reports', () => {
  it('challan: suggestion, payment voucher, clearing on time and late, interest u/s 201(1A)', async () => {
    const k = setupTds();
    scenario(k);
    // 194C April: ₹800 unpaid, due 7-May; deposited on time.
    const s = await k.t.callOk<TdsChallanSuggestion>(R, 'tds.challan.suggest', { kind: 'tds', section: '194C', period: '2026-04', depositDate: '2026-05-07' });
    assert.deepEqual({ unpaid: s.unpaid, interest: s.interest, due: s.dueDate }, { unpaid: P(800), interest: 0, due: '2026-05-07' });
    const c1 = await k.t.callOk<VoucherSaveResult>(R, 'tds.challan.save', {
      date: '2026-05-07',
      bankLedgerId: k.L.bank,
      challan: challan('194C', '2026-04', '2026-05-07', P(800)),
    });
    const e1 = k.t.db.all<{ name: string; amount: number }>('SELECT l.name, le.amount FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id WHERE voucher_id = :id', { id: c1.id });
    assert.deepEqual(e1, [
      { name: 'TDS Payable – 194C', amount: P(800) },
      { name: 'HDFC Bank', amount: -P(800) },
    ]);
    // 194J(b) April ₹6,000 paid late on 20-May: April + May = 2 months × 1.5% × 6,000 = ₹180.
    const s2 = await k.t.callOk<TdsChallanSuggestion>(R, 'tds.challan.suggest', { kind: 'tds', section: '194J(b)', period: '2026-04', depositDate: '2026-05-20' });
    assert.deepEqual({ unpaid: s2.unpaid, interest: s2.interest }, { unpaid: P(6_000), interest: P(180) });
    const c2 = await k.t.callOk<VoucherSaveResult>(R, 'tds.challan.save', {
      date: '2026-05-20',
      bankLedgerId: k.L.bank,
      challan: { ...challan('194J(b)', '2026-04', '2026-05-20', P(6_000), P(180)), challanNo: '22222' },
    });
    const e2 = k.t.db.all<{ name: string; amount: number }>('SELECT l.name, le.amount FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id WHERE voucher_id = :id ORDER BY line_no', { id: c2.id });
    assert.deepEqual(e2.map((x) => [x.name, x.amount]), [
      ['TDS Payable – 194J(b)', P(6_000)],
      ['Interest on TDS / TCS (late payment)', P(180)],
      ['HDFC Bank', -P(6_180)],
    ]);

    // Outstanding as of 20-Jul: June 194C ₹1,250 overdue since 7-Jul: June + July = 2 × 1.5% × 1,250 = ₹37.50 → ₹38.
    const o = await k.t.callOk<TdsOutstandingResult>(R, 'tds.outstanding', { asOf: '2026-07-20', kind: 'tds', includeSettled: true });
    const row = (section: string, period: string) => o.rows.find((r) => r.section === section && r.period === period);
    assert.deepEqual(
      { bal: row('194C', '2026-04')?.balance, status: row('194C', '2026-04')?.status, int: row('194C', '2026-04')?.interest },
      { bal: 0, status: 'paid', int: 0 },
    );
    assert.deepEqual(
      { status: row('194J(b)', '2026-04')?.status, int: row('194J(b)', '2026-04')?.interest, paid: row('194J(b)', '2026-04')?.interestPaid },
      { status: 'paid_late', int: P(180), paid: P(180) },
    );
    assert.deepEqual(
      { bal: row('194C', '2026-06')?.balance, status: row('194C', '2026-06')?.status, days: row('194C', '2026-06')?.daysOverdue, int: row('194C', '2026-06')?.interest },
      { bal: P(1_250), status: 'overdue', days: 13, int: P(38) },
    );
    // Without includeSettled only open rows are listed.
    const open = await k.t.callOk<TdsOutstandingResult>(R, 'tds.outstanding', { asOf: '2026-07-20', kind: 'tds' });
    assert.deepEqual(open.rows.map((r) => `${r.section} ${r.period}`), ['194C 2026-06']);

    // 26Q Q1 2026-27 due 31-Jul; on 10-Aug, not filed: 10 days × ₹200 = ₹2,000 (tax ₹8,050 is the cap).
    const late = await k.t.callOk<TdsOutstandingResult>(R, 'tds.outstanding', { asOf: '2026-08-10', kind: 'tds' });
    const q1 = late.statements.find((x) => x.form === '26Q' && x.quarter === 1 && x.fyStart === 2026);
    assert.deepEqual({ due: q1?.dueDate, tax: q1?.tax, fee: q1?.lateFee, status: q1?.status }, { due: '2026-07-31', tax: P(8_050), fee: P(2_000), status: 'overdue' });
    // Filed on 5-Aug: 5 days late = ₹1,000.
    await k.t.callOk(R, 'tds.statement.save', { form: '26Q', fyStart: 2026, quarter: 1, filedOn: '2026-08-05', tokenNo: '123456789012345' });
    const filed = await k.t.callOk<TdsOutstandingResult>(R, 'tds.outstanding', { asOf: '2026-08-10', kind: 'tds' });
    assert.equal(filed.statements.find((x) => x.form === '26Q')?.lateFee, P(1_000));

    // Challan register: two challans, both fully used.
    const reg = await k.t.callOk<TdsChallanRegister>(R, 'tds.challans', { from: '2026-04-01', to: '2026-06-30', kind: 'tds' });
    assert.deepEqual(reg.rows.map((r) => [r.section, r.cleared, r.unconsumed, r.late]), [
      ['194C', P(800), 0, false],
      ['194J(b)', P(6_000), 0, true],
    ]);
    assert.equal(reg.totals.total, P(6_980));

    // Altering the challan voucher through the helper keeps one challan row; cancelling removes it.
    const got = await k.t.callOk<{ challan: { tax: number }; updatedAt: string }>(R, 'tds.challan.get', { voucherId: c1.id });
    assert.equal(got.challan.tax, P(800));
    await k.t.callOk(R, 'tds.challan.save', {
      voucherId: c1.id,
      date: '2026-05-07',
      bankLedgerId: k.L.bank,
      challan: { ...challan('194C', '2026-04', '2026-05-07', P(800)), challanNo: '54321' },
      expectedUpdatedAt: got.updatedAt,
    });
    assert.equal(k.t.db.value<string>('SELECT challan_no FROM tds_challans WHERE voucher_id = :id', { id: c1.id }), '54321');
    await k.t.callOk(R, 'vouchers.cancel', { id: c1.id, reason: 'Wrong challan' });
    assert.equal(k.t.db.value('SELECT COUNT(*) FROM tds_challans WHERE voucher_id = :id', { id: c1.id }), 0);
    k.t.close();
  });

  it('computation and drill-down lines per party and section', async () => {
    const k = setupTds();
    scenario(k);
    const c = await k.t.callOk<TdsComputationResult>(R, 'tds.computation', { from: '2026-04-01', to: '2026-06-30', kind: 'tds' });
    const labour = c.rows.find((r) => r.partyName === 'Ramesh Labour');
    // Credited 5 × 25,000 = 1,25,000; below threshold when entered: 4 × 25,000; base 1,25,000; deducted ₹1,250.
    assert.deepEqual(
      { count: labour?.count, credited: labour?.credited, below: labour?.belowThreshold, base: labour?.base, deducted: labour?.deducted, balance: labour?.balance },
      { count: 5, credited: P(1_25_000), below: P(1_00_000), base: P(1_25_000), deducted: P(1_250), balance: P(1_250) },
    );
    assert.equal(c.totals.deducted, P(8_050));
    const lines = await k.t.callOk<TdsLineRow[]>(R, 'tds.lines', { from: '2026-04-01', to: '2026-06-30', partyLedgerId: k.L.labour });
    assert.equal(lines.length, 5);
    assert.equal(lines[4].dueDate, '2026-07-07');
    k.t.close();
  });

  it('quarterly return data (26Q) with deductee + challan rows and the CSV export (audited)', async () => {
    const k = setupTds();
    scenario(k);
    await k.t.callOk(R, 'tds.challan.save', { date: '2026-05-07', bankLedgerId: k.L.bank, challan: challan('194C', '2026-04', '2026-05-07', P(500)) });
    const d = await k.t.callOk<TdsReturnData>(R, 'tds.return.data', { form: '26Q', fyStart: 2026, quarter: 1 });
    // 194C ₹800 split: ₹500 paid with challan 1 (base 40,000 × 500/800 = 25,000) + ₹300 not deposited (base 15,000).
    const sc = d.deductees.filter((x) => x.name === 'Sharma Contractors');
    assert.deepEqual(
      sc.map((x) => [x.challanSr, x.amountPaid, x.tax, x.deposited, x.deducteeCode, x.pan]),
      [
        [1, P(25_000), P(500), P(500), '02', 'ABCFS1234C'],
        [null, P(15_000), P(300), 0, '02', 'ABCFS1234C'],
      ],
    );
    assert.equal(d.challans.length, 1);
    assert.equal(d.challans[0].allocated, P(500));
    assert.ok(d.warnings.some((w) => /has not been deposited/.test(w)));
    assert.equal(d.totals.tax, P(8_050));
    const csv = await k.t.callOk<{ fileName: string; content: string; rows: number }>(R, 'tds.return.export', { form: '26Q', fyStart: 2026, quarter: 1, part: 'deductees' });
    assert.match(csv.fileName, /_26Q_Q1_2026-27_deductees\.csv$/);
    assert.equal(csv.rows, d.deductees.length);
    const head = csv.content.replace(/^﻿/, '').split('\r\n')[0];
    assert.match(head, /^Sr\. No\.,Challan Sr\. No\.,BSR Code,Date of Deposit/);
    assert.match(csv.content, /ABCFS1234C,Sharma Contractors,20\/04\/2026,25000\.00,500\.00/);
    assert.ok(k.t.db.value(`SELECT 1 FROM audit_log WHERE action = 'export' AND entity_type = 'tds_return'`));
    // Exporting needs tds.file.
    const r = await k.t.call(R, 'tds.return.export', { form: '26Q', fyStart: 2026, quarter: 1, part: 'challans' }, { session: k.t.sessionAs({ permissions: ['tds.view'] }) });
    assert.equal(r.ok, false);
    k.t.close();
  });

  it('exceptions: no PAN, not deducted after an override, threshold crossed but credits never taken in', async () => {
    const k = setupTds();
    save(k, purchase(k, '2026-05-02', k.L.noPan, k.L.labourExp, P(50_000), 'UC-1'));
    save(k, purchase(k, '2026-04-22', k.L.contractor, k.L.contractExp, P(40_000), 'SC-9', { tds: { overrides: [{ natureId: k.N['194C'], amount: 0, reason: 'Oversight' }] } }));
    // Out of date order: the big bill is entered first (no catch-up then), the small earlier ones after it.
    save(k, journal(k, '2026-06-10', k.L.labourExp, k.L.labour, P(90_000)));
    save(k, journal(k, '2026-04-10', k.L.labourExp, k.L.labour, P(20_000)));
    const ex = await k.t.callOk<TdsExceptionRow[]>(R, 'tds.exceptions', { from: '2026-04-01', to: '2026-06-30', kind: 'tds' });
    const types = ex.map((e) => e.type).sort();
    assert.deepEqual(types, ['no_pan', 'not_deducted', 'threshold_not_deducted']);
    const nd = ex.find((e) => e.type === 'not_deducted');
    // ₹800 not deducted from 22-Apr; today 15-Jun → Apr, May, Jun = 3 × 1% × 800 = ₹24.
    assert.deepEqual({ shortfall: nd?.shortfall, interest: nd?.interest }, { shortfall: P(800), interest: P(24) });
    const th = ex.find((e) => e.type === 'threshold_not_deducted');
    // ₹20,000 never taken in × 1% (individual) = ₹200.
    assert.equal(th?.shortfall, P(200));
    k.t.close();
  });

  it('TDS receivable vs Form 26AS (CSV import, match by TAN, unmatched rows)', async () => {
    const k = setupTds();
    const { ledgerId: tdsRec } = await k.t.callOk<{ ledgerId: number }>(R, 'tds.receivableLedger.ensure', {});
    await k.t.callOk(R, 'tds.ledgers.save', { ledgerId: k.L.customer, applicable: false, deductorTan: 'MUMA12345B' });
    save(k, {
      voucherTypeId: k.vt.receipt,
      date: '2026-05-05',
      mode: 'ledger',
      ledgers: [
        { ledgerId: k.L.bank, amount: P(98_000) },
        { ledgerId: tdsRec, amount: P(2_000) },
        { ledgerId: k.L.customer, amount: -P(1_00_000) },
      ],
    });
    const csv = [
      'TAN of Deductor,Name of Deductor,Section,Transaction Date,Amount Paid/Credited,Tax Deducted',
      'MUMA12345B,ACME BUYER LIMITED,194C,20-Apr-2026,"1,00,000.00",2000',
      'DELA99999Z,Other Co,194J,01/05/2026,50000,5000',
      'DELA99999Z,Other Co,194J,01/05/2025,50000,5000',
    ].join('\n');
    const imp = await k.t.callOk<{ imported: number; outsideYear: number }>(R, 'tds.26as.import', { fyStart: 2026, content: csv });
    assert.deepEqual(imp, { imported: 2, outsideYear: 1 });
    const rec = await k.t.callOk<TdsReceivableResult>(R, 'tds.receivable', { fyStart: 2026 });
    assert.deepEqual(
      rec.rows.map((r) => [r.partyName, r.books, r.form26as, r.status]),
      [
        ['Acme Buyer Ltd', P(2_000), P(2_000), 'matched'],
        ['Other Co', 0, P(5_000), 'form26as_only'],
      ],
    );
    assert.equal(rec.totals.difference, P(5_000));
    // A bad file is refused with row numbers.
    const bad = await k.t.call(R, 'tds.26as.import', { fyStart: 2026, content: 'TAN,Name,Transaction Date,Tax Deducted\nXX,Foo,31-02-2026,abc' });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.error.message, /fields are invalid|Row 2/);
    k.t.close();
  });

  it('routes refuse when the feature is off and need the TDS permissions', async () => {
    const k = setupTds({ features: { tds: false, tcs: true } });
    const off = await k.t.call(R, 'tds.outstanding', { asOf: '2026-06-15', kind: 'tds' });
    assert.equal(off.ok, false);
    if (!off.ok) assert.match(off.error.message, /F11/);
    const tcs = await k.t.call(R, 'tds.outstanding', { asOf: '2026-06-15', kind: 'tcs' });
    assert.equal(tcs.ok, true);
    const denied = await k.t.call(R, 'tds.natures.save', { kind: 'tcs', name: 'X', section: '206C(1)', rates: [] }, { session: k.t.sessionAs({ permissions: ['tds.view'] }) });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN');
    k.t.close();
  });
});
