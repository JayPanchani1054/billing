/**
 * 'gst.einvoice.generated': documents with an active IRN, so an IRN cancelled on the IRP can be marked
 * cancelled here — also for vouchers that are still in the books — with the 24-hour IRP window.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gstRoutes } from './routes.ts';
import { generatedEinvoices, irnCancellableUntil, markIrnCancelled } from './einvoice.ts';
import { insertDoc, setupParties } from './testkit.ts';

const line = { hsn: '8471', rate: 18, taxable: 100_000, igst: 18_000 }; // 1,000.00 @18% IGST 180.00 → 1,180.00

describe('e-invoice: generated IRNs', () => {
  it('irnCancellableUntil adds 24 hours to the IST acknowledgement time', () => {
    // 05-May-2026 10:15 IST = 04:45 UTC; +24 h = 06-May 04:45 UTC.
    assert.equal(irnCancellableUntil('2026-05-05 10:15:00'), '2026-05-06T04:45:00.000Z');
    // A bare date counts as midnight IST (= 18:30 UTC the day before).
    assert.equal(irnCancellableUntil('2026-05-05'), '2026-05-05T18:30:00.000Z');
    assert.equal(irnCancellableUntil(null), null);
    assert.equal(irnCancellableUntil('05/05/2026 10:15'), null);
  });

  it('lists active IRNs in the range (books or cancelled), not pending or already cancelled ones', () => {
    // Clock: 10-May-2026 10:00 IST (04:30 UTC).
    const { t, P } = setupParties({ today: '2026-05-10' });
    const fresh = insertDoc(t, { type: 'sales', number: 'E1', date: '2026-05-09', party: P.bharat, nature: 'b2b', pos: '29', lines: [line], irn: 'a'.repeat(64), irnStatus: 'generated', irnAckDate: '2026-05-09 18:00:00' });
    const old = insertDoc(t, { type: 'sales', number: 'E2', date: '2026-05-02', party: P.bharat, nature: 'b2b', pos: '29', lines: [line], irn: 'b'.repeat(64), irnStatus: 'generated', irnAckDate: '2026-05-02 11:00:00' });
    const cancelledBooks = insertDoc(t, { type: 'sales', number: 'E3', date: '2026-05-08', party: P.bharat, nature: 'b2b', pos: '29', lines: [line], cancelled: true, irn: 'c'.repeat(64), irnStatus: 'generated', irnAckDate: '2026-05-08 09:00:00' });
    insertDoc(t, { type: 'sales', number: 'E4', date: '2026-05-08', party: P.bharat, nature: 'b2b', pos: '29', lines: [line], irnStatus: 'pending' });
    insertDoc(t, { type: 'sales', number: 'E5', date: '2026-05-08', party: P.bharat, nature: 'b2b', pos: '29', lines: [line], irn: 'd'.repeat(64), irnStatus: 'cancelled', irnAckDate: '2026-05-08 09:00:00' });
    insertDoc(t, { type: 'sales', number: 'E6', date: '2026-04-30', party: P.bharat, nature: 'b2b', pos: '29', lines: [line], irn: 'e'.repeat(64), irnStatus: 'generated' });

    const r = generatedEinvoices(t.db, '2026-05-01', '2026-05-31', t.clock.now());
    assert.deepEqual(
      r.rows.map((x) => [x.number, x.cancelledInBooks, x.cancelWindowOpen]),
      [
        ['E2', false, false], // acked 02-May 11:00 IST: window closed 03-May
        ['E3', true, false], // acked 08-May 09:00 IST: closed 09-May 09:00 IST
        ['E1', false, true], // acked 09-May 18:00 IST: open until 10-May 18:00 IST (now 10:00 IST)
      ],
    );
    const e1 = r.rows.find((x) => x.voucherId === fresh);
    assert.ok(e1);
    assert.equal(e1.docType, 'INV');
    assert.equal(e1.invoiceValue, 118_000);
    assert.equal(e1.cancellableUntil, '2026-05-10T12:30:00.000Z');
    assert.ok(r.rows.some((x) => x.voucherId === old));
    assert.ok(r.rows.some((x) => x.voucherId === cancelledBooks));

    // Once marked cancelled it drops out of the list.
    t.db.transaction(() => markIrnCancelled(t.ctx, fresh, 'Data entry mistake'));
    assert.equal(generatedEinvoices(t.db, '2026-05-01', '2026-05-31', t.clock.now()).rows.length, 2);
    t.close();
  });

  it('route needs gst.view and a range', async () => {
    const { t, P } = setupParties({ today: '2026-05-10' });
    insertDoc(t, { type: 'sales', number: 'E1', date: '2026-05-09', party: P.bharat, nature: 'b2b', pos: '29', lines: [line], irn: 'a'.repeat(64), irnStatus: 'generated', irnAckDate: '2026-05-09 18:00:00' });
    const ok = await t.call(gstRoutes, 'gst.einvoice.generated', { from: '2026-05-01', to: '2026-05-31' });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal((ok.data as { rows: unknown[] }).rows.length, 1);
    const bad = await t.call(gstRoutes, 'gst.einvoice.generated', { from: '2026-05-31', to: '2026-05-01' });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.code, 'VALIDATION');
    const noGst = await t.call(gstRoutes, 'gst.einvoice.generated', { from: '2026-05-01', to: '2026-05-31' }, { session: t.sessionAs({ permissions: ['reports.view'] }) });
    assert.equal(noGst.ok, false);
    if (!noGst.ok) assert.equal(noGst.error.code, 'FORBIDDEN');
    t.close();
  });
});
