/**
 * Contract test (2.2): altering or duplicating a Manufacturing Journal / Material In / Out on the mfg screen keeps
 * the description each line was given (`stockJournal.lines[].description` → inventory_entries.description). The
 * screen's own pure model (lib/journalForm.ts) is driven against the REAL engine on an in-memory company
 * (src/core/modules/mfg testkit), through the dispatcher as the screen calls it: mfg.journal.get /
 * mfg.journal.duplicate → `fromDetail` → `toVoucherInput` → vouchers.save (route schemas strict: unknown keys
 * rejected, as in development builds and tests).
 *
 * Test-only: this file imports core services at runtime. Renderer source files never do.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { routes } from '../../../../core/api/routes.ts';
import { mfgKit, post } from '../../../../core/modules/mfg/testkit.ts';
import type { BomDetail, MfgJournalDetail } from '../../../../shared/types/mfg.ts';
import type { VoucherInput, VoucherSaveResult } from '../../../../shared/types/vouchers.ts';
import { applyBom, emptyForm, fromDetail, sectionsFor, toVoucherInput, withTrailingBlanks } from './journalForm.ts';
import type { JournalForm, JournalRow } from './journalForm.ts';

const k = mfgKit();
after(() => k.t.close());
const { t, I, L, G, VT } = k;

/** inventory_entries.description of a voucher, in line order. */
const stored = (id: number): Array<string | null> =>
  t.db.all<{ description: string | null }>('SELECT description FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no', { id }).map((r) => r.description);

/** vouchers.save as the screen calls it (Ctrl+A; warnings acknowledged as "Save anyway" does). */
const save = (input: VoucherInput): Promise<VoucherSaveResult> => t.callOk<VoucherSaveResult>(routes, 'vouchers.save', { ...input, acknowledgeWarnings: true });

