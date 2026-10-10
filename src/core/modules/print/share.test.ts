/**
 * (print group) Sharing through the route dispatcher: recipient and texts from the party ledger and the
 * F12 templates, statements, permissions, and the 'export' edit-log entry.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ShareContext } from '../../../shared/types/print.ts';
import { routes } from '../../api/routes.ts';
import { save, setupKit } from '../vouchers/testkit.ts';

const DATE = '2026-04-15';

function kit() {
  const k = setupKit();
  k.t.db.run("UPDATE ledgers SET email = 'accounts@acme.example', mobile = '9876543210', address = '12, MG Road, Pune' WHERE id = :id", { id: k.L.acme });
  const id = save(k, {
    voucherTypeId: k.vt.sales,
    date: DATE,
    mode: 'item_invoice',
    partyLedgerId: k.L.acme,
    items: [{ itemId: k.I.rice, qty: 10, rate: 50 }],
  }).id;
  return { k, id };
}

describe('print.share.*', () => {
  it('context: party e-mail / mobile and the default texts filled in', async () => {
    const { k, id } = kit();
    const c = await k.t.callOk<ShareContext>(routes, 'print.share.context', { voucherId: id });
    const number = k.t.db.value<string>('SELECT number FROM vouchers WHERE id = :id', { id }) ?? '';
    // 10 × 50.00 = 500.00 + 5% (12.50 + 12.50) = 525.00
    assert.equal(c.kind, 'voucher');
    assert.equal(c.email, 'accounts@acme.example');
    assert.equal(c.mobile, '9876543210');
    assert.equal(c.label, `Tax Invoice ${number}`);
    assert.match(c.subject, new RegExp(`^Tax Invoice ${number} dated 15-Apr-2026 — `));
    assert.match(c.body, /Please find attached Tax Invoice .* for ₹ 525\.00\./);
    assert.match(c.whatsappText, /^Dear .*, please find Tax Invoice .* for ₹ 525\.00 from /);
    assert.ok(c.fileName.startsWith(`Tax Invoice ${number.replace(/\//g, '-')}`));
  });

  it('uses the edited templates (F12 › Sharing)', async () => {
    const { k, id } = kit();
    await k.t.callOk(routes, 'company.config.save', { share: { emailSubject: 'Bill {number} / {amount}', whatsappText: 'Hi {party}' } });
    const c = await k.t.callOk<ShareContext>(routes, 'print.share.context', { voucherId: id });
    assert.match(c.subject, /^Bill .* \/ 525\.00$/);
    assert.match(c.whatsappText, /^Hi /);
    const bad = await k.t.call(routes, 'company.config.save', { share: { emailSubject: 'two\nlines' } });
    assert.equal(bad.ok, false);
  });

  it('statement of account: balance and period', async () => {
    const { k } = kit();
    const c = await k.t.callOk<ShareContext>(routes, 'print.share.context', { statement: { ledgerId: k.L.acme, from: '2026-04-01', to: '2026-04-30' } });
    assert.equal(c.kind, 'statement');
    assert.match(c.label, /^Statement of Account — /);
    assert.match(c.body, /Statement of Account dated 30-Apr-2026 for ₹ 525\.00 Dr\./);
    const both = await k.t.call(routes, 'print.share.context', { voucherId: 1, statement: { ledgerId: k.L.acme, from: '2026-04-01', to: '2026-04-30' } });
    assert.equal(both.ok, false);
    const neither = await k.t.call(routes, 'print.share.context', {});
    assert.equal(neither.ok, false);
  });

  it('log: writes an export entry; needs data.export (and vouchers.view)', async () => {
    const { k, id } = kit();
    await k.t.callOk(routes, 'print.share.log', { voucherId: id, channel: 'whatsapp', to: '9876543210', fileName: 'Tax Invoice 1.pdf' });
    const row = k.t.db.get<{ action: string; entity_type: string; entity_id: number; entity_label: string; after_json: string | null }>(
      "SELECT action, entity_type, entity_id, entity_label, after_json FROM audit_log WHERE action = 'export' ORDER BY id DESC LIMIT 1",
    );
    assert.ok(row);
    assert.equal(row.entity_type, 'voucher');
    assert.equal(row.entity_id, id);
    assert.match(row.entity_label, /shared by WhatsApp$/);

    const noExport = k.t.sessionAs({ permissions: ['vouchers.view'] });
    const denied = await k.t.call(routes, 'print.share.log', { voucherId: id, channel: 'email', fileName: 'x.pdf' }, { session: noExport });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN');
    const noVouchers = k.t.sessionAs({ permissions: ['data.export'] });
    const denied2 = await k.t.call(routes, 'print.share.context', { voucherId: id }, { session: noVouchers });
    assert.equal(denied2.ok, false);
  });
});
