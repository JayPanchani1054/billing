/**
 * Fix links on uncertain transactions: every document-level issue names the party ledger, and HSN /
 * rate issues name the stock item (or the ledger of an accounting-mode line) of the first offending
 * line, so the GST screens can open the master that needs correcting.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadCompany } from './docs.ts';
import { computeGstr1, gstr1Summary } from './gstr1.ts';
import { resolvePeriod } from './period.ts';
import { exceptionsReport } from './reports.ts';
import { insertDoc, setupParties } from './testkit.ts';

describe('GST issues — fix links', () => {
  it('HSN and rate issues carry the stock item; party issues carry the party ledger', () => {
    const { t, P } = setupParties({ today: '2026-05-10' });
    const widget = t.addStockItem({ name: 'Widget', gstRate: 18 });
    const voucherId = insertDoc(t, {
      type: 'sales',
      number: 'A1',
      date: '2026-04-02',
      party: P.acme,
      nature: 'b2b',
      pos: null,
      partyState: null,
      // 1,000.00 @ 18%: 9% = 90.00 CGST + 90.00 SGST; no HSN on the item line and no place of supply.
      lines: [{ hsn: null, rate: 18, taxable: 100000, cgst: 9000, sgst: 9000, itemId: widget }],
    });
    const s = gstr1Summary(computeGstr1(t.db, loadCompany(t.db), resolvePeriod({ period: '042026' }), t.today));
    const hsn = s.issues.find((i) => i.code === 'hsn_missing');
    assert.ok(hsn);
    assert.equal(hsn.voucherId, voucherId);
    assert.equal(hsn.itemId, widget);
    assert.equal(hsn.lineLedgerId, null);
    assert.equal(hsn.partyLedgerId, P.acme);
    const pos = s.issues.find((i) => i.code === 'pos_missing');
    assert.ok(pos);
    assert.equal(pos.partyLedgerId, P.acme);
    assert.equal(pos.itemId, null);
    t.close();
  });

  it('period-level issues have no links; inward issues link the supplier', () => {
    const { t, P } = setupParties({ today: '2026-05-10' });
    for (const n of [1, 3]) {
      insertDoc(t, { type: 'sales', number: `INV-${n}`, date: `2026-04-0${n}`, party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '8471', rate: 18, taxable: 1000, cgst: 90, sgst: 90 }] });
    }
    // Purchase without supplier invoice number while tax is claimed → supplier_invoice_missing (error).
    insertDoc(t, { type: 'purchase', number: 'P1', date: '2026-04-05', party: P.steel, nature: null, refNo: null, lines: [{ hsn: '7208', rate: 18, taxable: 300000, cgst: 27000, sgst: 27000 }] });
    const r = exceptionsReport(t.db, loadCompany(t.db), '2026-04-01', '2026-04-30', t.today);
    const gap = r.issues.find((i) => i.code === 'doc_series_gap');
    assert.ok(gap);
    assert.equal(gap.voucherId, null);
    assert.equal(gap.partyLedgerId, null);
    const sup = r.issues.find((i) => i.code === 'supplier_invoice_missing');
    assert.ok(sup);
    assert.equal(sup.partyLedgerId, P.steel);
    t.close();
  });

  it('accounting-mode lines link their ledger; inward rate issues link the line and the supplier', () => {
    const { t, P } = setupParties({ today: '2026-05-10' });
    const consulting = t.addLedger({ name: 'Consulting Income', group: 'SALES_ACCOUNTS' });
    const freight = t.addLedger({ name: 'Freight Inward', group: 'PURCHASE_ACCOUNTS' });
    // Service sale in accounting mode with a 4-digit SAC that does not start with 99 → hsn_invalid on the ledger line.
    // 10,000.00 @18%: 9% = 900.00 CGST + 900.00 SGST.
    const sale = insertDoc(t, {
      type: 'sales',
      number: 'B1',
      date: '2026-04-03',
      party: P.acme,
      nature: 'b2b',
      pos: '27',
      lines: [{ hsn: '1234', kind: 'services', rate: 18, taxable: 1_000_000, cgst: 90_000, sgst: 90_000, ledgerId: consulting }],
    });
    // Purchase at 7% (not a GST slab): 1,000.00 × 7% = 70.00 → 35.00 CGST + 35.00 SGST; rate_not_slab is a warning inward.
    const purchase = insertDoc(t, {
      type: 'purchase',
      number: 'P9',
      date: '2026-04-04',
      party: P.steel,
      nature: null,
      refNo: 'SS/9',
      refDate: '2026-04-04',
      lines: [{ hsn: '996511', kind: 'services', rate: 7, taxable: 100_000, cgst: 3_500, sgst: 3_500, ledgerId: freight }],
    });
    const r = exceptionsReport(t.db, loadCompany(t.db), '2026-04-01', '2026-04-30', t.today);
    const hsn = r.issues.find((i) => i.voucherId === sale && i.code.startsWith('hsn_'));
    assert.ok(hsn, 'an HSN issue on the service sale');
    assert.equal(hsn.itemId, null);
    assert.equal(hsn.lineLedgerId, consulting);
    assert.equal(hsn.partyLedgerId, P.acme);
    const rate = r.issues.find((i) => i.voucherId === purchase && i.code === 'rate_not_slab');
    assert.ok(rate, 'a rate issue on the purchase');
    assert.equal(rate.severity, 'warning');
    assert.equal(rate.lineLedgerId, freight);
    assert.equal(rate.itemId, null);
    assert.equal(rate.partyLedgerId, P.steel);
    t.close();
  });
});
