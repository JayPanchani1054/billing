/**
 * XML data round trip of GST on advances (found by the cross-feature tie-out, all-features-year.test.ts):
 * the gst module posts an advance for services as Dr "GST on Advances Received" / Cr Output tax on the
 * receipt, and the invoice adjusting it as Dr Output tax / Cr "GST on Advances Received". The export writes
 * both as recorded; the importer used to net the invoice's Output debits into its own tax (GSTR-1 showed
 * ₹1,800 − ₹900 = ₹900 on a ₹10,000 invoice) and lost Table 11A / 11B. It now recovers the advance.
 *
 * Figures (intra-state, CGST = SGST = 9%): advance ₹5,900 incl. tax (May) → taxable ₹5,000, CGST ₹450,
 * SGST ₹450; invoice 10-Jun ₹10,000 + CGST ₹900 + SGST ₹900 = ₹11,800, ₹5,900 against the advance.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Gstr1Summary, Gstr3bSummary } from '../../../shared/types/gst-returns.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { readZip } from '../../lib/zip.ts';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { gstRoutes } from '../gst/routes.ts';
import { getVoucher } from '../vouchers/queries.ts';
import { saveVoucher } from '../vouchers/service.ts';
import { save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { exportXml } from './xmlExport.ts';
import { importXml } from './xmlImport.ts';

const FROM = '2026-04-01';
const TO = '2027-03-31';
let k: Kit;
let target: TestCompany | null = null;
beforeEach(() => {
  k = setupKit({ name: 'Advance Traders', today: '2026-06-30', booksFrom: FROM });
});
afterEach(() => {
  k.t.close();
  target?.close();
  target = null;
});

function populate(): void {
  const { vt, L } = k;
  save(k, {
    voucherTypeId: vt.receipt,
    date: '2026-05-05',
    mode: 'ledger',
    ledgers: [
      { ledgerId: L.bank, amount: 5_900_00 },
      { ledgerId: L.acme, amount: -5_900_00, billAllocations: [{ refType: 'advance', billName: 'ADV-1', amount: 5_900_00 }] },
    ],
    gstDetails: { advance: { supplyType: 'services', rate: 18 } },
  } as VoucherInput);
  save(k, {
    voucherTypeId: vt.sales,
    date: '2026-06-10',
    mode: 'accounting_invoice',
    partyLedgerId: L.acme,
    ledgers: [{ ledgerId: L.consult, amount: 10_000_00 }],
    partyBillAllocations: [
      { refType: 'against', billName: 'ADV-1', amount: 5_900_00 },
      { refType: 'new', billName: 'INV-1', amount: 5_900_00 },
    ],
  });
}

async function roundTrip(): Promise<TestCompany> {
  const file = await exportXml(k.t.ctx, { masters: true, vouchers: true, from: FROM, to: TO });
  const zip = readZip(file.bytes);
  target = createTestCompany({ name: 'Advance Traders', today: '2026-06-30', booksFrom: FROM });
  await importXml(target.ctx, { fileName: '1-Masters.xml', bytes: zip.read('1-Masters.xml'), options: { masters: true, vouchers: false, onDuplicate: 'skip' } });
  const r = await importXml(target.ctx, { fileName: '2-Vouchers.xml', bytes: zip.read('2-Vouchers.xml'), options: { masters: false, vouchers: true, onDuplicate: 'skip' } });
  assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), []);
  return target;
}

const pick = (g: Gstr1Summary) => ({
  totals: [g.totals.taxable, g.totals.cgst, g.totals.sgst],
  received: g.advances?.received.map((x) => [x.pos, x.rate, x.taxable, x.cgst, x.sgst]) ?? [],
  adjusted: g.advances?.adjusted.map((x) => [x.pos, x.rate, x.taxable, x.cgst, x.sgst]) ?? [],
});

describe('XML data round trip: GST on advances', () => {
  it('the invoice keeps its own tax and Table 11A / 11B come back (GSTR-1, GSTR-3B)', async () => {
    populate();
    const tg = await roundTrip();
    for (const period of ['052026', '062026']) {
      const a = await k.t.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period });
      const b = await tg.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period });
      assert.deepEqual(pick(b), pick(a), `GSTR-1 ${period}`);
      const a3 = await k.t.callOk<Gstr3bSummary>(gstRoutes, 'gst.gstr3b.summary', { period });
      const b3 = await tg.callOk<Gstr3bSummary>(gstRoutes, 'gst.gstr3b.summary', { period });
      assert.deepEqual(b3.supplies, a3.supplies, `GSTR-3B ${period}`);
    }
    // By hand: May 11A 5,000 / 450 / 450; June the invoice 10,000 / 900 / 900 and 11B 5,000 / 450 / 450.
    const may = pick(await tg.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period: '052026' }));
    assert.deepEqual(may.received, [['27', 18, 5_000_00, 450_00, 450_00]]);
    const june = await tg.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period: '062026' });
    assert.deepEqual(june.sections.find((s) => s.id === 'b2b') && [june.sections.find((s) => s.id === 'b2b')?.taxable, june.sections.find((s) => s.id === 'b2b')?.cgst], [10_000_00, 900_00]);
    assert.deepEqual(pick(june).adjusted, [['27', 18, 5_000_00, 450_00, 450_00]]);
    // The system ledger was adopted (reserved code), not duplicated as "(System)".
    assert.equal(tg.db.value(`SELECT COUNT(*) FROM ledgers WHERE name LIKE 'GST on Advances Received%'`), 1);
    assert.equal(tg.db.value(`SELECT reserved_code FROM ledgers WHERE name = 'GST on Advances Received'`), 'GST_ADVANCE');
  });

  it('a refund of part of an advance (Payment) comes back as a refund in Table 11B and can be altered', async () => {
    // Advance ₹5,900 (May); refund ₹2,360 on 12-Jun → taxable ₹2,000, CGST ₹180, SGST ₹180 reversed.
    const { vt, L } = k;
    const receipt = save(k, {
      voucherTypeId: vt.receipt,
      date: '2026-05-05',
      mode: 'ledger',
      ledgers: [
        { ledgerId: L.bank, amount: 5_900_00 },
        { ledgerId: L.acme, amount: -5_900_00, billAllocations: [{ refType: 'advance', billName: 'ADV-1', amount: 5_900_00 }] },
      ],
      gstDetails: { advance: { supplyType: 'services', rate: 18 } },
    } as VoucherInput);
    save(k, {
      voucherTypeId: vt.payment,
      date: '2026-06-12',
      mode: 'ledger',
      ledgers: [
        { ledgerId: L.acme, amount: 2_360_00, billAllocations: [{ refType: 'against', billName: 'ADV-1', amount: 2_360_00 }] },
        { ledgerId: L.bank, amount: -2_360_00 },
      ],
      gstDetails: { advanceRefund: { receiptVoucherId: receipt.id, amount: 2_360_00 } },
    } as VoucherInput);
    const tg = await roundTrip();
    for (const period of ['052026', '062026']) {
      assert.deepEqual(
        pick(await tg.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period })),
        pick(await k.t.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period })),
        `GSTR-1 ${period}`,
      );
      assert.deepEqual(
        (await tg.callOk<Gstr3bSummary>(gstRoutes, 'gst.gstr3b.summary', { period })).supplies,
        (await k.t.callOk<Gstr3bSummary>(gstRoutes, 'gst.gstr3b.summary', { period })).supplies,
        `GSTR-3B ${period}`,
      );
    }
    assert.deepEqual(pick(await tg.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period: '062026' })).adjusted, [['27', 18, 2_000_00, 180_00, 180_00]]);
    const rows = tg.db.all<{ kind: string; voucher_id: number; receipt_voucher_id: number; party_ledger_id: number | null; gross: number }>(
      `SELECT kind, voucher_id, receipt_voucher_id, party_ledger_id, gross FROM gst_advance_lines ORDER BY id`,
    );
    assert.deepEqual(rows.map((r) => [r.kind, r.gross]), [['received', 5_900_00], ['refunded', 2_360_00]]);
    assert.equal(rows[1].receipt_voucher_id, rows[0].voucher_id, 'the refund is linked to its advance receipt');
    assert.equal(rows[1].party_ledger_id, rows[0].party_ledger_id);
    assert.notEqual(rows[0].party_ledger_id, null);
    // The stored input carries the refund as GST details: re-saving it posts the same entries.
    const refund = getVoucher(tg.db, rows[1].voucher_id);
    assert.deepEqual(refund.input.gstDetails, { advanceRefund: { receiptVoucherId: rows[0].voucher_id, amount: 2_360_00 } });
    const entries = () => tg.db.all(`SELECT ledger_id, SUM(amount) AS amount FROM ledger_entries WHERE voucher_id = :id GROUP BY ledger_id ORDER BY ledger_id`, { id: rows[1].voucher_id });
    const before = entries();
    saveVoucher(tg.ctx, { ...refund.input, id: rows[1].voucher_id, narration: 'altered', acknowledgeWarnings: true });
    assert.deepEqual(entries(), before);
  });

  it('importing the same file again with "update existing" replaces the advance rows instead of adding a second set', async () => {
    populate();
    const tg = await roundTrip();
    const rows = () => tg.db.all(`SELECT kind, pos, rate, gross, taxable_value, cgst, sgst FROM gst_advance_lines ORDER BY kind, voucher_id`);
    const before = rows();
    assert.equal(before.length, 2, 'one received, one adjusted');
    const g1 = pick(await tg.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period: '062026' }));
    const file = await exportXml(k.t.ctx, { masters: true, vouchers: true, from: FROM, to: TO });
    const r = await importXml(tg.ctx, { fileName: '2-Vouchers.xml', bytes: readZip(file.bytes).read('2-Vouchers.xml'), options: { masters: false, vouchers: true, onDuplicate: 'update' } });
    assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), []);
    assert.equal(r.vouchers.updated, 2, 'both vouchers refreshed');
    assert.deepEqual(rows(), before, 'still one received and one adjusted row (May 11A 5,000; June 11B 5,000)');
    assert.deepEqual(pick(await tg.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period: '062026' })), g1);
  });

  it('an imported advance receipt / invoice can be altered: their GST details were rebuilt, not their raw tax lines', async () => {
    populate();
    const tg = await roundTrip();
    const receiptId = tg.db.value<number>(`SELECT voucher_id FROM gst_advance_lines WHERE kind = 'received'`) as number;
    const salesId = tg.db.value<number>(`SELECT voucher_id FROM gst_advance_lines WHERE kind = 'adjusted'`) as number;
    const receipt = getVoucher(tg.db, receiptId);
    assert.deepEqual(receipt.input.gstDetails, { advance: { supplyType: 'services', rate: 18, placeOfSupply: '27', amount: 5_900_00 } });
    assert.equal(receipt.input.ledgers?.length, 2, 'bank and party only: the hook posts the advance tax');
    const sales = getVoucher(tg.db, salesId);
    assert.deepEqual(sales.input.gstDetails, { advanceAdjustments: [{ receiptVoucherId: receiptId, amount: 5_900_00 }] });
    // Re-saving both (as the voucher screen would) keeps the books, the advance lines and the returns unchanged.
    const before = await tg.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period: '062026' });
    const entries = (id: number) => tg.db.all(`SELECT ledger_id, SUM(amount) AS amount FROM ledger_entries WHERE voucher_id = :id GROUP BY ledger_id ORDER BY ledger_id`, { id });
    const e1 = entries(receiptId);
    const e2 = entries(salesId);
    saveVoucher(tg.ctx, { ...receipt.input, id: receiptId, narration: 'altered', acknowledgeWarnings: true });
    saveVoucher(tg.ctx, { ...getVoucher(tg.db, salesId).input, id: salesId, narration: 'altered', acknowledgeWarnings: true });
    assert.deepEqual(entries(receiptId), e1);
    assert.deepEqual(entries(salesId), e2);
    assert.deepEqual(pick(await tg.callOk<Gstr1Summary>(gstRoutes, 'gst.gstr1.summary', { period: '062026' })), pick(before));
  });
});
