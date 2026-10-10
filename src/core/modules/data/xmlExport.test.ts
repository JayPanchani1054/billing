/**
 * Tally XML export ('data.xmlExport.create'): value formats, the file shape, permissions / audit, and the
 * ROUND TRIP — a company with GST invoices (intra- and inter-state), purchases, bill-wise receipts,
 * bank instruments, cost centres, a godown transfer, opening balances / bills / stock and aliases is
 * exported, the two XML files are imported by our own Tally importer into an EMPTY company, and the
 * trial balance, the stock summary, the GST totals, the pending bills and the aliases come out the same.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { XmlExportResult, XmlImportResult } from '../../../shared/types/data.ts';
import type { TrialBalanceResult } from '../../../shared/types/reports.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import type { StockSummaryResult } from '../../../shared/types/stock.ts';
import { AppError } from '../../lib/errors.ts';
import { allAliases, extraAliases, writeExtraAliases } from '../../lib/masterAliases.ts';
import { readZip } from '../../lib/zip.ts';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { saveCostCentre } from '../accounts/costCentres.ts';
import { saveGroup } from '../accounts/groups.ts';
import { saveGodown } from '../inventory/masters.ts';
import { gstRoutes } from '../gst/routes.ts';
import { reportsRoutes } from '../reports/routes.ts';
import { stockRoutes } from '../stock/routes.ts';
import { cancelVoucher } from '../vouchers/service.ts';
import { save, setupKit, type Kit } from '../vouchers/testkit.ts';
import { dataRoutes } from './routes.ts';
import { exportXml, xmlAmountText, xmlQtyText, xmlRateText } from './xmlExport.ts';
import { importXml } from './xmlImport.ts';
import { parseXmlFile } from './xmlParse.ts';
import { REQUEST_TAG } from './xmlFormat.ts';

const FROM = '2026-04-01';
const TO = '2027-03-31';

let k: Kit;
let target: TestCompany | null = null;
beforeEach(() => {
  k = setupKit({ name: 'Round Trip Traders', today: '2026-04-30', booksFrom: FROM, features: { costCentres: true, multipleGodowns: true } });
});
afterEach(() => {
  k.t.close();
  target?.close();
  target = null;
});

/** A month of business in the source company (all hand-checkable; see the comments). */
function populate(): Record<string, number> {
  const { t, vt, L, I } = k;
  const ctx = t.ctx;
  // Masters beyond the kit: a user group, a godown, a cost centre, opening bills, extra aliases.
  const branchGroup = saveGroup(ctx, { name: 'Branch Expenses', parentId: t.ids.groups.INDIRECT_EXPENSES }).id;
  const travel = t.addLedger({ name: 'Travel Expenses', group: 'INDIRECT_EXPENSES', columns: { group_id: branchGroup }, costCentres: true });
  const pune = saveGodown(ctx, { name: 'Pune Warehouse', address: 'Plot 4, MIDC\nBhosari' }).id;
  const sales = saveCostCentre(ctx, { name: 'Sales Team', categoryId: t.ids.costCategoryId }).id;
  const ops = saveCostCentre(ctx, { name: 'Operations', categoryId: t.ids.costCategoryId }).id;
  const opener = t.addLedger({
    name: 'Old Customer',
    group: 'SUNDRY_DEBTORS',
    openingBalance: 12_000_00,
    openingBills: [
      { name: 'OB-1', date: '2026-03-10', amount: 5_000_00 },
      { name: 'OB-2', date: '2026-03-20', amount: 7_000_00 },
    ],
  });
  // Openings: Capital Cr 1,12,600 = Bank Dr 88,000 + Old Customer Dr 12,000 + opening stock 12,600
  // (kit: Rice 100 × 50 = 5,000; Mixer 50 × 150 = 7,500; Unclassified 10 × 10 = 100).
  t.db.run('UPDATE ledgers SET opening_balance = :v WHERE id = :id', { v: -112_600_00, id: L.capital });
  t.db.run('UPDATE ledgers SET opening_balance = :v WHERE id = :id', { v: 88_000_00, id: L.bank });
  writeExtraAliases(t.db, 'ledger', L.acme, ['ACME', 'Acme Pune']);
  writeExtraAliases(t.db, 'stock_item', I.rice, ['RB-25', 'Basmati 25kg']);

  // 1. Sales, intra-state (Acme, 27): Rice 10 × 60 = 600 @5% → CGST 15 + SGST 15; Mixer 2 × 400 = 800 @18% → CGST 72 + SGST 72.
  //    Total 1,400 + 174 = 1,574. Bill-wise New Ref S-1.
  const s1 = save(k, {
    voucherTypeId: vt.sales,
    date: '2026-04-05',
    mode: 'item_invoice',
    partyLedgerId: L.acme,
    items: [
      { itemId: I.rice, qty: 10, rate: 60 },
      { itemId: I.mixer, qty: 2, rate: 400 },
    ],
    partyBillAllocations: [{ refType: 'new', billName: 'S-1', amount: 1_574_00, creditDays: 30 }],
    narration: 'First sale <with> "quotes" & ampersand',
  }).id;
  // 2. Sales, inter-state (Bangalore Retail, 29): Mixer 3 × 500 = 1,500 @18% IGST 270 → 1,770.
  save(k, { voucherTypeId: vt.sales, date: '2026-04-08', mode: 'item_invoice', partyLedgerId: L.blr, items: [{ itemId: I.mixer, qty: 3, rate: 500 }] });
  // 3. Purchase (Supreme, 27): Rice 40 × 45 = 1,800 @5% → CGST 45 + SGST 45 = 1,890; from the Pune godown.
  save(k, {
    voucherTypeId: vt.purchase,
    date: '2026-04-10',
    referenceNo: 'SUP/77',
    referenceDate: '2026-04-09',
    mode: 'item_invoice',
    partyLedgerId: L.supplier,
    items: [{ itemId: I.rice, qty: 40, rate: 45, godownId: pune }],
  });
  // 4. Receipt from Acme against S-1 (1,000) by cheque into HDFC, and from Old Customer against OB-1 (5,000).
  save(k, {
    voucherTypeId: vt.receipt,
    date: '2026-04-15',
    mode: 'ledger',
    ledgers: [
      { ledgerId: L.bank, amount: 6_000_00, instrument: { type: 'cheque', number: '000123', date: '2026-04-15', bankName: 'SBI' } },
      { ledgerId: L.acme, amount: -1_000_00, billAllocations: [{ refType: 'against', billName: 'S-1', amount: 1_000_00 }] },
      { ledgerId: opener, amount: -5_000_00, billAllocations: [{ refType: 'against', billName: 'OB-1', amount: 5_000_00 }] },
    ],
  });
  // 5. Payment: travel 2,500 split over two cost centres (1,500 / 1,000), paid in cash.
  save(k, {
    voucherTypeId: vt.payment,
    date: '2026-04-18',
    mode: 'ledger',
    ledgers: [
      { ledgerId: travel, amount: 2_500_00, costAllocations: [{ costCentreId: sales, amount: 1_500_00 }, { costCentreId: ops, amount: 1_000_00 }] },
      { ledgerId: L.cash, amount: -2_500_00 },
    ],
  });
  // 6. Contra: cash deposit 2,000 from bank to cash (Dr Cash, Cr Bank).
  save(k, { voucherTypeId: vt.contra, date: '2026-04-17', mode: 'ledger', ledgers: [{ ledgerId: L.cash, amount: 3_000_00 }, { ledgerId: L.bank, amount: -3_000_00 }] });
  // 7. Journal: rent 1,200 payable to the owner's capital.
  save(k, { voucherTypeId: vt.journal, date: '2026-04-20', mode: 'ledger', ledgers: [{ ledgerId: L.rent, amount: 1_200_00 }, { ledgerId: L.capital, amount: -1_200_00 }] });
  // 8. Stock journal: move 15 Rice from Pune to Main Location at cost.
  save(k, {
    voucherTypeId: vt.stock_journal,
    date: '2026-04-22',
    mode: 'inventory',
    items: [
      { itemId: I.rice, qty: 15, rate: 45, godownId: pune, isConsumption: true },
      { itemId: I.rice, qty: 15, rate: 45 },
    ],
  });
  // 9. Credit note: Acme returns 1 Mixer @ 400 (+18% = 472), against S-1.
  save(k, {
    voucherTypeId: vt.credit_note,
    date: '2026-04-25',
    mode: 'item_invoice',
    partyLedgerId: L.acme,
    originalInvoiceNo: k.t.db.value<string>('SELECT number FROM vouchers WHERE id = :id', { id: s1 }) ?? undefined,
    originalInvoiceDate: '2026-04-05',
    items: [{ itemId: I.mixer, qty: 1, rate: 400 }],
    partyBillAllocations: [{ refType: 'against', billName: 'S-1', amount: 472_00 }],
  });
  // 10. Consultancy (services, 18%) as an accounting invoice to Bangalore Retail: 10,000 + IGST 1,800.
  save(k, { voucherTypeId: vt.sales, date: '2026-04-28', mode: 'accounting_invoice', partyLedgerId: L.blr, ledgers: [{ ledgerId: L.consult, amount: 10_000_00 }] });
  // 11. An optional (memorandum-like) journal and a cancelled payment: written with ISOPTIONAL / ISCANCELLED,
  //     neither counts in the books on either side.
  save(k, { voucherTypeId: vt.journal, date: '2026-04-29', mode: 'ledger', isOptional: true, ledgers: [{ ledgerId: L.rent, amount: 500_00 }, { ledgerId: L.capital, amount: -500_00 }] });
  const cancelled = save(k, { voucherTypeId: vt.payment, date: '2026-04-29', mode: 'ledger', ledgers: [{ ledgerId: L.rent, amount: 700_00 }, { ledgerId: L.cash, amount: -700_00 }] }).id;
  cancelVoucher(ctx, cancelled, 'Entered twice');
  // 12. A quotation: Tally has no such voucher type — reported as skipped, never written.
  save(k, { voucherTypeId: vt.quotation, date: '2026-04-29', mode: 'item_invoice', partyLedgerId: L.acme, validUntil: '2026-05-29', items: [{ itemId: I.mixer, qty: 1, rate: 450 }] });
  return { travel, pune, opener };
}

