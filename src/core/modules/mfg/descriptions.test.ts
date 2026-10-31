/**
 * 2.2 line descriptions on the classed stock journals (Manufacturing Journal, Material In / Out). The text under
 * a line — `stockJournal.lines[].description` → inventory_entries.description, never the stock item master's
 * description — comes back from mfg.journal.get / mfg.journal.duplicate, so altering or duplicating a journal
 * on the mfg screen sends it again. A journal saved without its block (an import, or entered on the plain stock
 * journal grid) is read back from its item lines: each line keeps its description there too.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadVoucherRow } from '../vouchers/service.ts';
import { duplicateJournal, getJournal } from './journalQueries.ts';
import { mfgKit, post, type MfgKit } from './testkit.ts';

/** inventory_entries.description of a voucher, in line order. */
const stored = (k: MfgKit, id: number): Array<string | null> =>
  k.t.db.all<{ description: string | null }>('SELECT description FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no', { id }).map((r) => r.description);

describe('mfg (2.2) — line descriptions of a classed journal', () => {
  test('saved through its block: get and duplicate return each line’s description (none where it had none)', () => {
    const k = mfgKit();
    const { t, I, VT } = k;
    const saved = post(k, {
      voucherTypeId: VT.manufacturing,
      date: '2026-06-10',
      mode: 'inventory',
      stockJournal: {
        lines: [
          { role: 'product', itemId: I.chair, qty: 1, description: 'Batch for Jun 2026' },
          { role: 'component', itemId: I.steel, qty: 5, description: 'Steel lot 7\nheat 42' },
          { role: 'component', itemId: I.paint, qty: 1 },
        ],
      },
    });
    const texts = ['Batch for Jun 2026', 'Steel lot 7\nheat 42', null];
    assert.deepEqual(stored(k, saved.id), texts);
    assert.deepEqual(getJournal(t.ctx, saved.id).block.lines.map((l) => l.description ?? null), texts);
    assert.deepEqual(duplicateJournal(t.ctx, saved.id).block.lines.map((l) => l.description ?? null), texts);
    t.close();
  });

  test('saved without its block: the block rebuilt from the item lines keeps the descriptions, and an alteration through it too', () => {
    const k = mfgKit();
    const { t, I, VT } = k;
    // A Manufacturing Journal as an import (or the plain stock journal grid) saves it: item lines, no block.
    const plain = post(k, {
      voucherTypeId: VT.manufacturing,
      date: '2026-06-13',
      mode: 'inventory',
      items: [
        { itemId: I.steel, qty: 2, rate: 0, isConsumption: true, description: 'Imported out text' },
        { itemId: I.paint, qty: 1, rate: 0, isConsumption: true },
        { itemId: I.chair, qty: 1, rate: 0, description: 'Imported in text' },
      ],
    });
    const texts = ['Imported out text', null, 'Imported in text'];
    assert.deepEqual(stored(k, plain.id), texts);
    const rebuilt = getJournal(t.ctx, plain.id);
    assert.deepEqual(rebuilt.block.lines.map((l) => [l.role, l.description ?? null]), [
      ['component', 'Imported out text'],
      ['component', null],
      ['product', 'Imported in text'],
    ]);
    assert.deepEqual(duplicateJournal(t.ctx, plain.id).block.lines.map((l) => l.description ?? null), texts);

    // Altered on the mfg screen: the rebuilt block goes back through vouchers.save — the texts stay.
    post(k, { voucherTypeId: VT.manufacturing, id: plain.id, date: rebuilt.date, mode: 'inventory', narration: 'altered', stockJournal: rebuilt.block });
    assert.deepEqual(stored(k, plain.id), texts);

    // A voucher with no stored input at all (older data): read back from inventory_entries, same result.
    t.db.run('UPDATE vouchers SET meta = NULL WHERE id = :id', { id: plain.id });
    assert.ok(loadVoucherRow(t.db, plain.id));
    assert.deepEqual(getJournal(t.ctx, plain.id).block.lines.map((l) => l.description ?? null), texts);
    t.close();
  });
});
