/**
 * Cheque layouts (presets, validation incl. the CTS-2010 MICR band, per-bank settings) and cheque
 * print data (payee, words, figures, date boxes, self cheques, warnings, records).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { saveBook } from './books.ts';
import { CHEQUE_PRESETS, deleteLayout, getBankSettings, layoutIssues, listLayouts, MICR_BAND_MM, saveBankSettings, saveLayout } from './layouts.ts';
import { amountFigures, chequePrintData, chequeWords, dateDigits, recordChequePrints } from './printData.ts';
import { chequeKit } from './testkit.ts';

const STD = CHEQUE_PRESETS[0].spec;

describe('cheque layouts', () => {
  it('presets are valid CTS-2010 leaves (202 × 92 mm) with nothing in the MICR band', () => {
    for (const p of CHEQUE_PRESETS) {
      assert.deepEqual(layoutIssues(p.spec), [], p.code);
      assert.deepEqual([p.spec.widthMm, p.spec.heightMm], [202, 92]);
    }
  });

  it('refuses positions in the MICR band, past the edge, and silly sizes', () => {
    const inBand = layoutIssues({ ...STD, signatory: { x: 140, y: 92 - MICR_BAND_MM + 1, w: 50 } });
    assert.match(inBand[0].message, /in the MICR band: move it up .*nothing below 76 mm/);
    assert.match(layoutIssues({ ...STD, payee: { x: 100, y: 20, w: 150 } })[0].message, /runs past the leaf's right edge/);
    assert.match(layoutIssues({ ...STD, date: { x: 170, y: 9, pitch: 5 } })[0].message, /eight date boxes run past/);
    assert.match(layoutIssues({ ...STD, widthMm: 400 })[0].message, /Leaf width must be 150–230 mm/);
    assert.match(layoutIssues({ ...STD, offsetX: 40 })[0].message, /at most 30 mm/);
  });

  it('saves layouts per bank; a layout in use cannot be deleted', () => {
    const k = chequeKit();
    const l = saveLayout(k.t.ctx, { name: 'HDFC leaves', preset: 'cts2010', spec: { ...STD, offsetX: 1.26, offsetY: -0.5 } });
    assert.equal(l.spec.offsetX, 1.3, 'rounded to 0.1 mm');
    assert.throws(() => saveLayout(k.t.ctx, { name: 'hdfc LEAVES', spec: STD }), /already exists/);
    assert.equal(getBankSettings(k.t.db, k.L.bank).acPayee, true, 'A/c Payee by default');
    const s = saveBankSettings(k.t.ctx, { bankLedgerId: k.L.bank, layoutId: l.id, signatory: 'Partner' });
    assert.deepEqual([s.layoutName, s.signatory], ['HDFC leaves', 'Partner']);
    assert.deepEqual(listLayouts(k.t.db)[0].usedBy, ['HDFC Bank']);
    assert.throws(() => deleteLayout(k.t.ctx, l.id), /is used for HDFC Bank/);
    saveBankSettings(k.t.ctx, { bankLedgerId: k.L.bank, layoutId: null });
    deleteLayout(k.t.ctx, l.id);
    assert.equal(listLayouts(k.t.db).length, 0);
  });
});

describe('cheque print data', () => {
  it('formats: date boxes, words (Indian system, Only — no repeated "Rupees"), figures with guards', () => {
    assert.equal(dateDigits('2026-04-05'), '05042026');
    assert.equal(chequeWords(1_23_456_78), 'One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only');
    assert.equal(chequeWords(1_00_00_000_00), 'One Crore Only');
    assert.equal(amountFigures(1_180_00), '**1,180.00/-');
    assert.equal(amountFigures(1_180_00, false), '**1,180/-');
    assert.equal(amountFigures(1_180_50, false), '**1,180.50/-');
    assert.equal(amountFigures(12_34_567_00), '**12,34,567.00/-');
  });

  it('payment: payee name on cheque, A/c Payee, cheque number and date; contra: Self, never crossed', () => {
    const k = chequeKit();
    saveBook(k.t.ctx, { bankLedgerId: k.L.bank, fromNo: 451, toNo: 460 });
    const p = k.pay({ amount: 1_180_00 });
    const c = k.withdraw({ amount: 25_000_00 });
    const d = chequePrintData(k.t.ctx, [p.id, c.id]);
    assert.deepEqual(d.skipped, []);
    const [pay, self] = d.cheques;
    assert.equal(pay.payee, 'Supreme Suppliers Private Limited');
    assert.deepEqual([pay.chequeNo, pay.chequeDate, pay.dateDigits, pay.amount], ['000451', '2026-04-15', '15042026', 1_180_00]);
    assert.equal(pay.amountWords, 'One Thousand One Hundred Eighty Only');
    assert.equal(pay.amountFigures, '**1,180.00/-');
    assert.equal(pay.acPayee, true);
    assert.equal(pay.signatory, 'Authorised Signatory');
    assert.equal(pay.layoutName, 'CTS-2010 standard leaf (preset)');
    assert.deepEqual([self.payee, self.self, self.acPayee, self.chequeNo], ['Self', true, false, '000452']);
  });

  it('favouring overrides the payee; skips vouchers without cheques; warns on stale / post-dated / reprints', () => {
    const k = chequeKit();
    const fav = k.pay({ amount: 500_00, chequeNo: '1', favouring: 'M/s Supreme Suppliers (Pune)' });
    const neft = k.pay({ amount: 500_00, type: 'neft' });
    const stale = k.pay({ amount: 500_00, chequeNo: '2', instrumentDate: '2025-12-31' });
    const pdc = k.pay({ amount: 500_00, chequeNo: '3', instrumentDate: '2026-05-01' });
    const none = k.pay({ amount: 500_00 }); // cheque without a number, no book
    const d = chequePrintData(k.t.ctx, [fav.id, neft.id, stale.id, pdc.id, none.id]);
    assert.equal(d.cheques.find((c) => c.voucherId === fav.id)?.payee, 'M/s Supreme Suppliers (Pune)');
    assert.deepEqual(d.skipped.map((s) => s.voucherId), [neft.id]);
    assert.match(d.skipped[0].reason, /No bank line of this voucher is paid by cheque/);
    assert.match(d.cheques.find((c) => c.voucherId === stale.id)?.warnings.join(' ') ?? '', /more than 3 months ago/);
    assert.match(d.cheques.find((c) => c.voucherId === pdc.id)?.warnings.join(' ') ?? '', /Post-dated cheque: dated 01-May-2026/);
    assert.match(d.cheques.find((c) => c.voucherId === none.id)?.warnings.join(' ') ?? '', /no cheque number/);
    recordChequePrints(k.t.ctx, { items: [{ voucherId: fav.id, lineNo: 2 }] });
    const again = chequePrintData(k.t.ctx, [fav.id]).cheques[0];
    assert.equal(again.printed.length, 1);
    assert.match(again.warnings.join(' '), /Already printed once/);
    const audit = k.t.db.get<{ entity_label: string }>("SELECT entity_label FROM audit_log WHERE action = 'export' AND entity_type = 'voucher' ORDER BY id DESC LIMIT 1");
    assert.match(audit?.entity_label ?? '', /^Cheque 1 printed — Payment/);
  });
});