/** Export through the service (ZIP of UTF-16LE files), then import 1-Masters.xml and 2-Vouchers.xml into an empty company. */
async function roundTrip(): Promise<{ result: XmlImportResult[]; target: TestCompany; file: XmlExportResult }> {
  const file = await exportXml(k.t.ctx, { masters: true, vouchers: true, from: FROM, to: TO });
  const zip = readZip(file.bytes);
  assert.deepEqual(zip.list(), ['1-Masters.xml', '2-Vouchers.xml']);
  target = createTestCompany({ name: 'Round Trip Traders', today: '2026-04-30', booksFrom: FROM });
  const m = await importXml(target.ctx, { fileName: '1-Masters.xml', bytes: zip.read('1-Masters.xml'), options: { masters: true, vouchers: false, onDuplicate: 'skip' } });
  const vch = await importXml(target.ctx, { fileName: '2-Vouchers.xml', bytes: zip.read('2-Vouchers.xml'), options: { masters: false, vouchers: true, onDuplicate: 'skip' } });
  return { result: [m, vch], target, file };
}

/** Every voucher as recorded: type, date, number, flags, party, GST header and its ledger postings by name. */
function voucherDigest(t: TestCompany): Array<Record<string, unknown>> {
  return t.db
    .all<Record<string, unknown> & { id: number }>(
      `SELECT v.id, t.name AS type, v.date, v.number, v.reference_no, v.original_invoice_no, v.original_invoice_date, v.is_optional, v.is_cancelled, v.party_gstin, v.place_of_supply, pl.name AS party
         FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
        ORDER BY v.date, t.name, v.number`,
    )
    .map(({ id, ...head }) => ({
      ...head,
      // A cancelled voucher has no entries; the importer keeps it without a party (as Tally shows it).
      party: head.is_cancelled === 1 ? null : head.party,
      entries: t.db.all(`SELECT l.name, SUM(e.amount) AS amount FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = :id GROUP BY l.name ORDER BY l.name`, { id }),
      stock: t.db.all(
        `SELECT i.name, g.name AS godown, SUM(ie.qty) AS qty, SUM(ie.amount) AS amount FROM inventory_entries ie JOIN stock_items i ON i.id = ie.item_id
           LEFT JOIN godowns g ON g.id = ie.godown_id WHERE ie.voucher_id = :id GROUP BY i.name, g.name ORDER BY i.name, g.name`,
        { id },
      ),
    }));
}

