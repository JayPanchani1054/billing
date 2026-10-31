/**
 * Contract test (2.2): the voucher view's Particulars of a voucher that posts no ledger entries
 * (lib/daybook.ts › viewSections().lines, viewLineRows, viewLineLedgerIds) driven by the REAL engine's
 * vouchers.get on an in-memory company (src/core/modules/vouchers testkit: a Maharashtra GST trader).
 *
 *  - a sales order entered as an invoice keeps its charges only as entered: the view shows them with their
 *    descriptions in Detailed, beside the items; a quotation for services shows its lines by default;
 *  - a cancelled document shows none, although its voucher as entered keeps them;
 *  - a posted invoice shows its ledger entries as before, never its lines as entered;
 *  - the names come from accounts.ledger.get (what vouchers/pickers/hooks.ts › useLedgerDetails asks).
 *
 * Test-only: this file imports core services at runtime. Renderer source files never do.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import '../../../../core/modules/documents/hook.ts';
import { getLedger } from '../../../../core/modules/accounts/ledgers.ts';
import { getVoucher } from '../../../../core/modules/vouchers/queries.ts';
import { cancelVoucher } from '../../../../core/modules/vouchers/service.ts';
import { save, setupKit } from '../../../../core/modules/vouchers/testkit.ts';
import { viewEntryRows, viewLineLedgerIds, viewLineRows, viewSections } from './daybook.ts';

const k = setupKit({ features: { orderProcessing: true } });
after(() => k.t.close());
const { t, L, I, vt } = k;

/** Names as the view gets them: accounts.ledger.get, one ledger at a time. */
const named = (id: number): string | undefined => getLedger(t.db, id, t.today).name;
const INSTRUMENTS = { cheque: 'Cheque', dd: 'Demand draft', neft: 'NEFT', rtgs: 'RTGS', imps: 'IMPS', upi: 'UPI', card: 'Card', cash: 'Cash', other: 'Other' } as const;

describe('voucher view 2.2 on the real engine: the ledger lines of a voucher that posts none', () => {
  it('a sales order entered as an invoice: its charges, with their descriptions, in Detailed beside the items', () => {
    const so = save(k, {
      voucherTypeId: vt.sales_order,
      date: t.today,
      mode: 'item_invoice',
      partyLedgerId: L.acme,
      items: [{ itemId: I.mixer, qty: 4, rate: 200, description: 'Matte finish' }],
      ledgers: [
        { ledgerId: L.freight, amount: 5000, narration: 'Packing extra\nby road' },
        { ledgerId: L.discount, amount: -2000 },
        { ledgerId: L.rent, amount: 0, narration: 'Not a line' },
      ],
    });
    const d = getVoucher(t.db, so.id);
    assert.deepEqual([d.entries.length, d.isCancelled, d.inventory.length], [0, false, 1], 'an order posts no ledger entries');
    assert.deepEqual(viewSections(d, false), { entries: false, lines: false, gst: false, totals: true, focus: 'items' });
    assert.deepEqual(viewSections(d, true), { entries: false, lines: true, gst: false, totals: true, focus: 'items' });
    assert.deepEqual(viewLineLedgerIds(d), [L.freight, L.discount]);
    assert.deepEqual(viewLineRows(d, named), [
      { key: '0', ledgerId: L.freight, name: 'Freight Outward', description: 'Packing extra\nby road', amount: 5000 },
      { key: '1', ledgerId: L.discount, name: 'Discount Allowed', description: null, amount: -2000 },
    ]);
  });

  it('a quotation for services (an accounting invoice): its lines are the document, shown by default with the focus; cancelled, none', () => {
    const q = save(k, {
      voucherTypeId: vt.quotation,
      date: t.today,
      mode: 'accounting_invoice',
      partyLedgerId: L.acme,
      ledgers: [{ ledgerId: L.consult, amount: 1000000, narration: 'Design review\r\nweeks 1-2' }],
    });
    const d = getVoucher(t.db, q.id);
    assert.deepEqual([d.entries.length, d.inventory.length, d.totals.amount], [0, 0, 1180000], 'priced with GST, posts nothing');
    assert.deepEqual(viewSections(d, false), { entries: false, lines: true, gst: false, totals: false, focus: 'lines' });
    assert.deepEqual(viewSections(d, true).lines, true);
    assert.deepEqual(viewLineRows(d, named), [{ key: '0', ledgerId: L.consult, name: 'Consultancy Income', description: 'Design review\nweeks 1-2', amount: 1000000 }]);

    cancelVoucher(t.ctx, q.id, 'Customer declined');
    const c = getVoucher(t.db, q.id);
    assert.equal(c.isCancelled, true);
    assert.equal(c.input.ledgers?.length, 1, 'the voucher as entered keeps its lines');
    assert.deepEqual(viewLineRows(c, named), []);
    assert.deepEqual(viewLineLedgerIds(c), []);
    assert.deepEqual(viewSections(c, true), { entries: false, lines: false, gst: false, totals: false, focus: null });
  });

  it('a posted invoice shows its ledger entries (with the line description) as before, never its lines as entered', () => {
    const inv = save(k, {
      voucherTypeId: vt.sales,
      date: t.today,
      mode: 'item_invoice',
      partyLedgerId: L.acme,
      items: [{ itemId: I.mixer, qty: 2, rate: 200 }],
      ledgers: [{ ledgerId: L.discount, amount: -1000, narration: 'Festival offer' }],
    });
    const d = getVoucher(t.db, inv.id);
    assert.ok(d.entries.length > 0);
    assert.deepEqual(viewLineRows(d, named), []);
    assert.deepEqual(viewLineLedgerIds(d), []);
    assert.deepEqual(viewSections(d, false), { entries: false, lines: false, gst: false, totals: true, focus: 'items' });
    assert.deepEqual(viewSections(d, true), { entries: true, lines: false, gst: true, totals: true, focus: 'items' });
    const discount = viewEntryRows(d.entries, INSTRUMENTS).find((r) => r.name === 'Discount Allowed');
    assert.deepEqual([discount?.description, discount?.debit], ['Festival offer', 1000]);
  });
});