describe('the mfg journal screen against the real engine (2.2 line descriptions)', () => {
  it('Alt+A: a Manufacturing Journal altered on the screen keeps every line description', async () => {
    const src = post(k, {
      voucherTypeId: VT.manufacturing,
      date: '2026-06-10',
      mode: 'inventory',
      narration: 'first',
      stockJournal: {
        lines: [
          { role: 'product', itemId: I.chair, qty: 1, description: 'Batch for Jun 2026' },
          { role: 'component', itemId: I.steel, qty: 5, description: 'Steel lot 7\nheat 42' },
          { role: 'component', itemId: I.paint, qty: 1 },
        ],
      },
    });
    const texts = ['Batch for Jun 2026', 'Steel lot 7\nheat 42', null];
    assert.deepEqual(stored(src.id), texts);

    const d = await t.callOk<MfgJournalDetail>(routes, 'mfg.journal.get', { id: src.id });
    const form = fromDetail(d);
    const { input } = toVoucherInput({ ...form, narration: 'second' }, { id: d.id as number, updatedAt: d.updatedAt, number: d.number });
    await save(input);
    assert.deepEqual(stored(src.id), texts, 'the alteration (narration only) keeps them');
    assert.equal(t.db.value('SELECT narration FROM vouchers WHERE id = :id', { id: src.id }), 'second');
  });

  it('Alt+2: the duplicate of a Material Out keeps its line descriptions on the new voucher', async () => {
    const src = post(k, {
      voucherTypeId: VT.materialOut,
      date: '2026-06-11',
      mode: 'inventory',
      partyLedgerId: L.ravi,
      stockJournal: {
        thirdPartyGodownId: G.ravi,
        process: 'Machining',
        lines: [
          { role: 'transfer', itemId: I.steel, qty: 10, rate: 50, description: 'Cut to 2 m lengths' },
          { role: 'transfer', itemId: I.die, qty: 1, goodsType: 'tools' },
        ],
      },
    });
    // A transfer line is two stock lines (out of our godown, into the job worker's): both carry its text.
    const texts = ['Cut to 2 m lengths', 'Cut to 2 m lengths', null, null];
    assert.deepEqual(stored(src.id), texts);

    const dup = await t.callOk<MfgJournalDetail>(routes, 'mfg.journal.duplicate', { id: src.id });
    // The screen's copy: a new voucher dated as asked, numbered afresh.
    const { input } = toVoucherInput({ ...fromDetail(dup), date: '2026-06-12', number: '' });
    const res = await save(input);
    assert.notEqual(res.id, src.id);
    assert.deepEqual(stored(res.id), texts);
  });

  it('a journal saved without its block (an import) keeps its descriptions when altered on the screen', async () => {
    const plain = post(k, {
      voucherTypeId: VT.manufacturing,
      date: '2026-06-13',
      mode: 'inventory',
      items: [
        { itemId: I.steel, qty: 2, rate: 0, isConsumption: true, description: 'Imported out text' },
        { itemId: I.chair, qty: 1, rate: 0, description: 'Imported in text' },
      ],
    });
    const texts = ['Imported out text', 'Imported in text'];
    assert.deepEqual(stored(plain.id), texts);

    const d = await t.callOk<MfgJournalDetail>(routes, 'mfg.journal.get', { id: plain.id });
    const { input } = toVoucherInput({ ...fromDetail(d), narration: 'altered' }, { id: d.id as number, updatedAt: d.updatedAt, number: d.number });
    await save(input);
    assert.deepEqual(stored(plain.id), texts);
  });

  it('typed on the screen (Ctrl+E): kept through Alt+B, saved with each line, gone when emptied on alteration', async () => {
    const bom = await t.callOk<BomDetail>(routes, 'mfg.bom.save', {
      itemId: I.chair,
      name: 'Described',
      outputQty: 1,
      lines: [
        { kind: 'component', itemId: I.steel, qty: 5 },
        { kind: 'component', itemId: I.paint, qty: 0.5 },
        { kind: 'scrap', itemId: I.scrap, qty: 0.5, valueBasis: 'rate', valueRate: 20 },
      ],
    });
    const sections = sectionsFor('manufacturing', null);
    /** The screen's patch of a typed description (JournalEntryScreen › setDescription). */
    const typed = (f: JournalForm, role: JournalRow['role'], itemId: number, description: string): JournalForm => {
      const row = f.rows.find((r) => r.role === role && r.itemId === itemId);
      assert.ok(row, `${role} ${itemId}`);
      return { ...f, rows: f.rows.map((r) => (r.key === row.key ? { ...r, description } : r)) };
    };
    const textOf = (f: JournalForm, role: JournalRow['role'], itemId: number): string | undefined => f.rows.find((r) => r.role === role && r.itemId === itemId)?.description;

    // A new journal: 2 chairs, the BOM fills the lines (the screen's automatic fill), descriptions typed under three.
    let f = withTrailingBlanks(applyBom(emptyForm('manufacturing', VT.manufacturing, '2026-06-14'), bom, 2, null), sections);
    f = typed(f, 'product', I.chair, 'Order 77\nexport packing');
    f = typed(f, 'component', I.steel, 'Heat 42');
    f = typed(f, 'scrap', I.scrap, '  Offcuts  ');
    // Alt+B for 3 chairs: the component and scrap lines are rebuilt; their descriptions stay with their items.
    f = withTrailingBlanks(applyBom(f, bom, 3, null), sections);
    assert.equal(f.rows.find((r) => r.role === 'component' && r.itemId === I.steel)?.qty, 15);
    const res = await save(toVoucherInput(f).input);
    const all = (id: number) => stored(id).map((s) => s ?? '').sort();
    assert.deepEqual(all(res.id), ['', 'Heat 42', 'Offcuts', 'Order 77\nexport packing'], 'Paint has none; the scrap text is trimmed');

    // Alt+A: the screen shows them again (fromDetail) …
    const d = await t.callOk<MfgJournalDetail>(routes, 'mfg.journal.get', { id: res.id });
    const back = fromDetail(d);
    assert.deepEqual(
      [textOf(back, 'product', I.chair), textOf(back, 'component', I.steel), textOf(back, 'component', I.paint), textOf(back, 'scrap', I.scrap)],
      ['Order 77\nexport packing', 'Heat 42', '', 'Offcuts'],
    );
    // … and Steel's, emptied and saved, is gone; the others stay.
    await save(toVoucherInput(typed(back, 'component', I.steel, ''), { id: d.id as number, updatedAt: d.updatedAt, number: d.number }).input);
    assert.deepEqual(all(res.id), ['', '', 'Offcuts', 'Order 77\nexport packing']);
  });
});
