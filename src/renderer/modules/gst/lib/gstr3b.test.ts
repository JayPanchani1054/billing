import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Gstr3bSummary, SetOffResult, TaxAmounts, TaxHead } from '../../../../shared/types/gst-returns.ts';
import {
  ADJUSTMENT_FIELDS,
  changedCellCount,
  creditMayPay,
  diffAdjustments,
  draftFrom,
  emptyDraft,
  gstr3bExport,
  interStateTable,
  isDraftDirty,
  paymentCashTotal,
  paymentSections,
  setDraftCell,
  setOffLines,
  setOffSentence,
} from './gstr3b.ts';

const z = (): TaxAmounts => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });

describe('GSTR-3B manual entries (dirty diffing)', () => {
  it('lists every adjustment key once; late fee only under CGST and SGST', () => {
    assert.equal(new Set(ADJUSTMENT_FIELDS.map((f) => f.key)).size, 8);
    assert.deepEqual(ADJUSTMENT_FIELDS.find((f) => f.key === 'lateFee')?.heads, ['cgst', 'sgst']);
  });

  it('a fresh draft equals what is saved, so nothing is dirty', () => {
    const saved = emptyDraft();
    saved.interest.igst = 12_500; // ₹125.00
    const d = draftFrom(saved);
    assert.notEqual(d, saved);
    assert.notEqual(d.interest, saved.interest);
    assert.equal(isDraftDirty(saved, d), false);
    assert.deepEqual(diffAdjustments(saved, d), {});
  });

  it('sends only the changed heads, including a value cleared back to zero', () => {
    const saved = emptyDraft();
    saved.interest.igst = 12_500;
    saved.creditLedgerBalance.cgst = 100_000;
    let d = draftFrom(saved);
    d = setDraftCell(d, 'interest', 'igst', null); // cleared → 0
    d = setDraftCell(d, 'itcIsd', 'cgst', 45_000); // ₹450.00 ISD credit
    d = setDraftCell(d, 'itcIsd', 'sgst', 45_000);
    d = setDraftCell(d, 'creditLedgerBalance', 'cgst', 100_000); // unchanged
    assert.deepEqual(diffAdjustments(saved, d), { interest: { igst: 0 }, itcIsd: { cgst: 45_000, sgst: 45_000 } });
    assert.equal(changedCellCount(saved, d), 3);
    assert.equal(isDraftDirty(saved, d), true);
  });

  it('keeps the same draft object when a cell does not change; rejects negatives', () => {
    const d = emptyDraft();
    assert.equal(setDraftCell(d, 'lateFee', 'cgst', 0), d);
    assert.equal(setDraftCell(d, 'lateFee', 'cgst', -500).lateFee.cgst, 0);
    assert.equal(setDraftCell(d, 'lateFee', 'cgst', 2_000.4).lateFee.cgst, 2_000);
  });

  it('treats missing saved entries as zero', () => {
    const d = setDraftCell(emptyDraft(), 'itcReversalOthers', 'igst', 1);
    assert.deepEqual(diffAdjustments(undefined, d), { itcReversalOthers: { igst: 1 } });
    assert.equal(isDraftDirty({}, emptyDraft()), false);
  });
});

