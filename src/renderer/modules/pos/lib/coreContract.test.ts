/**
 * Contract test (2.2): altering a POS bill at the counter keeps the description a line was given in
 * voucher entry — the counter's pure model driven against the REAL engine on an in-memory POS company
 * (src/core/modules/pos testkit). The counter's path: vouchers.get().input.items → `linesFromBill` (each
 * item looked up again, as pos.item.get does) → `buildBillInput` → vouchers.save. Inputs are checked by
 * the routes' own schemas in strict mode (unknown keys rejected, as in development builds and tests), so
 * a held bill's draft — which has no place for a description — must never carry one.
 *
 * Test-only: this file imports core services at runtime. Renderer source files never do.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { parse } from '../../../../core/lib/validate.ts';
import { loadPosItem } from '../../../../core/modules/pos/lookup.ts';
import { HeldSaveSchema } from '../../../../core/modules/pos/schemas.ts';
import { bill, line, posKit, saveBill, tender } from '../../../../core/modules/pos/testkit.ts';
import { getVoucher } from '../../../../core/modules/vouchers/queries.ts';
import { VoucherInputSchema } from '../../../../core/modules/vouchers/routes.ts';
import { previewVoucher } from '../../../../core/modules/vouchers/service.ts';
import type { PosItem } from '../../../../shared/types/pos.ts';
import type { VoucherInput } from '../../../../shared/types/vouchers.ts';
import { buildBillInput, linesFromBill, toDraft } from './cart.ts';

const k = posKit();
after(() => k.t.close());
const { t, I, M, L } = k;

/** What vouchers.save receives through its route (trimmed, unknown keys rejected). */
const routed = (input: VoucherInput): VoucherInput => parse(VoucherInputSchema, input, { unknownKeys: 'reject' });

describe('altering a POS bill at the counter (real engine)', () => {
  it("keeps a line's description from voucher entry; holding the bill never sends one", () => {
    // A walk-in POS bill whose soap line was given a description in voucher entry (e.g. a duplicated bill).
    const items = [line(I.soap, 2, 42.37, { description: '  Gift wrapped,\nred ribbon  ' }), line(I.pen, 1, 10)];
    const total = previewVoucher(t.ctx, bill(k, items, { tenders: [] })).totals.grandTotal;
    const saved = saveBill(k, routed(bill(k, items, { tenders: [tender(M.cash, total)] })));
    const detail = getVoucher(t.db, saved.id);

    // Alt+A on the bill: its lines come back on the counter with their items looked up again.
    const found = new Map<number, PosItem>();
    for (const i of detail.input.items ?? []) {
      const item = loadPosItem(t.db, i.itemId, 'name', { date: detail.date, today: t.today });
      if (item) found.set(i.itemId, item);
    }
    const back = linesFromBill(detail.input.items ?? [], found);
    assert.deepEqual(back.missing, []);
    assert.deepEqual(back.lines.map((l) => l.description), ['Gift wrapped,\nred ribbon', undefined]);

    // Saved again from the counter (the paid block as the payment dialog starts from it).
    const header = { voucherTypeId: detail.voucherType.id, date: detail.date, partyLedgerId: L.cash, placeOfSupply: detail.placeOfSupply, priceLevelId: null, godownId: null, id: detail.id, expectedUpdatedAt: detail.updatedAt };
    const altered = getVoucher(t.db, saveBill(k, routed(buildBillInput(header, back.lines, detail.input.posBill ?? { tenders: [] }))).id);
    assert.equal(altered.totals.amount, total, 'the bill itself is unchanged');
    assert.deepEqual(altered.input.items?.map((i) => i.description), ['Gift wrapped,\nred ribbon', undefined]);
    assert.deepEqual(
      t.db.all<{ description: string | null }>('SELECT description FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no', { id: detail.id }),
      [{ description: 'Gift wrapped,\nred ribbon' }, { description: null }],
    );

    // Hold (Alt+O) sends only what a held draft holds: the strict held-bill schema accepts it.
    const draft = toDraft(detail.voucherType.id, back.lines, null, detail.placeOfSupply);
    assert.doesNotThrow(() => parse(HeldSaveSchema, { total, draft }, { unknownKeys: 'reject' }));
    assert.throws(() => parse(HeldSaveSchema, { total, draft: { ...draft, lines: [{ ...draft.lines[0], description: 'x' }] } }, { unknownKeys: 'reject' }), /Unknown field "description"/);
  });
});