/** Trial balance (groups and ledgers) as name → [opening, debit, credit, closing], plus its totals. */
async function tbByName(t: TestCompany): Promise<Record<string, unknown>> {
  const tb = await t.callOk<TrialBalanceResult>(reportsRoutes, 'reports.trialBalance', { from: FROM, to: TO, mode: 'detailed' });
  const out: Record<string, unknown> = { totals: tb.totals, openingStock: tb.openingStock, difference: tb.openingDifference, balanced: tb.balanced };
  for (const r of tb.rows) out[`${r.kind}:${r.name}`] = [r.opening, r.debit, r.credit, r.closing];
  return out;
}

function ledgerClosings(t: TestCompany): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of t.db.all<{ name: string; bal: number }>(
    `SELECT l.name, l.opening_balance + COALESCE((SELECT SUM(e.amount) FROM ledger_entries e WHERE e.ledger_id = l.id AND e.affects_books = 1), 0) AS bal
       FROM ledgers l ORDER BY l.name`,
  )) {
    if (r.bal !== 0) out[r.name] = r.bal;
  }
  return out;
}

async function stockByName(t: TestCompany): Promise<Record<string, { qty: number | null; value: number | null }>> {
  const s = await t.callOk<StockSummaryResult>(stockRoutes, 'stock.summary', { from: FROM, to: TO });
  const out: Record<string, { qty: number | null; value: number | null }> = {};
  for (const r of s.rows) if (r.kind === 'item') out[r.name] = { qty: r.closing.qty, value: r.closing.value };
  return out;
}

function gstTotals(t: TestCompany): Array<Record<string, unknown>> {
  return t.db.all(
    `SELECT v.base_type, g.rate, SUM(g.taxable_value) AS taxable, SUM(g.igst) AS igst, SUM(g.cgst) AS cgst, SUM(g.sgst) AS sgst, SUM(g.cess) AS cess
       FROM gst_lines g JOIN vouchers v ON v.id = g.voucher_id WHERE g.affects_books = 1
      GROUP BY v.base_type, g.rate ORDER BY v.base_type, g.rate`,
  );
}

/** Report payloads minus ids / timestamps that legitimately differ between two companies. */
function stripVolatile(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripVolatile);
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(x as Record<string, unknown>)) {
      if (/^(id|voucherId|ledgerId|itemId|partyLedgerId|generatedAt|computedAt|key)$/.test(key)) continue;
      out[key] = stripVolatile(val);
    }
    return out;
  }
  return x;
}

describe('tally export: value formats', () => {
  it('amounts flip sign (Tally Dr is negative), dates, quantities and rates', () => {
    assert.equal(xmlAmountText(1_044_500), '-10445.00'); // ours Dr ₹10,445
    assert.equal(xmlAmountText(-2_33_000_00), '233000.00'); // ours Cr
    assert.equal(xmlAmountText(5), '-0.05');
    assert.equal(xmlAmountText(0), '0.00');
    assert.equal(xmlQtyText(-10, 'Nos'), ' 10 Nos');
    assert.equal(xmlQtyText(2.5, 'Kg'), ' 2.5 Kg');
    assert.equal(xmlRateText(2950.5, 'Nos'), '2950.50/Nos');
    assert.equal(xmlRateText(45, 'Nos'), '45.00/Nos');
    assert.equal(xmlRateText(1.2345, 'Kg'), '1.2345/Kg');
  });
});