describe('GSTR-3B 6.1 set-off explanation', () => {
  // README example: liability I 0 / C 500 / S 500; credit I 600 / C 500 / S 0 (rupees → paise ×100).
  // IGST credit pays SGST 500 (the shortfall) then CGST 100; CGST credit pays CGST 400 → 100 carried forward.
  const util = (): Record<TaxHead, Record<TaxHead, number>> => ({ igst: z(), cgst: z(), sgst: z(), cess: z() });
  const u = util();
  u.igst.sgst = 50_000;
  u.igst.cgst = 10_000;
  u.cgst.cgst = 40_000;
  const setOff: SetOffResult = {
    utilisation: u,
    paidByItc: { igst: 0, cgst: 50_000, sgst: 50_000, cess: 0 },
    cash: z(),
    creditBalance: { igst: 0, cgst: 10_000, sgst: 0, cess: 0 },
  };
  const available = { igst: 60_000, cgst: 50_000, sgst: 0, cess: 0 };

  it('lists what each credit paid and what is carried forward', () => {
    const lines = setOffLines(setOff, available);
    assert.deepEqual(
      lines.map((l) => [l.credit, l.available, l.uses.map((x) => `${x.against}:${x.amount}`), l.used, l.carriedForward]),
      [
        ['igst', 60_000, ['cgst:10000', 'sgst:50000'], 60_000, 0],
        ['cgst', 50_000, ['cgst:40000'], 40_000, 10_000],
        ['sgst', 0, [], 0, 0],
        ['cess', 0, [], 0, 0],
      ],
    );
    assert.equal(setOffSentence(lines[0]), 'IGST credit ₹ 600.00: ₹ 100.00 paid CGST, ₹ 500.00 paid SGST/UTGST · nothing left.');
    assert.equal(setOffSentence(lines[1]), 'CGST credit ₹ 500.00: ₹ 400.00 paid CGST · ₹ 100.00 carried forward.');
    assert.equal(setOffSentence(lines[2]), 'SGST/UTGST credit ₹ 0.00: none available.');
  });

  it('knows which credit may pay which tax (s.49(5))', () => {
    assert.equal(creditMayPay('igst', 'sgst'), true);
    assert.equal(creditMayPay('cgst', 'igst'), true);
    assert.equal(creditMayPay('cgst', 'sgst'), false);
    assert.equal(creditMayPay('sgst', 'cgst'), false);
    assert.equal(creditMayPay('igst', 'cess'), false);
    assert.equal(creditMayPay('cess', 'cess'), true);
  });
});

const emptySetOff: SetOffResult = {
  utilisation: { igst: z(), cgst: z(), sgst: z(), cess: z() },
  paidByItc: z(),
  cash: z(),
  creditBalance: z(),
};

describe('GSTR-3B tables', () => {
  it('merges 3.2 categories by place of supply', () => {
    const rows = interStateTable({
      unregistered: [
        { pos: '29', posName: 'Karnataka', taxable: 100_000, igst: 18_000 },
        { pos: '07', posName: 'Delhi', taxable: 50_000, igst: 9_000 },
      ],
      composition: [{ pos: '29', posName: 'Karnataka', taxable: 60_000, igst: 10_800 }],
      uin: [],
    });
    assert.deepEqual(
      rows.map((r) => [r.pos, r.unregistered.taxable, r.composition.taxable, r.uin.taxable]),
      [
        ['07', 50_000, 0, 0],
        ['29', 100_000, 60_000, 0],
      ],
    );
  });

  it('exports the whole form with the cash total', () => {
    const tv = (taxable: number, igst = 0) => ({ taxable, igst, cgst: 0, sgst: 0, cess: 0 });
    const s = {
      period: { key: '042026', kind: 'month', label: 'Apr 2026', from: '2026-04-01', to: '2026-04-30', fp: '042026' },
      gstin: null,
      companyName: 'Test Co',
      supplies: [{ key: 'osup_det', row: '3.1(a)', label: 'Outward taxable supplies', ...tv(100_000, 18_000) }],
      eco: [],
      interState: { unregistered: [], composition: [], uin: [] },
      itc: { available: [], reversed: [], net: z(), ineligible: [], blocked: z() },
      inward: [{ ty: 'GST', label: 'Exempt / nil / composition', inter: 5_000, intra: 7_000 }],
      interest: z(),
      lateFee: z(),
      payment: {
        rows: [{ head: 'igst', label: 'IGST', liability: 18_000, paidIgst: 0, paidCgst: 0, paidSgst: 0, paidCess: 0, cash: 18_000, rcmLiability: 0, interest: 0, lateFee: 0, totalCash: 18_000 }],
        setOff: emptySetOff,
        creditAvailable: z(),
        itcUsed: z(),
        cashTotal: 18_000,
      },
      adjustments: emptyDraft(),
      adjustmentsUpdatedAt: null,
      notes: ['n1'],
      issueCount: { errors: 0, warnings: 0 },
    } as Gstr3bSummary;
    const e = gstr3bExport(s);
    assert.deepEqual(e.rows[0], ['3.1(a)', 'Outward taxable supplies', 100_000, 18_000, 0, 0, 0]);
    assert.ok(e.rows.some((r) => r[1] === 'Exempt / nil / composition — inter-state' && r[2] === 5_000));
    assert.ok(e.rows.some((r) => r[1] === 'Exempt / nil / composition — intra-state' && r[2] === 7_000));
    assert.deepEqual(e.totals, ['', 'Total cash to pay', 18_000, null, null, null, null]);
    for (const r of e.rows) assert.equal(r.length, e.columns.length);
  });
});