describe('tally export: round trip through our own importer', () => {
  it('reproduces the trial balance, stock summary, GST totals, bills and aliases in an empty company', async () => {
    populate();
    const { result, target: tg, file } = await roundTrip();
    for (const r of result) {
      const errors = r.issues.filter((i) => i.severity === 'error');
      assert.deepEqual(errors, [], 'no import errors');
      assert.equal(r.stopped, false);
    }
    // 10 + the optional journal + the cancelled payment; the quotation is skipped and said so.
    assert.equal(file.vouchers, 12);
    assert.deepEqual(file.skipped, [{ reason: 'Quotations and proforma invoices (Tally has no such voucher type)', count: 1 }]);
    assert.equal(result[1].vouchers.created, 12);
    assert.deepEqual(voucherDigest(tg), voucherDigest(k.t).filter((v) => v.type !== 'Quotation'));
    assert.deepEqual(ledgerClosings(tg), ledgerClosings(k.t));
    assert.deepEqual(await tbByName(tg), await tbByName(k.t));
    assert.deepEqual(await stockByName(tg), await stockByName(k.t));
    assert.deepEqual(gstTotals(tg), gstTotals(k.t));
    // The returns agree too: GSTR-3B and GSTR-1 of April through the dispatcher.
    for (const route of ['gst.gstr3b.summary', 'gst.gstr1.summary']) {
      const a = await k.t.callOk(gstRoutes, route, { period: '042026' });
      const b = await tg.callOk(gstRoutes, route, { period: '042026' });
      assert.deepEqual(stripVolatile(b), stripVolatile(a), route);
    }
    const pending = (t: TestCompany): Array<Record<string, unknown>> =>
      t.db.all(
        `SELECT l.name, b.bill, SUM(b.amount) AS amount FROM (
            SELECT ledger_id, bill_name AS bill, amount FROM opening_bills
            UNION ALL SELECT ledger_id, bill_name, amount FROM bill_allocations WHERE affects_books = 1 AND bill_name IS NOT NULL) b
           JOIN ledgers l ON l.id = b.ledger_id GROUP BY l.name, b.bill HAVING SUM(b.amount) <> 0 ORDER BY l.name, b.bill`,
      );
    assert.deepEqual(pending(tg), pending(k.t));
    // Aliases travel as NAME.LIST.
    const acmeId = tg.db.value<number>(`SELECT id FROM ledgers WHERE name = 'Acme Traders'`) ?? 0;
    const riceId = tg.db.value<number>(`SELECT id FROM stock_items WHERE name = 'Rice Bag'`) ?? 0;
    const aliasesOf = (t: TestCompany, kind: 'ledger' | 'stock_item', id: number): string[] => {
      const first = t.db.value<string>(`SELECT alias FROM ${kind === 'ledger' ? 'ledgers' : 'stock_items'} WHERE id = :id`, { id }) ?? null;
      return allAliases(first, extraAliases(t.db, kind, id)).sort();
    };
    assert.deepEqual(aliasesOf(tg, 'ledger', acmeId), ['ACME', 'Acme Pune']);
    assert.deepEqual(aliasesOf(tg, 'stock_item', riceId), ['Basmati 25kg', 'RB-25']);
    // Cost centres, godown, group, the narration with markup characters.
    assert.equal(tg.db.value(`SELECT p.name FROM groups g JOIN groups p ON p.id = g.parent_id WHERE g.name = 'Branch Expenses'`), 'Indirect Expenses');
    assert.equal(tg.db.value(`SELECT COUNT(*) FROM cost_allocations`), 2);
    assert.equal(tg.db.value(`SELECT COUNT(*) FROM godowns WHERE name = 'Pune Warehouse'`), 1);
    assert.equal(tg.db.value(`SELECT narration FROM vouchers WHERE date = '2026-04-05'`), 'First sale <with> "quotes" & ampersand');
  });
});