describe('GSTR-3B 6.1 as on the portal', () => {
  // Liability IGST 1,000 / CGST 500 / SGST 500 (rupees); credit IGST 600, CGST 300 → server says:
  // IGST row: paid by IGST credit 600, by CGST credit 300 → cash 100; CGST row: cash 500; SGST row: cash 500.
  // Reverse charge CGST 25 + SGST 25 in cash; interest CGST 10; late fee CGST 25 + SGST 25.
  // Cash = 100 + 500 + 500 + 25 + 25 + 10 + 25 + 25 = 1,210.00.
  const row = (head: 'igst' | 'cgst' | 'sgst' | 'cess', label: string, v: Partial<Record<string, number>>) => ({
    head,
    label,
    liability: 0,
    paidIgst: 0,
    paidCgst: 0,
    paidSgst: 0,
    paidCess: 0,
    cash: 0,
    rcmLiability: 0,
    interest: 0,
    lateFee: 0,
    totalCash: 0,
    ...v,
  });
  const payment = {
    rows: [
      row('igst', 'IGST', { liability: 100_000, paidIgst: 60_000, paidCgst: 30_000, cash: 10_000, totalCash: 10_000 }),
      row('cgst', 'CGST', { liability: 50_000, cash: 50_000, rcmLiability: 2_500, interest: 1_000, lateFee: 2_500, totalCash: 56_000 }),
      row('sgst', 'SGST/UTGST', { liability: 50_000, cash: 50_000, rcmLiability: 2_500, lateFee: 2_500, totalCash: 55_000 }),
      row('cess', 'Cess', {}),
    ],
    setOff: { utilisation: { igst: z(), cgst: z(), sgst: z(), cess: z() }, paidByItc: z(), cash: z(), creditBalance: z() },
    creditAvailable: z(),
    itcUsed: z(),
    cashTotal: 121_000,
  } as Gstr3bSummary['payment'];

  it('splits (A) other than reverse charge and (B) reverse charge; blanks cells the portal does not have', () => {
    const [a, b] = paymentSections(payment);
    assert.equal(a.id, 'A');
    assert.equal(b.id, 'B');
    const ig = a.lines[0];
    assert.deepEqual([ig.payable, ig.itc, ig.cash, ig.interest, ig.lateFee], [100_000, { igst: 60_000, cgst: 30_000, sgst: 0, cess: null }, 10_000, 0, null]);
    const cg = a.lines[1];
    // CGST may be paid by IGST and CGST credit only — never by SGST credit (s.49(5)).
    assert.deepEqual(cg.itc, { igst: 0, cgst: 0, sgst: null, cess: null });
    assert.equal(cg.lateFee, 2_500);
    assert.deepEqual(a.lines[3].itc, { igst: null, cgst: null, sgst: null, cess: 0 });
    assert.deepEqual(
      b.lines.map((l) => [l.head, l.payable, l.cash, l.itc.igst, l.interest, l.lateFee]),
      [
        ['igst', 0, 0, null, null, null],
        ['cgst', 2_500, 2_500, null, null, null],
        ['sgst', 2_500, 2_500, null, null, null],
        ['cess', 0, 0, null, null, null],
      ],
    );
  });

  it('cash across both parts equals the cash total from the server', () => {
    assert.equal(paymentCashTotal(paymentSections(payment)), payment.cashTotal);
  });

  it('a late fee under IGST (not expected) is still shown so the cash adds up', () => {
    const odd = { ...payment, rows: payment.rows.map((r) => (r.head === 'igst' ? { ...r, lateFee: 500, totalCash: r.totalCash + 500 } : r)), cashTotal: payment.cashTotal + 500 };
    const [a] = paymentSections(odd);
    assert.equal(a.lines[0].lateFee, 500);
    assert.equal(paymentCashTotal(paymentSections(odd)), odd.cashTotal);
  });
});