describe('tally export: the file, permissions and audit', () => {
  it('masters only: one UTF-16LE XML with a BOM in the ENVELOPE / IMPORTDATA shape, values escaped', async () => {
    writeExtraAliases(k.t.db, 'ledger', k.L.acme, ['A&B <Co>']);
    const r = await exportXml(k.t.ctx, { masters: true, vouchers: false, from: FROM, to: TO });
    assert.equal(r.fileName, 'Round-Trip-Traders-XML-Masters.xml');
    assert.equal(r.mimeType, 'application/xml');
    assert.deepEqual([r.bytes[0], r.bytes[1]], [0xff, 0xfe]); // UTF-16LE BOM
    assert.equal(r.vouchers, 0);
    assert.ok(r.masters && r.masters.ledgers > 10 && r.masters.stockItems === 3);
    const xml = new TextDecoder('utf-16le').decode(r.bytes.subarray(2));
    assert.ok(xml.startsWith(`<ENVELOPE>\r\n <HEADER>\r\n  <${REQUEST_TAG}>Import Data</${REQUEST_TAG}>`));
    assert.match(xml, /<REPORTNAME>All Masters<\/REPORTNAME>/);
    assert.match(xml, /<SVCURRENTCOMPANY>Round Trip Traders<\/SVCURRENTCOMPANY>/);
    assert.match(xml, /<NAME>A&amp;B &lt;Co&gt;<\/NAME>/);
    assert.doesNotMatch(xml, /A&B <Co>/);
    assert.match(xml, /<LEDGER NAME="Acme Traders" ACTION="Create">/);
    assert.match(xml, /<GSTREGISTRATIONTYPE>Regular<\/GSTREGISTRATIONTYPE>/);
    assert.match(xml, /<STOCKITEM NAME="Rice Bag" ACTION="Create">[\s\S]*?<HSNCODE>1006<\/HSNCODE>[\s\S]*?<GSTRATEDUTYHEAD>Integrated Tax<\/GSTRATEDUTYHEAD>\r\n\s*<GSTRATE> 5<\/GSTRATE>/);
    // Our own reader accepts it (what Tally reads, we read).
    const parsed = parseXmlFile(r.bytes);
    assert.equal(parsed.encoding, 'utf-16le');
    assert.equal(parsed.companyName, 'Round Trip Traders');
    assert.equal(parsed.counts.VOUCHER, 0);
    assert.equal(parsed.counts.STOCKITEM, 3);
  });

  it('vouchers only: a ZIP of Vouchers.xml; the period is honoured and amounts are signed as Tally expects', async () => {
    populate();
    const r = await exportXml(k.t.ctx, { masters: false, vouchers: true, from: '2026-04-05', to: '2026-04-08' });
    assert.equal(r.fileName, 'Round-Trip-Traders-XML-Vouchers-20260405-20260408.zip');
    assert.equal(r.mimeType, 'application/zip');
    assert.equal(r.masters, null);
    assert.equal(r.vouchers, 2); // the two sales of 5 and 8 April
    const zip = readZip(r.bytes);
    assert.deepEqual(zip.list(), ['Vouchers.xml']);
    const raw = zip.read('Vouchers.xml');
    assert.deepEqual([raw[0], raw[1]], [0xff, 0xfe]);
    const xml = new TextDecoder('utf-16le').decode(raw.subarray(2));
    assert.match(xml, /<REPORTNAME>Vouchers<\/REPORTNAME>/);
    // Acme Dr 1,574 → Tally -1574.00 with ISDEEMEDPOSITIVE Yes; sales line Cr 600 → 600.00.
    assert.match(xml, /<LEDGERNAME>Acme Traders<\/LEDGERNAME>\r\n\s*<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>\r\n\s*<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>\r\n\s*<AMOUNT>-1574.00<\/AMOUNT>/);
    assert.match(xml, /<STOCKITEMNAME>Rice Bag<\/STOCKITEMNAME>[\s\S]*?<AMOUNT>600.00<\/AMOUNT>/);
    assert.match(xml, /<BILLTYPE>New Ref<\/BILLTYPE>/);
    assert.match(xml, /<PLACEOFSUPPLY>Karnataka<\/PLACEOFSUPPLY>/);
    assert.equal(parseXmlFile(raw).counts.VOUCHER, 2);
    assert.equal(fs.readdirSync(k.t.ctx.company.dir).filter((f) => f.startsWith('.export-')).length, 0, 'temporary file removed');
  });

  it('runs through the dispatcher, needs data.export and writes one audit entry', async () => {
    const before = k.t.db.value<number>(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'xml_data'`) ?? 0;
    const ok = await k.t.callOk<XmlExportResult>(dataRoutes, 'data.xmlExport.create', { masters: true, vouchers: true, from: FROM, to: TO });
    assert.equal(ok.fileName, 'Round-Trip-Traders-XML-20260401-20270331.zip');
    assert.equal(k.t.db.value(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'xml_data' AND action = 'export'`), before + 1);
    const denied = await k.t.call(dataRoutes, 'data.xmlExport.create', { masters: true, vouchers: false, from: FROM, to: TO }, { session: k.t.sessionAs({ permissions: ['masters.view', 'reports.view'] }) });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN');
  });

  it('refuses an empty choice and a reversed period, saying how to fix it', async () => {
    await assert.rejects(
      () => exportXml(k.t.ctx, { masters: false, vouchers: false, from: FROM, to: TO }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION' && /masters, vouchers or both/.test(JSON.stringify(e.details ?? e.message)),
    );
    await assert.rejects(() => exportXml(k.t.ctx, { masters: false, vouchers: true, from: TO, to: FROM }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
  });
});

// ───────────────────────────── Review regressions (dataplus review) ─────────────────────────────

/** Export masters + vouchers of [from, to] and import both files into a fresh company beginning on `targetBooksFrom`. */
async function exportImport(
  source: TestCompany,
  from: string,
  to: string,
  target: { booksFrom: string; today: string; features?: NonNullable<Parameters<typeof createTestCompany>[0]>['features']; lut?: boolean },
): Promise<{ file: XmlExportResult; tg: TestCompany; vouchersXml: string }> {
  const file = await exportXml(source.ctx, { masters: true, vouchers: true, from, to });
  const zip = readZip(file.bytes);
  const tg = createTestCompany({ name: 'Imported', today: target.today, booksFrom: target.booksFrom, ...(target.features ? { features: target.features } : {}) });
  if (target.lut) {
    tg.db.run(`UPDATE settings SET value = json_set(value, '$.gst.lutNumber', 'AD2704260012345', '$.gst.lutValidFrom', '2026-04-01', '$.gst.lutValidTo', '2027-03-31') WHERE key = 'config'`);
  }
  for (const [name, masters] of [['1-Masters.xml', true], ['2-Vouchers.xml', false]] as const) {
    const r = await importXml(tg.ctx, { fileName: name, bytes: zip.read(name), options: { masters, vouchers: !masters, onDuplicate: 'skip' } });
    assert.deepEqual(r.issues.filter((i) => i.severity !== 'info'), [], `${name} imports without warnings`);
  }
  return { file, tg, vouchersXml: new TextDecoder('utf-16le').decode(zip.read('2-Vouchers.xml').subarray(2)) };
}

/** Every (non-cancelled) voucher of the file balances: ledger entries + accounting allocations sum to 0. */
function assertFileBalanced(xmlUtf16: Uint8Array): void {
  for (const v of parseXmlFile(xmlUtf16).vouchers) {
    if (v.isCancelled) continue;
    const sum = v.entries.reduce((s, e) => s + e.amount, 0);
    assert.equal(sum, 0, `voucher ${v.vchType} ${v.number} balances in the file`);
  }
}

async function tbRows(t: TestCompany, from: string, to: string): Promise<Record<string, number[]>> {
  const tb = await t.callOk<TrialBalanceResult>(reportsRoutes, 'reports.trialBalance', { from, to, mode: 'detailed' });
  const out: Record<string, number[]> = {};
  for (const r of tb.rows) out[`${r.kind}:${r.name}`] = [r.opening, r.debit, r.credit, r.closing];
  return out;
}

async function stockRows(t: TestCompany, from: string, to: string): Promise<Record<string, Array<number | null>>> {
  const s = await t.callOk<StockSummaryResult>(stockRoutes, 'stock.summary', { from, to });
  const out: Record<string, Array<number | null>> = {};
  for (const r of s.rows) if (r.kind === 'item') out[r.name] = [r.opening.qty, r.opening.value, r.closing.qty, r.closing.value];
  return out;
}

/** Stock per item, godown and batch (openings + movements), as the batch / godown reports see it. */
function stockByPlace(t: TestCompany): Array<Record<string, unknown>> {
  return t.db.all(
    `SELECT i.name, g.name AS godown, x.batch, SUM(x.qty) AS qty
       FROM (SELECT item_id, godown_id, batch_name AS batch, qty FROM stock_openings
             UNION ALL SELECT ie.item_id, ie.godown_id, ie.batch_name, ie.qty FROM inventory_entries ie WHERE ie.affects_stock = 1) x
       JOIN stock_items i ON i.id = x.item_id LEFT JOIN godowns g ON g.id = x.godown_id
      GROUP BY i.name, g.name, x.batch HAVING SUM(x.qty) <> 0 ORDER BY 1, 2, 3`,
  );
}

describe('tally export: openings when the period starts after the books beginning', () => {
  it('the Tally company starts at the period: balances, pending bills and stock (per godown and batch) as on that day', async () => {
    // Books from 1-Apr-2025; a year of business, then FY 2026-27 is exported for a CA whose Tally
    // company begins on 1-Apr-2026.
    const s = setupKit({ name: 'Two Years', today: '2026-12-31', booksFrom: '2025-04-01', features: { multipleGodowns: true, batches: true } });
    try {
      const { vt, L, I } = s;
      const pune = saveGodown(s.t.ctx, { name: 'Pune', address: null }).id;
      const ghee = s.t.addStockItem({ name: 'Ghee Tin', gstRate: 12, hsnSac: '0405', maintainBatches: true });
      // Opening: Capital Cr 12,600 = opening stock 12,600 (kit items).
      s.t.db.run('UPDATE ledgers SET opening_balance = :v WHERE id = :id', { v: -12_600_00, id: L.capital });
      // FY 2025-26. Purchase: Ghee 10 × 500 (Pune, B1) + 5 × 520 (Main, B2) + Rice 20 × 40 (Pune)
      //   = 5,000 + 2,600 + 800 = 8,400 + GST (12% on 7,600 = 912; 5% on 800 = 40) = 9,352.
      save(s, {
        voucherTypeId: vt.purchase,
        date: '2025-06-05',
        referenceNo: 'P1',
        referenceDate: '2025-06-05',
        mode: 'item_invoice',
        partyLedgerId: L.supplier,
        items: [
          { itemId: ghee, qty: 10, rate: 500, godownId: pune, batchName: 'B1', mfgDate: '2025-05-01', expiryDate: '2027-05-01' },
          { itemId: ghee, qty: 5, rate: 520, batchName: 'B2', mfgDate: '2025-05-01', expiryDate: '2027-05-01' },
          { itemId: I.rice, qty: 20, rate: 40, godownId: pune },
        ],
      });
      // Sale of 3 Ghee from B1 at 700 = 2,100 + 12% = 2,352 (bill S-1); rent 1,000 (P&L of FY 2025-26).
      save(s, { voucherTypeId: vt.sales, date: '2025-08-05', mode: 'item_invoice', partyLedgerId: L.acme, items: [{ itemId: ghee, qty: 3, rate: 700, godownId: pune, batchName: 'B1' }], partyBillAllocations: [{ refType: 'new', billName: 'S-1', amount: 2_352_00 }] });
      save(s, { voucherTypeId: vt.journal, date: '2025-09-01', mode: 'ledger', ledgers: [{ ledgerId: L.rent, amount: 1_000_00 }, { ledgerId: L.capital, amount: -1_000_00 }] });
      // 500 received from Acme ON ACCOUNT: on 1-Apr-2026 Acme owes S-1 2,352 less 500 unallocated.
      save(s, { voucherTypeId: vt.receipt, date: '2026-03-15', mode: 'ledger', ledgers: [{ ledgerId: L.bank, amount: 500_00 }, { ledgerId: L.acme, amount: -500_00, billAllocations: [{ refType: 'on_account', amount: 500_00 }] }] });
      // FY 2026-27 (exported).
      save(s, { voucherTypeId: vt.sales, date: '2026-05-05', mode: 'item_invoice', partyLedgerId: L.blr, items: [{ itemId: ghee, qty: 2, rate: 700, batchName: 'B2' }] });
      save(s, { voucherTypeId: vt.receipt, date: '2026-06-15', mode: 'ledger', ledgers: [{ ledgerId: L.bank, amount: 1_000_00 }, { ledgerId: L.acme, amount: -1_000_00, billAllocations: [{ refType: 'against', billName: 'S-1', amount: 1_000_00 }] }] });
      const F = '2026-04-01';
      const T = '2027-03-31';
      const { file, tg } = await exportImport(s.t, F, T, { booksFrom: F, today: '2026-12-31', features: { multipleGodowns: true, batches: true } });
      try {
        assert.equal(file.openingsAsOf, F);
        // Same Trial Balance for FY 2026-27 — openings (incl. the Profit & Loss A/c carrying FY 2025-26's
        // result less its stock movement), transactions and closings — same stock, same bills.
        assert.deepEqual(await tbRows(tg, F, T), await tbRows(s.t, F, T));
        assert.deepEqual(await stockRows(tg, F, T), await stockRows(s.t, F, T));
        assert.deepEqual(stockByPlace(tg), stockByPlace(s.t));
        const bills = (t: TestCompany): Array<Record<string, unknown>> =>
          t.db.all(
            `SELECT l.name, b.bill, SUM(b.amount) AS amount FROM (
                SELECT ledger_id, bill_name AS bill, amount FROM opening_bills
                UNION ALL SELECT ledger_id, bill_name, amount FROM bill_allocations WHERE affects_books = 1 AND bill_name IS NOT NULL) b
               JOIN ledgers l ON l.id = b.ledger_id GROUP BY l.name, b.bill HAVING SUM(b.amount) <> 0 ORDER BY l.name, b.bill`,
          );
        // The unallocated 500 becomes an opening bill "On Account" (opening bills must add up to the balance).
        assert.deepEqual(bills(tg), [...bills(s.t), { name: 'Acme Traders', bill: 'On Account', amount: -500_00 }].sort((a, b) => `${a.name}|${a.bill}`.localeCompare(`${b.name}|${b.bill}`)));
        // Masters alone keep the books-beginning openings.
        const mastersOnly = await exportXml(s.t.ctx, { masters: true, vouchers: false, from: F, to: T });
        assert.equal(mastersOnly.openingsAsOf, '2025-04-01');
      } finally {
        tg.close();
      }
    } finally {
      s.t.close();
    }
  });
});

describe('tally export: invoices whose lines carry more than their sales ledger', () => {
  it('freight in the assessable value, cost centres on a carried ledger, orders, notes, rejections, memorandum, advance: balanced and reproduced', async () => {
    const s = setupKit({ name: 'Mixed', today: '2026-04-30', booksFrom: FROM, features: { costCentres: true } });
    try {
      const { vt, L, I } = s;
      const north = saveCostCentre(s.t.ctx, { name: 'North', categoryId: s.t.ids.costCategoryId }).id;
      const south = saveCostCentre(s.t.ctx, { name: 'South', categoryId: s.t.ids.costCategoryId }).id;
      s.t.db.run('UPDATE ledgers SET cost_centres_applicable = 1 WHERE id IN (:a, :b)', { a: L.sales, b: L.freight });
      s.t.db.run('UPDATE ledgers SET opening_balance = :v WHERE id = :id', { v: -12_600_00, id: L.capital });
      const note = (base: 'sales_order' | 'delivery_note' | 'rejection_in', date: string, items: VoucherInput['items']): number =>
        save(s, { voucherTypeId: vt[base], date, mode: 'inventory', partyLedgerId: L.acme, items }).id;
      note('sales_order', '2026-04-10', [{ itemId: I.mixer, qty: 10, rate: 200 }]);
      note('delivery_note', '2026-04-11', [{ itemId: I.mixer, qty: 4, rate: 200, orderRef: '1' }]);
      save(s, { voucherTypeId: vt.sales, date: '2026-04-12', mode: 'item_invoice', partyLedgerId: L.acme, items: [{ itemId: I.mixer, qty: 4, rate: 200, trackingRef: '1', orderRef: '1' }] });
      // Mixer 2 × 199.99 less 2.5% = 389.98; Rice 3 × 61.11 = 183.33; Freight 150 (included in the goods'
      // assessable value, by value): the item lines carry 492.01 + 231.30 = 723.31, the Sales ledger 573.31.
      save(s, {
        voucherTypeId: vt.sales,
        date: '2026-04-13',
        mode: 'item_invoice',
        partyLedgerId: L.acme,
        items: [
          { itemId: I.mixer, qty: 2, rate: 199.99, discountPct: 2.5, orderRef: '1' },
          { itemId: I.rice, qty: 3, rate: 61.11 },
        ],
        ledgers: [{ ledgerId: L.freight, amount: 150_00, costAllocations: [{ costCentreId: north, amount: 100_00 }, { costCentreId: south, amount: 50_00 }] }],
      });
      // An extra line on the Sales ledger itself, with a cost centre, beside an item line on it.
      save(s, { voucherTypeId: vt.sales, date: '2026-04-14', mode: 'item_invoice', partyLedgerId: L.walkin, items: [{ itemId: I.rice, qty: 1, rate: 100 }], ledgers: [{ ledgerId: L.sales, amount: 50_00, costAllocations: [{ costCentreId: north, amount: 50_00 }] }] });
      note('rejection_in', '2026-04-15', [{ itemId: I.mixer, qty: 1, rate: 200 }]);
      save(s, { voucherTypeId: vt.memorandum, date: '2026-04-16', mode: 'ledger', ledgers: [{ ledgerId: L.rent, amount: 100_00 }, { ledgerId: L.cash, amount: -100_00 }] });
      save(s, { voucherTypeId: vt.receipt, date: '2026-04-17', mode: 'ledger', ledgers: [{ ledgerId: L.bank, amount: 2_000_00, instrument: { type: 'upi', number: 'UPI-1' } }, { ledgerId: L.blr, amount: -2_000_00, billAllocations: [{ refType: 'advance', billName: 'ADV-1', amount: 2_000_00 }] }] });

      const file = await exportXml(s.t.ctx, { masters: true, vouchers: true, from: FROM, to: TO });
      assertFileBalanced(readZip(file.bytes).read('2-Vouchers.xml'));
      const { tg, vouchersXml } = await exportImport(s.t, FROM, TO, { booksFrom: FROM, today: '2026-04-30', features: { costCentres: true } });
      try {
        // The item amounts in the file are the lines' share of the Sales posting (Tally adds the
        // assessable-value freight itself): 389.98 and 183.33, not 492.01 / 231.30.
        assert.match(vouchersXml, /<STOCKITEMNAME>Mixer Grinder<\/STOCKITEMNAME>[\s\S]*?<AMOUNT>389\.98<\/AMOUNT>/);
        assert.match(vouchersXml, /<LEDGERNAME>Freight Outward<\/LEDGERNAME>[\s\S]*?<AMOUNT>150\.00<\/AMOUNT>/);
        const digest = (t: TestCompany): Array<Record<string, unknown>> =>
          t.db
            .all<Record<string, unknown> & { id: number }>(
              `SELECT v.id, t.name AS type, v.date, v.number, v.total_amount, v.taxable_amount, v.tax_amount FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id ORDER BY v.date, t.name, v.number`,
            )
            .map(({ id, ...h }) => ({
              ...h,
              entries: t.db.all(`SELECT l.name, SUM(e.amount) AS a FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = :id GROUP BY l.name ORDER BY l.name`, { id }),
              stock: t.db.all(
                `SELECT i.name, ie.qty, ie.amount, ie.rate, ie.discount_pct, ie.tracking_ref, ie.order_ref, ie.affects_stock FROM inventory_entries ie JOIN stock_items i ON i.id = ie.item_id WHERE ie.voucher_id = :id ORDER BY ie.line_no, ie.id`,
                { id },
              ),
              costs: t.db.all(
                `SELECT l.name, c.name AS centre, SUM(a.amount) AS a FROM cost_allocations a JOIN cost_centres c ON c.id = a.cost_centre_id JOIN ledgers l ON l.id = a.ledger_id WHERE a.voucher_id = :id GROUP BY l.name, c.name ORDER BY 1, 2`,
                { id },
              ),
              bills: t.db.all(`SELECT l.name, b.ref_type, b.bill_name, b.amount FROM bill_allocations b JOIN ledgers l ON l.id = b.ledger_id WHERE b.voucher_id = :id ORDER BY 1, 3`, { id }),
              gst: t.db.all(`SELECT source, taxable_value, cgst, sgst, igst FROM gst_lines WHERE voucher_id = :id ORDER BY line_no`, { id }),
            }));
        assert.deepEqual(digest(tg), digest(s.t));
        assert.deepEqual(await tbRows(tg, FROM, TO), await tbRows(s.t, FROM, TO));
        assert.deepEqual(await stockRows(tg, FROM, TO), await stockRows(s.t, FROM, TO));
        // The freight ledger keeps "included in the goods' assessable value, by value".
        assert.deepEqual(tg.db.get(`SELECT include_in_assessable, appropriate_by FROM ledgers WHERE name = 'Freight Outward'`), { include_in_assessable: 'goods', appropriate_by: 'value' });
      } finally {
        tg.close();
      }
    } finally {
      s.t.close();
    }
  });
});

describe('tally export: GST treatment our importer recovers', () => {
  it('a reverse-charge purchase and an export under LUT keep their returns', async () => {
    const s = setupKit({ name: 'RCM Exporter', today: '2026-04-30', booksFrom: FROM });
    try {
      const { vt, L, I } = s;
      s.t.db.run(`UPDATE settings SET value = json_set(value, '$.gst.lutNumber', 'AD2704260012345', '$.gst.lutValidFrom', '2026-04-01', '$.gst.lutValidTo', '2027-03-31') WHERE key = 'config'`);
      s.t.db.run('UPDATE ledgers SET opening_balance = :v WHERE id = :id', { v: -12_600_00, id: L.capital });
      // GTA freight 2,000 under reverse charge: CGST 50 + SGST 50 payable by us (and claimed as ITC).
      save(s, { voucherTypeId: vt.purchase, date: '2026-04-04', mode: 'accounting_invoice', partyLedgerId: L.gta, referenceNo: 'GTA-12', referenceDate: '2026-04-04', reverseCharge: true, ledgers: [{ ledgerId: L.gtaFreight, amount: 2_000_00 }] });
      // Export of 50 Rice at 100 under LUT: zero-rated, no tax.
      save(s, { voucherTypeId: vt.sales, date: '2026-04-12', mode: 'item_invoice', partyLedgerId: L.export, items: [{ itemId: I.rice, qty: 50, rate: 100 }], exportDetails: { shippingBillNo: '4455667', shippingBillDate: '2026-04-12', portCode: 'INNSA1' } });
      const { tg } = await exportImport(s.t, FROM, TO, { booksFrom: FROM, today: '2026-04-30', lut: true });
      try {
        const flags = (t: TestCompany): Array<Record<string, unknown>> =>
          t.db.all(`SELECT v.date, v.is_reverse_charge, v.gst_nature, v.place_of_supply, g.taxable_value, g.cgst, g.sgst, g.igst, g.is_reverse_charge AS line_rc FROM vouchers v JOIN gst_lines g ON g.voucher_id = v.id ORDER BY v.date, g.line_no`);
        assert.deepEqual(flags(tg), flags(s.t));
        assert.deepEqual(flags(tg).map((r) => r.gst_nature), ['inward_rcm', 'export_lut']);
        assert.equal(tg.db.value(`SELECT gst_registration_type FROM ledgers WHERE name = 'Global Imports LLC'`), 'overseas');
        const strip3b = (x: unknown): unknown => JSON.parse(JSON.stringify(stripVolatile(x), (key, val) => (key === 'warnings' || key === 'companyName' ? undefined : val)));
        const a = await s.t.callOk(gstRoutes, 'gst.gstr3b.summary', { period: '042026' });
        const b = await tg.callOk(gstRoutes, 'gst.gstr3b.summary', { period: '042026' });
        // Same 3.1(b) zero-rated and 3.1(d) / 4(A)(3) reverse-charge figures (shipping bill details are not
        // carried — no Tally tag we could verify — so only the exceptions count may differ).
        assert.deepEqual(strip3b(b), strip3b(a));
      } finally {
        tg.close();
      }
    } finally {
      s.t.close();
    }
  });
});
